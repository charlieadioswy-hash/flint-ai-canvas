package app

import (
	"reflect"
	"testing"
	"time"

	"yingce/backend/internal/model"
)

func TestDramaGuideStoryboardStartsOnlySelectedEpisode(t *testing.T) {
	for _, test := range []struct {
		name     string
		selected int
		legacy   bool
	}{{name: "default-first"}, {name: "selected-second", selected: 1}, {name: "legacy-queued", selected: 1, legacy: true}} {
		t.Run(test.name, func(t *testing.T) {
			selected := test.selected
			svc, fake := newDramaTestService(t)
			draft := createGuidedDrama(t, svc, DramaChapterInput{Title: "第一集", Text: "甲走进大厅。"}, DramaChapterInput{Title: "第二集", Text: "乙走上后山。"})
			for _, episode := range draft.Episodes {
				if episode.Stage != model.DramaEpisodeDraft {
					t.Fatalf("catalog must await individual requests: %+v", draft.Episodes)
				}
			}
			confirmGuide(t, svc, draft)
			runDramaTicks(t, svc, draft.Project.ID, 6)
			assets := guideSummary(t, svc, draft.Project.ID)
			if test.legacy {
				if err := fake.db.Model(&model.DramaEpisode{}).Where("project_id = ?", draft.Project.ID).UpdateColumn("stage", model.DramaEpisodeQueued).Error; err != nil {
					t.Fatal(err)
				}
			}
			req := ConfirmDramaGuideRequest{ExpectedStep: model.DramaGuideAssets, ExpectedRevision: assets.Production.Revision}
			if selected != 0 {
				req.EpisodeID = assets.Episodes[selected].ID
			}
			story, err := svc.ConfirmDramaGuide("usr-drama", draft.Project.ID, req)
			if err != nil {
				t.Fatal(err)
			}
			selectedID := story.Episodes[selected].ID
			before, _ := svc.repo.DramaEpisode(draft.Project.ID, selectedID)
			for range 3 {
				if _, err := svc.EnsureDramaEpisodeStoryboard("usr-drama", draft.Project.ID, selectedID); err != nil {
					t.Fatal(err)
				}
			}
			after, _ := svc.repo.DramaEpisode(draft.Project.ID, selectedID)
			if !reflect.DeepEqual(before, after) || len(fake.requests) != 1 {
				t.Fatalf("repeated ensure must leave queued intent unchanged: before=%+v after=%+v requests=%d", before, after, len(fake.requests))
			}
			runDramaTicks(t, svc, draft.Project.ID, 20)
			ready := guideSummary(t, svc, draft.Project.ID)
			if !ready.Guide.CanConfirm || fake.byKind["script"] != 1 {
				t.Fatalf("unstarted episodes cannot block the selected episode: guide=%+v kinds=%v", ready.Guide, fake.byKind)
			}
			for _, episode := range ready.Episodes {
				if episode.ID == selectedID {
					if episode.ShotCount == 0 {
						t.Fatalf("selected episode has no storyboard: %+v", episode)
					}
				} else if episode.Stage != model.DramaEpisodeDraft || episode.ShotCount != 0 {
					t.Fatalf("another episode started automatically: %+v", episode)
				}
			}
			detail, _ := svc.DramaEpisodeDetail("usr-drama", draft.Project.ID, selectedID)
			again, err := svc.EnsureDramaEpisodeStoryboard("usr-drama", draft.Project.ID, selectedID)
			if err != nil || !reflect.DeepEqual(detail, again) || fake.byKind["script"] != 1 {
				t.Fatalf("existing storyboard must remain unchanged: %+v %v", again, err)
			}
			confirmGuide(t, svc, ready)
		})
	}
}

