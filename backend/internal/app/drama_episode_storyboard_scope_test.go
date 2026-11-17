package app

import (
	"reflect"
	"testing"
	"time"

	"yingce/backend/internal/model"
)

func TestDramaStoryboardPreservesAutomaticEpisodeQueue(t *testing.T) {
	for _, test := range []struct {
		name             string
		selectedIndex    int
		selectedChapters []int
		selectedStage    string
		start            func(*Service, string, string, string) (DramaEpisodeDetail, error)
	}{
		{name: "rescript", selectedStage: model.DramaEpisodeQueued, start: (*Service).RescriptDramaEpisode},
		{name: "ensure", selectedIndex: 1, selectedChapters: []int{0}, selectedStage: model.DramaEpisodeDraft, start: (*Service).EnsureDramaEpisodeStoryboard},
	} {
		t.Run(test.name, func(t *testing.T) {
			svc, fake := newDramaTestService(t)
			summary, err := svc.CreateDrama("usr-drama", CreateDramaRequest{
				Name: "全剧自动制作", Start: true, SelectedChapters: test.selectedChapters,
				Settings: DramaSettings{EpisodeMode: DramaEpisodeModeChapter, ChaptersPerEpisode: 1, Models: fakeDramaModels},
				Chapters: []DramaChapterInput{{Title: "第一集", Text: "甲走进大厅。"}, {Title: "第二集", Text: "乙走上后山。"}},
			})
			if err != nil {
				t.Fatal(err)
			}
			if summary.Production.GuideStep != "" || len(summary.Episodes) != 2 {
				t.Fatalf("expected two episodes in automatic production, got guide step %q and %d episodes", summary.Production.GuideStep, len(summary.Episodes))
			}
			selected, sibling := summary.Episodes[test.selectedIndex], summary.Episodes[1-test.selectedIndex]
			if selected.Stage != test.selectedStage || sibling.Stage != model.DramaEpisodeQueued {
				t.Fatalf("unexpected stages before starting storyboard: selected=%s sibling=%s", selected.Stage, sibling.Stage)
			}
			projectID := summary.Project.ID
			if _, err := test.start(svc, "usr-drama", projectID, selected.ID); err != nil {
				t.Fatal(err)
			}
			runDramaTicks(t, svc, projectID, 20)
			if fake.byKind["script"] != 2 {
				t.Errorf("the selected episode and the previously queued episode must both dispatch scripts: %v", fake.byKind)
			}
			for _, episode := range summary.Episodes {
				detail, err := svc.DramaEpisodeDetail("usr-drama", projectID, episode.ID)
				if err != nil || len(detail.Shots) == 0 {
					t.Errorf("episode %d must have a storyboard after scheduling: stage=%s err=%v", episode.Number, detail.Episode.Stage, err)
				}
			}
		})
	}
}

func TestDramaStoryboardPreservesExplicitGuidedEpisodeQueue(t *testing.T) {
	for _, step := range []string{model.DramaGuideAssets, model.DramaGuideStory} {
		for _, source := range []string{"added-episode", "produced-chapter"} {
			t.Run(step+"/"+source, func(t *testing.T) {
				svc, fake, summary, chapters := dramaChapterProduceFixture(t, step)
				projectID, selectedID := summary.Project.ID, summary.Episodes[0].ID
				var queuedID string
				var nextRevision int64
				if source == "added-episode" {
					result, err := svc.AddDramaEpisode("usr-drama", projectID, AddDramaEpisodeRequest{ExpectedRevision: &summary.Production.Revision, Text: "甲登上山顶。"})
					if err != nil {
						t.Fatal(err)
					}
					queuedID = result.Episode.ID
					nextRevision = guideSummary(t, svc, projectID).Production.Revision
				} else {
					result, err := svc.ProduceDramaChapters("usr-drama", projectID, ProduceDramaChaptersRequest{ExpectedRevision: &summary.Production.Revision, ChapterIDs: []string{chapters[1].ID}})
					if err != nil || len(result.EpisodeIDs) != 1 {
						t.Fatalf("could not add reserved chapter: %+v %v", result, err)
					}
					queuedID, nextRevision = result.EpisodeIDs[0], result.Revision
				}
				queued, err := svc.repo.DramaEpisode(projectID, queuedID)
				if err != nil || queued.Stage != model.DramaEpisodeQueued {
					t.Fatalf("new request should be awaiting the scheduler: %+v %v", queued, err)
				}
				beforeScripts := fake.byKind["script"]
				if step == model.DramaGuideAssets {
					_, err = svc.ConfirmDramaGuide("usr-drama", projectID, ConfirmDramaGuideRequest{ExpectedStep: step, ExpectedRevision: nextRevision, EpisodeID: selectedID})
				} else {
					_, err = svc.RescriptDramaEpisode("usr-drama", projectID, selectedID)
				}
				if err != nil {
					t.Fatal(err)
				}
				runDramaTicks(t, svc, projectID, 20)
				if generated := fake.byKind["script"] - beforeScripts; generated != 2 {
					t.Errorf("both the selected episode and the explicitly queued sibling should dispatch scripts; got %d", generated)
				}
				detail, err := svc.DramaEpisodeDetail("usr-drama", projectID, queuedID)
				if err != nil || len(detail.Shots) == 0 {
					t.Fatalf("the earlier production request did not complete: stage=%s err=%v", detail.Episode.Stage, err)
				}
			})
		}
	}
}

func TestDramaRescriptEpisodeDoesNotStartLegacyQueuedEpisodes(t *testing.T) {
	for _, test := range []struct {
		name, status, imageStatus string
	}{
		{name: "paused", status: model.DramaStatusPaused},
		{name: "completed", status: model.DramaStatusCompleted},
		{name: "queued-image-source", status: model.DramaStatusPaused, imageStatus: model.DramaJobQueued},
		{name: "running-image-source", status: model.DramaStatusPaused, imageStatus: model.DramaJobRunning},
	} {
		t.Run(test.name, func(t *testing.T) {
			svc, fake := newDramaTestService(t)
			draft := createGuidedDrama(t, svc,
				DramaChapterInput{Title: "未选中旧集", Text: "甲走进大厅。"},
				DramaChapterInput{Title: "当前选中集", Text: "乙走上后山。"},
				DramaChapterInput{Title: "已单独请求的集", Text: "丙在屋内等待。"},
			)
			projectID := draft.Project.ID
			confirmGuide(t, svc, draft)
			runDramaTicks(t, svc, projectID, 6)
			episodes := guideSummary(t, svc, projectID).Episodes
			legacyID, selectedID, runningID := episodes[0].ID, episodes[1].ID, episodes[2].ID
			if err := svc.repo.UpdateDramaEpisodeUser(legacyID, map[string]any{"stage": model.DramaEpisodeQueued}); err != nil {
				t.Fatal(err)
			}
			if err := svc.repo.UpdateDramaEpisodeUser(runningID, map[string]any{"stage": model.DramaEpisodeScript}); err != nil {
				t.Fatal(err)
			}
			runningBefore, err := svc.repo.DramaEpisode(projectID, runningID)
			if err != nil {
				t.Fatal(err)
			}
			task := model.Task{ID: newID(), UserID: "usr-drama", Type: "canvas_text", Status: model.TaskStatusRunning}
			job := model.DramaJob{ID: newID(), ProjectID: projectID, EpisodeID: runningID, Kind: model.DramaJobScript, Status: model.DramaJobRunning, TaskID: task.ID, PayloadJSON: encodeDramaRevision(runningBefore.Revision), CreatedAt: time.Now()}
			for _, row := range []any{&task, &job} {
				if err := fake.db.Create(row).Error; err != nil {
					t.Fatal(err)
				}
			}
			var imageJob *model.DramaJob
			if test.imageStatus != "" {
				casts, err := svc.repo.DramaCasts(projectID)
				if err != nil || len(casts) == 0 {
					t.Fatalf("asset extraction must provide a media task owner: %v", err)
				}
				cast := casts[0]
				if err := fake.db.Model(&model.DramaCast{}).Where("id = ?", cast.ID).Updates(map[string]any{"image_status": test.imageStatus, "image_episode_id": legacyID}).Error; err != nil {
					t.Fatal(err)
				}
				imageJob = &model.DramaJob{ID: newID(), ProjectID: projectID, EpisodeID: legacyID, CastID: cast.ID, Kind: model.DramaJobCastImage, Status: test.imageStatus, PayloadJSON: encodeDramaRevision(cast.Revision), CreatedAt: time.Now()}
				if test.imageStatus == model.DramaJobRunning {
					imageTask := model.Task{ID: newID(), UserID: "usr-drama", Type: "canvas_image", Status: model.TaskStatusRunning}
					if err := fake.db.Create(&imageTask).Error; err != nil {
						t.Fatal(err)
					}
					imageJob.TaskID = imageTask.ID
				}
				if err := fake.db.Create(imageJob).Error; err != nil {
					t.Fatal(err)
				}
			}
			if err := svc.repo.UpdateDramaProduction(projectID, map[string]any{"guide_step": model.DramaGuideCompleted, "stage": model.DramaStageProduce, "status": test.status}); err != nil {
				t.Fatal(err)
			}
			if _, err := svc.RescriptDramaEpisode("usr-drama", projectID, selectedID); err != nil {
				t.Fatal(err)
			}
			if imageJob != nil {
				stored, err := svc.repo.DramaJob(projectID, imageJob.ID)
				if err != nil || stored.Status != imageJob.Status || stored.TaskID != imageJob.TaskID || stored.EpisodeID != legacyID || stored.Kind != model.DramaJobCastImage {
					t.Fatalf("media task episode scope does not imply storyboard intent, but its task must be retained: %+v %v", stored, err)
				}
			}
			runDramaTicks(t, svc, projectID, 20)
			if fake.byKind["script"] != 1 {
				t.Fatalf("rescripting one episode must submit exactly one new script task: %v", fake.byKind)
			}
			legacy, err := svc.repo.DramaEpisode(projectID, legacyID)
			if err != nil || legacy.Stage != model.DramaEpisodeDraft || legacy.ShotCount != 0 {
				t.Fatalf("legacy unrequested episode must remain unstarted: %+v %v", legacy, err)
			}
			selected, err := svc.DramaEpisodeDetail("usr-drama", projectID, selectedID)
			if err != nil || len(selected.Shots) == 0 {
				t.Fatalf("the selected episode must generate its storyboard: %+v %v", selected, err)
			}
			runningAfter, err := svc.repo.DramaEpisode(projectID, runningID)
			storedJob, jobErr := svc.repo.DramaJob(projectID, job.ID)
			if err != nil || jobErr != nil || !reflect.DeepEqual(runningBefore, runningAfter) || storedJob.Status != model.DramaJobRunning || storedJob.TaskID != task.ID {
				t.Fatalf("another explicitly running request must be preserved: before=%+v after=%+v job=%+v errors=%v/%v", runningBefore, runningAfter, storedJob, err, jobErr)
			}
			var unexpected int64
			if err := fake.db.Model(&model.DramaJob{}).Where("project_id = ? AND kind = ? AND episode_id = ?", projectID, model.DramaJobScript, legacyID).Count(&unexpected).Error; err != nil || unexpected != 0 {
				t.Fatalf("no script job may be created for the unselected legacy episode: count=%d err=%v", unexpected, err)
			}
		})
	}
}