func TestDramaGuideStoryboardRearrangesOnlySelectedExistingEpisode(t *testing.T) {
	for _, existing := range []string{"shots", "segments-only"} {
		t.Run(existing, func(t *testing.T) {
			svc, fake := newDramaTestService(t)
			draft := createGuidedDrama(t, svc, DramaChapterInput{Title: "第一集", Text: "甲走进大厅。"}, DramaChapterInput{Title: "第二集", Text: "乙走上后山。"})
			projectID := draft.Project.ID
			confirmGuide(t, svc, draft)
			runDramaTicks(t, svc, projectID, 6)
			assets := guideSummary(t, svc, projectID)
			for _, episode := range assets.Episodes {
				shot := model.DramaShot{ID: newID(), ProjectID: projectID, EpisodeID: episode.ID, Action: "保留的镜头内容", DurationMs: 3000}
				if existing == "shots" || episode.ID == assets.Episodes[0].ID {
					if err := fake.db.Create(&shot).Error; err != nil {
						t.Fatal(err)
					}
				}
				for _, row := range []any{
					&model.DramaSegment{ID: newID(), ProjectID: projectID, EpisodeID: episode.ID, VideoPromptOverride: "旧段提示词"},
					&model.DramaTake{ID: newID(), ProjectID: projectID, OwnerID: shot.ID, Kind: "shot_video", Version: 1, ResourceID: "existing-video"},
					&model.DramaJob{ID: episode.ID + "-queued-video", ProjectID: projectID, EpisodeID: episode.ID, Kind: model.DramaJobSegmentVideo, Status: model.DramaJobQueued},
				} {
					if err := fake.db.Create(row).Error; err != nil {
						t.Fatal(err)
					}
				}
				if err := svc.repo.UpdateDramaEpisodeUser(episode.ID, map[string]any{"stage": model.DramaEpisodeDone, "shot_count": 1, "approved": true, "final_resource_id": "existing-final"}); err != nil {
					t.Fatal(err)
				}
			}
			assets = guideSummary(t, svc, projectID)
			selectedID, otherID := assets.Episodes[1].ID, assets.Episodes[0].ID
			before, _ := svc.repo.DramaEpisode(projectID, selectedID)
			otherBefore, err := svc.DramaEpisodeDetail("usr-drama", projectID, otherID)
			if err != nil {
				t.Fatal(err)
			}
			requests := len(fake.requests)
			req := ConfirmDramaGuideRequest{ExpectedStep: model.DramaGuideAssets, ExpectedRevision: assets.Production.Revision, EpisodeID: selectedID}
			if _, err := svc.ConfirmDramaGuide("usr-drama", projectID, req); err != nil {
				t.Fatal(err)
			}
			after, err := svc.DramaEpisodeDetail("usr-drama", projectID, selectedID)
			if err != nil || after.Episode.Stage != model.DramaEpisodeScript || after.Episode.Revision != before.Revision+1 || after.Episode.ShotCount != 0 || after.Episode.Approved || len(after.Shots) != 0 || len(after.Segments) != 0 || after.Episode.FinalResourceID != before.FinalResourceID || !after.Episode.FinalStale {
				t.Fatalf("explicit arrangement must replace only the selected script while retaining its final version: %+v %v", after, err)
			}
			job, err := svc.repo.DramaJob(projectID, selectedID+"-queued-video")
			if err != nil || job.Status != model.DramaJobCanceled {
				t.Fatalf("old queued episode work must be cancelled: %+v %v", job, err)
			}
			otherAfter, err := svc.DramaEpisodeDetail("usr-drama", projectID, otherID)
			if err != nil || !reflect.DeepEqual(otherBefore, otherAfter) {
				t.Fatalf("another episode must retain all content and queued work: before=%+v after=%+v err=%v", otherBefore, otherAfter, err)
			}
			var takes int64
			if err := fake.db.Model(&model.DramaTake{}).Where("project_id = ?", projectID).Count(&takes).Error; err != nil || takes != 2 || len(fake.requests) != requests {
				t.Fatalf("arrangement only queues intent and preserves generated versions: takes=%d requests=%d err=%v", takes, len(fake.requests), err)
			}
			_, err = svc.ConfirmDramaGuide("usr-drama", projectID, req)
			requireGuideConflict(t, err)
			again, err := svc.EnsureDramaEpisodeStoryboard("usr-drama", projectID, selectedID)
			if err != nil || !reflect.DeepEqual(after, again) {
				t.Fatalf("navigation ensure must not restart the explicit request: %+v %v", again, err)
			}
		})
	}
}

func TestDramaGuideStoryboardRearrangementRejectsInvalidSourceAndActiveText(t *testing.T) {
	for _, blocked := range []string{"missing-source", "active-text"} {
		t.Run(blocked, func(t *testing.T) {
			svc, fake := newDramaTestService(t)
			draft := createGuidedDrama(t, svc, DramaChapterInput{Title: "第一集", Text: "甲走进大厅。"})
			projectID := draft.Project.ID
			confirmGuide(t, svc, draft)
			runDramaTicks(t, svc, projectID, 6)
			episodeID := guideSummary(t, svc, projectID).Episodes[0].ID
			shot := model.DramaShot{ID: newID(), ProjectID: projectID, EpisodeID: episodeID, Action: "原镜头", DurationMs: 3000}
			if err := fake.db.Create(&shot).Error; err != nil {
				t.Fatal(err)
			}
			if blocked == "missing-source" {
				if err := svc.repo.UpdateDramaEpisodeUser(episodeID, map[string]any{"chapter_ids_json": "[]"}); err != nil {
					t.Fatal(err)
				}
			} else if err := fake.db.Create(&model.DramaJob{ID: newID(), ProjectID: projectID, EpisodeID: episodeID, Kind: model.DramaJobScript, Status: model.DramaJobRunning}).Error; err != nil {
				t.Fatal(err)
			}
			assets := guideSummary(t, svc, projectID)
			before, _ := svc.DramaEpisodeDetail("usr-drama", projectID, episodeID)
			_, err := svc.ConfirmDramaGuide("usr-drama", projectID, ConfirmDramaGuideRequest{ExpectedStep: model.DramaGuideAssets, ExpectedRevision: assets.Production.Revision, EpisodeID: episodeID})
			if err == nil {
				t.Fatal("invalid source or active text must reject rearrangement")
			}
			after, _ := svc.DramaEpisodeDetail("usr-drama", projectID, episodeID)
			current, _ := svc.repo.DramaProduction(projectID)
			if !reflect.DeepEqual(before, after) || current.GuideStep != model.DramaGuideAssets || current.Revision != assets.Production.Revision {
				t.Fatalf("rejected arrangement must preserve old content and guide revision: before=%+v after=%+v production=%+v", before, after, current)
			}
		})
	}
}

func TestDramaGuideStoryboardExplicitlyRestartsFailedEmptyEpisode(t *testing.T) {
	svc, fake := newDramaTestService(t)
	draft := createGuidedDrama(t, svc, DramaChapterInput{Title: "第一集", Text: "甲走进大厅。"})
	projectID := draft.Project.ID
	confirmGuide(t, svc, draft)
	runDramaTicks(t, svc, projectID, 6)
	assets := guideSummary(t, svc, projectID)
	episodeID := assets.Episodes[0].ID
	if err := svc.repo.UpdateDramaEpisodeUser(episodeID, map[string]any{"stage": model.DramaEpisodeScript, "error": "上次编排失败"}); err != nil {
		t.Fatal(err)
	}
	before, _ := svc.repo.DramaEpisode(projectID, episodeID)
	if err := fake.db.Create(&model.DramaJob{ID: newID(), ProjectID: projectID, EpisodeID: episodeID, Kind: model.DramaJobScript, Status: model.DramaJobFailed, PayloadJSON: encodeDramaRevision(before.Revision)}).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ConfirmDramaGuide("usr-drama", projectID, ConfirmDramaGuideRequest{ExpectedStep: model.DramaGuideAssets, ExpectedRevision: assets.Production.Revision, EpisodeID: episodeID}); err != nil {
		t.Fatal(err)
	}
	after, _ := svc.repo.DramaEpisode(projectID, episodeID)
	if after.Stage != model.DramaEpisodeScript || after.Error != "" || after.Revision != before.Revision+1 {
		t.Fatalf("explicit arrangement must restart a failed empty episode: %+v", after)
	}
	runDramaTicks(t, svc, projectID, 20)
	ready, err := svc.DramaEpisodeDetail("usr-drama", projectID, episodeID)
	if err != nil || len(ready.Shots) == 0 || fake.byKind["script"] != 1 {
		t.Fatalf("old failed job must not suppress the new request: %+v requests=%v err=%v", ready, fake.byKind, err)
	}
}