func TestDramaEnsureEpisodeStoryboardDoesNotStartLegacyQueuedEpisodes(t *testing.T) {
	svc, fake := newDramaTestService(t)
	draft := createGuidedDrama(t, svc,
		DramaChapterInput{Title: "未选中旧集", Text: "甲走进大厅。"},
		DramaChapterInput{Title: "当前选中集", Text: "乙走上后山。"},
	)
	projectID := draft.Project.ID
	confirmGuide(t, svc, draft)
	runDramaTicks(t, svc, projectID, 6)
	episodes := guideSummary(t, svc, projectID).Episodes
	legacyID, selectedID := episodes[0].ID, episodes[1].ID
	if err := svc.repo.UpdateDramaEpisodeUser(legacyID, map[string]any{"stage": model.DramaEpisodeQueued}); err != nil {
		t.Fatal(err)
	}
	if err := svc.repo.UpdateDramaProduction(projectID, map[string]any{"guide_step": model.DramaGuideCompleted, "stage": model.DramaStageProduce, "status": model.DramaStatusPaused}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.EnsureDramaEpisodeStoryboard("usr-drama", projectID, selectedID); err != nil {
		t.Fatal(err)
	}
	runDramaTicks(t, svc, projectID, 20)
	legacy, err := svc.repo.DramaEpisode(projectID, legacyID)
	if err != nil || fake.byKind["script"] != 1 || legacy.Stage != model.DramaEpisodeDraft || legacy.ShotCount != 0 {
		t.Fatalf("opening one empty episode must not activate legacy queued siblings: legacy=%+v calls=%v err=%v", legacy, fake.byKind, err)
	}
}

func TestDramaRescriptEpisodeResumesPausedActiveGuide(t *testing.T) {
	fixture := newDramaGuideRevisionFixture(t, model.DramaGuideStory)
	svc := fixture.svc
	projectID, episodeID := fixture.summary.Project.ID, fixture.shot.EpisodeID
	if err := svc.repo.UpdateDramaProduction(projectID, map[string]any{"status": model.DramaStatusPaused, "stage": model.DramaStageProduce}); err != nil {
		t.Fatal(err)
	}
	before, err := svc.repo.DramaProduction(projectID)
	if err != nil {
		t.Fatal(err)
	}
	detail, err := svc.RescriptDramaEpisode("usr-drama", projectID, episodeID)
	if err != nil {
		t.Fatalf("paused guided rescript must resume without conflicting with its own revision update: %v", err)
	}
	after, err := svc.repo.DramaProduction(projectID)
	if err != nil || after.Status != model.DramaStatusRunning || after.GuideStep != model.DramaGuideStory || after.Revision != before.Revision+1 || detail.Episode.Stage != model.DramaEpisodeScript || len(detail.Shots) != 0 || len(detail.Segments) != 0 {
		t.Fatalf("resume and reset must commit once together: before=%+v after=%+v detail=%+v err=%v", before, after, detail, err)
	}
}

func TestDramaEnsureExistingStoryboardDoesNotDeferOtherEpisodes(t *testing.T) {
	svc, fake := newDramaTestService(t)
	draft := createGuidedDrama(t, svc,
		DramaChapterInput{Title: "已有分镜", Text: "甲走进大厅。"},
		DramaChapterInput{Title: "旧待制作集", Text: "乙走上后山。"},
	)
	projectID := draft.Project.ID
	selectedID, legacyID := draft.Episodes[0].ID, draft.Episodes[1].ID
	if err := fake.db.Create(&model.DramaShot{ID: newID(), ProjectID: projectID, EpisodeID: selectedID, Action: "保留的分镜"}).Error; err != nil {
		t.Fatal(err)
	}
	if err := fake.db.Create(&model.DramaSegment{ID: newID(), ProjectID: projectID, EpisodeID: selectedID}).Error; err != nil {
		t.Fatal(err)
	}
	if err := svc.repo.UpdateDramaEpisodeUser(legacyID, map[string]any{"stage": model.DramaEpisodeQueued}); err != nil {
		t.Fatal(err)
	}
	if err := svc.repo.UpdateDramaProduction(projectID, map[string]any{"guide_step": model.DramaGuideCompleted, "stage": model.DramaStageProduce, "status": model.DramaStatusPaused}); err != nil {
		t.Fatal(err)
	}
	legacyBefore, err := svc.repo.DramaEpisode(projectID, legacyID)
	if err != nil {
		t.Fatal(err)
	}
	productionBefore, err := svc.repo.DramaProduction(projectID)
	if err != nil {
		t.Fatal(err)
	}
	detail, err := svc.EnsureDramaEpisodeStoryboard("usr-drama", projectID, selectedID)
	if err != nil || len(detail.Shots) != 1 {
		t.Fatalf("opening an existing storyboard must only return its content: %+v %v", detail, err)
	}
	legacyAfter, err := svc.repo.DramaEpisode(projectID, legacyID)
	productionAfter, productionErr := svc.repo.DramaProduction(projectID)
	if err != nil || productionErr != nil || !reflect.DeepEqual(legacyBefore, legacyAfter) || !reflect.DeepEqual(productionBefore, productionAfter) || len(fake.requests) != 0 {
		t.Fatalf("a no-op ensure must not rewrite siblings or resume the production: legacy=%+v production=%+v errors=%v/%v", legacyAfter, productionAfter, err, productionErr)
	}
}