func TestDramaRescriptEpisodeResumeFailurePreservesExistingStoryboard(t *testing.T) {
	for _, status := range []string{model.DramaStatusPaused, model.DramaStatusCompleted} {
		t.Run(status, func(t *testing.T) {
			fixture := newDramaGuideRevisionFixture(t, model.DramaGuideCompleted)
			svc, fake := fixture.svc, fixture.fake
			projectID, episodeID := fixture.summary.Project.ID, fixture.shot.EpisodeID
			if err := svc.repo.UpdateDramaProduction(projectID, map[string]any{"stage": model.DramaStageProduce, "status": status, "budget_microcredits": 10}); err != nil {
				t.Fatal(err)
			}
			if err := svc.repo.UpdateDramaEpisodeUser(episodeID, map[string]any{"stage": model.DramaEpisodeDone, "shot_count": 1, "approved": true, "final_resource_id": "existing-final"}); err != nil {
				t.Fatal(err)
			}
			job := model.DramaJob{ID: newID(), ProjectID: projectID, EpisodeID: episodeID, Kind: model.DramaJobSegmentVideo, Status: model.DramaJobQueued}
			if err := fake.db.Create(&job).Error; err != nil {
				t.Fatal(err)
			}
			seedDramaBillingOrder(t, fake.db, projectID, "rescript-spend", model.BillingOrder{Status: model.BillingStatusSettled, AmountMicrocredits: 10, ActualAmountMicrocredits: 10})
			before, _ := svc.DramaEpisodeDetail("usr-drama", projectID, episodeID)
			productionBefore, _ := svc.repo.DramaProduction(projectID)
			if _, err := svc.RescriptDramaEpisode("usr-drama", projectID, episodeID); err == nil {
				t.Fatal("exhausted budget must reject rearrangement")
			}
			after, _ := svc.DramaEpisodeDetail("usr-drama", projectID, episodeID)
			productionAfter, _ := svc.repo.DramaProduction(projectID)
			if !reflect.DeepEqual(before, after) || !reflect.DeepEqual(productionBefore, productionAfter) {
				t.Fatalf("resume admission failure must preserve script, prompts, queued work and production: before=%+v after=%+v production=%+v", before, after, productionAfter)
			}
			if err := svc.repo.UpdateDramaProduction(projectID, map[string]any{"budget_microcredits": 100}); err != nil {
				t.Fatal(err)
			}
			restarted, err := svc.RescriptDramaEpisode("usr-drama", projectID, episodeID)
			current, _ := svc.repo.DramaProduction(projectID)
			if err != nil || restarted.Episode.Stage != model.DramaEpisodeScript || len(restarted.Shots) != 0 || len(restarted.Segments) != 0 || !restarted.Episode.FinalStale || restarted.Episode.FinalResourceID != before.Episode.FinalResourceID || current.Status != model.DramaStatusRunning {
				t.Fatalf("successful rearrangement must atomically replace script and resume: %+v production=%+v err=%v", restarted, current, err)
			}
			again, err := svc.RescriptDramaEpisode("usr-drama", projectID, episodeID)
			if err != nil || again.Episode.Revision != restarted.Episode.Revision+1 {
				t.Fatalf("another explicit arrangement must start a fresh revision: %+v %v", again, err)
			}
		})
	}
}

func TestDramaEnsureEpisodeStoryboardStartsOnlyMissingEpisode(t *testing.T) {
	svc, fake := newDramaTestService(t)
	draft := createGuidedDrama(t, svc, DramaChapterInput{Title: "一", Text: "甲"}, DramaChapterInput{Title: "二", Text: "乙"})
	confirmGuide(t, svc, draft)
	runDramaTicks(t, svc, draft.Project.ID, 6)
	confirmGuide(t, svc, guideSummary(t, svc, draft.Project.ID))
	runDramaTicks(t, svc, draft.Project.ID, 20)
	ready := guideSummary(t, svc, draft.Project.ID)
	confirmGuide(t, svc, ready)
	secondID := ready.Episodes[1].ID
	before, _ := svc.repo.DramaEpisode(draft.Project.ID, secondID)
	for range 3 {
		detail, err := svc.EnsureDramaEpisodeStoryboard("usr-drama", draft.Project.ID, secondID)
		if err != nil || detail.Episode.Stage != model.DramaEpisodeScript || detail.Episode.Revision != before.Revision+1 {
			t.Fatalf("only one intent must start on the same catalog episode: %+v %v", detail, err)
		}
	}
	if fake.byKind["script"] != 1 {
		t.Fatal("ensure must not invoke a model inline")
	}
	runDramaTicks(t, svc, draft.Project.ID, 20)
	if fake.byKind["script"] != 2 {
		t.Fatalf("only the new episode must generate: %v", fake.byKind)
	}
}

func TestDramaEnsureEpisodeStoryboardPreservesPartialResultsAndActiveWork(t *testing.T) {
	for _, existing := range []string{"shot", "segment", "queued", "running", "queued-stage", "script-stage"} {
		t.Run(existing, func(t *testing.T) {
			svc, fake := newDramaTestService(t)
			summary := createGuidedDrama(t, svc, DramaChapterInput{Title: "一", Text: "甲"})
			projectID, episodeID := summary.Project.ID, summary.Episodes[0].ID
			if err := fake.db.Model(&model.DramaProduction{}).Where("project_id = ?", projectID).Updates(map[string]any{"guide_step": model.DramaGuideStory, "stage": model.DramaStageProduce, "status": model.DramaStatusPaused}).Error; err != nil {
				t.Fatal(err)
			}
			var row any
			switch existing {
			case "shot":
				row = &model.DramaShot{ID: newID(), ProjectID: projectID, EpisodeID: episodeID, Action: "保留人工镜头", DurationMs: 3000}
				if err := fake.db.Create(&model.DramaSegment{ID: newID(), ProjectID: projectID, EpisodeID: episodeID}).Error; err != nil {
					t.Fatal(err)
				}
			case "segment":
				row = &model.DramaSegment{ID: newID(), ProjectID: projectID, EpisodeID: episodeID, VideoPromptOverride: "保留人工提示词"}
			case "queued-stage", "script-stage":
				stage := model.DramaEpisodeQueued
				if existing == "script-stage" {
					stage = model.DramaEpisodeScript
				}
				if err := svc.repo.UpdateDramaEpisodeUser(episodeID, map[string]any{"stage": stage}); err != nil {
					t.Fatal(err)
				}
			default:
				row = &model.DramaJob{ID: newID(), ProjectID: projectID, EpisodeID: episodeID, Kind: model.DramaJobScript, Status: existing, CreatedAt: time.Now()}
			}
			if row != nil {
				if err := fake.db.Create(row).Error; err != nil {
					t.Fatal(err)
				}
			}
			before, err := svc.DramaEpisodeDetail("usr-drama", projectID, episodeID)
			if err != nil {
				t.Fatal(err)
			}
			p, _ := svc.repo.DramaProduction(projectID)
			after, err := svc.EnsureDramaEpisodeStoryboard("usr-drama", projectID, episodeID)
			current, _ := svc.repo.DramaProduction(projectID)
			if err != nil || !reflect.DeepEqual(before, after) || !reflect.DeepEqual(p, current) || len(fake.requests) != 0 {
				t.Fatalf("ensure must preserve existing results/work and pause state: before=%+v after=%+v error=%v", before, after, err)
			}
		})
	}
}

func TestDramaEnsureEpisodeStoryboardRejectsFailureAndInvalidScope(t *testing.T) {
	svc, fake := newDramaTestService(t)
	summary := createGuidedDrama(t, svc, DramaChapterInput{Title: "一", Text: "甲"})
	projectID, episodeID := summary.Project.ID, summary.Episodes[0].ID
	if _, err := svc.EnsureDramaEpisodeStoryboard("other", projectID, episodeID); err == nil {
		t.Fatal("foreign project accepted")
	}
	if _, err := svc.EnsureDramaEpisodeStoryboard("usr-drama", projectID, episodeID); err == nil {
		t.Fatal("configuration stage cannot start storyboard generation")
	}
	if err := fake.db.Model(&model.DramaProduction{}).Where("project_id = ?", projectID).Updates(map[string]any{"guide_step": model.DramaGuideStory, "stage": model.DramaStageProduce}).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := svc.EnsureDramaEpisodeStoryboard("usr-drama", projectID, "foreign-episode"); err == nil {
		t.Fatal("foreign episode accepted")
	}
	episode, _ := svc.repo.DramaEpisode(projectID, episodeID)
	job := &model.DramaJob{ID: newID(), ProjectID: projectID, EpisodeID: episodeID, Kind: model.DramaJobScript, Status: model.DramaJobFailed, PayloadJSON: encodeDramaRevision(episode.Revision), CreatedAt: time.Now()}
	if err := fake.db.Create(job).Error; err != nil {
		t.Fatal(err)
	}
	for range 3 {
		_, err := svc.EnsureDramaEpisodeStoryboard("usr-drama", projectID, episodeID)
		requireGuideConflict(t, err)
	}
	after, _ := svc.repo.DramaEpisode(projectID, episodeID)
	if !reflect.DeepEqual(episode, after) || len(fake.requests) != 0 {
		t.Fatal("failed episode must await explicit retry without changing state")
	}
}

func TestDramaEnsureEpisodeStoryboardRecoversEmptyCompletedEpisode(t *testing.T) {
	svc, fake := newDramaTestService(t)
	summary := createGuidedDrama(t, svc, DramaChapterInput{Title: "一", Text: "甲"})
	projectID, episodeID := summary.Project.ID, summary.Episodes[0].ID
	if err := fake.db.Model(&model.DramaProduction{}).Where("project_id = ?", projectID).Updates(map[string]any{"guide_step": model.DramaGuideCompleted, "stage": model.DramaStageDone, "status": model.DramaStatusCompleted}).Error; err != nil {
		t.Fatal(err)
	}
	if err := svc.repo.UpdateDramaEpisodeUser(episodeID, map[string]any{"stage": model.DramaEpisodeDone, "shot_count": 5}); err != nil {
		t.Fatal(err)
	}
	detail, err := svc.EnsureDramaEpisodeStoryboard("usr-drama", projectID, episodeID)
	if err != nil || detail.Episode.Stage != model.DramaEpisodeScript {
		t.Fatalf("empty completed episode must recover without rescripting existing results: %+v %v", detail, err)
	}
	runDramaTicks(t, svc, projectID, 20)
	if fake.byKind["script"] != 1 {
		t.Fatalf("missing completed storyboard must generate once: %v", fake.byKind)
	}
}

func TestDramaEnsureEpisodeStoryboardResumeFailureLeavesEpisodeStartable(t *testing.T) {
	for _, status := range []string{model.DramaStatusPaused, model.DramaStatusCompleted} {
		t.Run(status, func(t *testing.T) {
			svc, fake := newDramaTestService(t)
			summary := createGuidedDrama(t, svc, DramaChapterInput{Title: "一", Text: "甲"})
			projectID, episodeID := summary.Project.ID, summary.Episodes[0].ID
			if err := svc.repo.UpdateDramaProduction(projectID, map[string]any{"guide_step": model.DramaGuideCompleted, "stage": model.DramaStageProduce, "status": status, "budget_microcredits": 10}); err != nil {
				t.Fatal(err)
			}
			seedDramaBillingOrder(t, fake.db, projectID, "storyboard-spend", model.BillingOrder{Status: model.BillingStatusSettled, AmountMicrocredits: 10, ActualAmountMicrocredits: 10})
			before, _ := svc.repo.DramaEpisode(projectID, episodeID)
			p, _ := svc.repo.DramaProduction(projectID)
			if _, err := svc.EnsureDramaEpisodeStoryboard("usr-drama", projectID, episodeID); err == nil {
				t.Fatal("exhausted budget must reject missing storyboard generation")
			}
			after, _ := svc.repo.DramaEpisode(projectID, episodeID)
			current, _ := svc.repo.DramaProduction(projectID)
			if !reflect.DeepEqual(before, after) || !reflect.DeepEqual(p, current) || len(fake.requests) != 0 {
				t.Fatalf("resume failure must roll back all generation intent: before=%+v after=%+v production=%+v", before, after, current)
			}
			if err := svc.repo.UpdateDramaProduction(projectID, map[string]any{"budget_microcredits": 100}); err != nil {
				t.Fatal(err)
			}
			detail, err := svc.EnsureDramaEpisodeStoryboard("usr-drama", projectID, episodeID)
			current, _ = svc.repo.DramaProduction(projectID)
			if err != nil || detail.Episode.Stage != model.DramaEpisodeScript || current.Status != model.DramaStatusRunning {
				t.Fatalf("corrected budget must permit another ensure: detail=%+v production=%+v error=%v", detail, current, err)
			}
			runDramaTicks(t, svc, projectID, 20)
			if fake.byKind["script"] != 1 {
				t.Fatalf("corrected episode must generate exactly once: %v", fake.byKind)
			}
		})
	}
}

func TestDramaGuidedSmartPlanKeepsEpisodesUnstarted(t *testing.T) {
	svc, fake := newDramaTestService(t)
	summary, err := svc.CreateDrama("usr-drama", CreateDramaRequest{Name: "智能分集", Guided: true, Settings: DramaSettings{EpisodeMode: DramaEpisodeModeAuto, Models: fakeDramaModels}, Chapters: []DramaChapterInput{{Title: "一", Text: "甲"}, {Title: "二", Text: "乙"}, {Title: "三", Text: "丙"}}})
	if err != nil {
		t.Fatal(err)
	}
	confirmGuide(t, svc, summary)
	runDramaTicks(t, svc, summary.Project.ID, 6)
	confirmGuide(t, svc, guideSummary(t, svc, summary.Project.ID))
	runDramaTicks(t, svc, summary.Project.ID, 20)
	planned := guideSummary(t, svc, summary.Project.ID)
	if len(planned.Episodes) != 2 || fake.byKind["plan"] != 1 || fake.byKind["script"] != 0 {
		t.Fatalf("smart planning must only populate the catalog: episodes=%+v kinds=%v", planned.Episodes, fake.byKind)
	}
	for _, episode := range planned.Episodes {
		if episode.Stage != model.DramaEpisodeDraft {
			t.Fatalf("new planned episode started without a request: %+v", episode)
		}
	}
	if _, err := svc.EnsureDramaEpisodeStoryboard("usr-drama", summary.Project.ID, planned.Episodes[1].ID); err != nil {
		t.Fatal(err)
	}
	runDramaTicks(t, svc, summary.Project.ID, 20)
	if fake.byKind["script"] != 1 {
		t.Fatalf("only the selected planned episode may generate: %v", fake.byKind)
	}
}
