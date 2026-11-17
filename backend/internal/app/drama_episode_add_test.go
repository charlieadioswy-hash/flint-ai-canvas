package app

import (
	"reflect"
	"strings"
	"testing"
	"time"

	"yingce/backend/internal/model"
	"yingce/backend/internal/platform"
	"yingce/backend/internal/production"
)

func dramaEpisodeAddFixture(t *testing.T, step string) (*Service, *fakeDramaBackend, DramaSummary, []DramaChapterRef) {
	t.Helper()
	svc, fake, summary, chapters := dramaChapterProduceFixture(t, step)
	svc.coordinator = platform.NewCoordinatorWithRedis(nil, "episode-add-test")
	if step != "" {
		summary = guideSummary(t, svc, summary.Project.ID)
	}
	return svc, fake, summary, chapters
}

func TestDramaAddEpisodeDuringGuidePreservesExistingWork(t *testing.T) {
	for _, step := range []string{model.DramaGuideAssets, model.DramaGuideStory} {
		t.Run(step, func(t *testing.T) {
			svc, fake, before, _ := dramaEpisodeAddFixture(t, step)
			projectID, originalID := before.Project.ID, before.Episodes[0].ID
			if step == model.DramaGuideStory {
				video := fake.resource("usr-drama", "video", "video/mp4")
				if err := fake.db.Model(&model.DramaEpisode{}).Where("id = ?", originalID).Updates(map[string]any{"stage": model.DramaEpisodeDone, "final_resource_id": video}).Error; err != nil {
					t.Fatal(err)
				}
				if err := fake.db.Model(&model.DramaSegment{}).Where("episode_id = ?", originalID).Updates(map[string]any{"video_status": model.DramaMediaReady, "video_resource_id": video}).Error; err != nil {
					t.Fatal(err)
				}
			}
			image := fake.resource("usr-drama", "image", "image/png")
			if err := fake.db.Model(&model.DramaCast{}).Where("project_id = ?", projectID).Updates(map[string]any{"image_status": model.DramaMediaReady, "image_resource_id": image}).Error; err != nil {
				t.Fatal(err)
			}
			originalProduction, _ := svc.repo.DramaProduction(projectID)
			original, _ := svc.repo.DramaEpisode(projectID, originalID)
			shots, _ := svc.repo.DramaShots(originalID)
			segments, _ := svc.repo.DramaSegments(originalID)
			casts, _ := svc.repo.DramaCasts(projectID)
			requests, scripts, bibles := len(fake.requests), fake.byKind["script"], fake.byKind["bible"]
			wantNumber := len(before.Episodes) + 1
			detail, err := svc.AddDramaEpisode("usr-drama", projectID, AddDramaEpisodeRequest{ExpectedRevision: &before.Production.Revision, Text: "新增一集：萧炎走向后山。", SourceFormat: production.SourceScript})
			if err != nil || detail.Episode.ID == "" || detail.Episode.Number != wantNumber || detail.Episode.Title != model.DramaEpisodeDefaultTitle(wantNumber) || detail.Episode.Stage != model.DramaEpisodeQueued || len(detail.Chapters) != 1 {
				t.Fatalf("append in %s: %+v %v", step, detail, err)
			}
			after := guideSummary(t, svc, projectID)
			currentProduction, _ := svc.repo.DramaProduction(projectID)
			if len(after.Episodes) != wantNumber || after.Episodes[wantNumber-1].ID != detail.Episode.ID || after.Production.Revision != before.Production.Revision+1 || after.Production.ReservedChapterCount != 0 || after.Production.PlanCursor != wantNumber {
				t.Fatalf("summary did not include the appended episode: %+v", after)
			}
			if after.Production.GuideStep != step || after.Production.Stage != before.Production.Stage || after.Production.Status != before.Production.Status || currentProduction.BibleJSON != originalProduction.BibleJSON || len(fake.requests) != requests {
				t.Fatal("append changed the guide stage, Bible, status or dispatched work inline")
			}
			current, _ := svc.repo.DramaEpisode(projectID, originalID)
			currentShots, _ := svc.repo.DramaShots(originalID)
			currentSegments, _ := svc.repo.DramaSegments(originalID)
			currentCasts, _ := svc.repo.DramaCasts(projectID)
			if !reflect.DeepEqual(original, current) || !reflect.DeepEqual(shots, currentShots) || !reflect.DeepEqual(segments, currentSegments) || !reflect.DeepEqual(casts, currentCasts) {
				t.Fatal("append rewrote existing episodes, shots, segments or assets")
			}
			runDramaTicks(t, svc, projectID, 20)
			if fake.byKind["bible"] != bibles || fake.byKind["image"]+fake.byKind["video"]+fake.byKind["render"] != 0 {
				t.Fatal("append reran the initial Bible or released media")
			}
			if step == model.DramaGuideAssets && (fake.byKind["script"] != scripts || len(fake.requests) != requests) {
				t.Fatal("asset guide dispatched downstream scripts for the new episode")
			}
			if step == model.DramaGuideStory && fake.byKind["script"] != scripts+1 {
				t.Fatalf("story guide did not process only the appended script: %v", fake.byKind)
			}
			current, _ = svc.repo.DramaEpisode(projectID, originalID)
			if !reflect.DeepEqual(original, current) {
				t.Fatal("scheduling the new episode rewrote the original episode")
			}
		})
	}
}

func TestDramaAddEpisodeRejectsInvalidScopeAndStateAtomically(t *testing.T) {
	for _, mutation := range []string{"missing_revision", "stale_revision", "foreign_owner", "configuring", "unknown_guide", "insert_during_guide", "foreign_anchor", "invalid_position", "active_queued_text", "active_running_text", "pending_plan", "empty_text", "long_text", "long_title"} {
		t.Run(mutation, func(t *testing.T) {
			svc, fake, summary, _ := dramaEpisodeAddFixture(t, model.DramaGuideAssets)
			projectID, userID := summary.Project.ID, "usr-drama"
			req := AddDramaEpisodeRequest{ExpectedRevision: &summary.Production.Revision, Text: "新集原文", SourceFormat: production.SourceScript}
			switch mutation {
			case "missing_revision":
				req.ExpectedRevision = nil
			case "stale_revision":
				stale := summary.Production.Revision - 1
				req.ExpectedRevision = &stale
			case "foreign_owner":
				userID = "other-user"
			case "configuring", "unknown_guide":
				step := model.DramaGuideConfiguring
				if mutation == "unknown_guide" {
					step = "unknown"
				}
				if err := fake.db.Model(&model.DramaProduction{}).Where("project_id = ?", projectID).Update("guide_step", step).Error; err != nil {
					t.Fatal(err)
				}
			case "insert_during_guide":
				req.AnchorEpisodeID, req.Position = summary.Episodes[0].ID, "before"
			case "foreign_anchor", "invalid_position":
				if err := fake.db.Model(&model.DramaProduction{}).Where("project_id = ?", projectID).Update("guide_step", model.DramaGuideCompleted).Error; err != nil {
					t.Fatal(err)
				}
				req.Position = "before"
				if mutation == "invalid_position" {
					req.AnchorEpisodeID, req.Position = summary.Episodes[0].ID, "between"
				} else {
					foreign, err := svc.CreateDrama("usr-drama", CreateDramaRequest{Name: "其他作品", SourceFormat: production.SourceScript, Settings: summary.Production.Settings, Chapters: []DramaChapterInput{{Text: "其他作品原文"}}})
					if err != nil || len(foreign.Episodes) != 1 {
						t.Fatalf("foreign project fixture: %+v %v", foreign, err)
					}
					req.AnchorEpisodeID = foreign.Episodes[0].ID
				}
			case "active_queued_text", "active_running_text":
				status := model.DramaJobQueued
				if mutation == "active_running_text" {
					status = model.DramaJobRunning
				}
				if err := fake.db.Create(&model.DramaJob{ID: "append-active", ProjectID: projectID, Kind: model.DramaJobBible, Status: status}).Error; err != nil {
					t.Fatal(err)
				}
			case "pending_plan":
				if err := fake.db.Model(&model.DramaProduction{}).Where("project_id = ?", projectID).Update("plan_done", false).Error; err != nil {
					t.Fatal(err)
				}
			case "empty_text":
				req.Text = " \n "
			case "long_text":
				req.Text = strings.Repeat("长", production.ScriptSourceChapterRunes+1)
			case "long_title":
				req.Title = strings.Repeat("长", 61)
			}
			before, _ := svc.repo.DramaProduction(projectID)
			beforeChapters, _ := svc.repo.DramaGuideSourceChapters(projectID)
			beforeEpisodes, _ := svc.repo.DramaEpisodes(projectID)
			if _, err := svc.AddDramaEpisode(userID, projectID, req); err == nil {
				t.Fatal("invalid append accepted")
			}
			after, _ := svc.repo.DramaProduction(projectID)
			afterChapters, _ := svc.repo.DramaGuideSourceChapters(projectID)
			afterEpisodes, _ := svc.repo.DramaEpisodes(projectID)
			if !reflect.DeepEqual(before, after) || !reflect.DeepEqual(beforeChapters, afterChapters) || !reflect.DeepEqual(beforeEpisodes, afterEpisodes) {
				t.Fatal("rejected append changed chapters, episodes or production")
			}
		})
	}
}

func TestDramaAddEpisodeCASSerializesConcurrentEdits(t *testing.T) {
	for _, race := range []string{"confirm", "duplicate_append", "style"} {
		t.Run(race, func(t *testing.T) {
			svc, fake, summary, _ := dramaEpisodeAddFixture(t, model.DramaGuideAssets)
			// The shared-memory fixture has table locks without a busy timeout;
			// serialize its connections while exercising the real revision CAS.
			connection, err := fake.db.DB()
			if err != nil {
				t.Fatal(err)
			}
			connection.SetMaxOpenConns(1)
			start, outcomes := make(chan struct{}), make(chan error, 2)
			req := AddDramaEpisodeRequest{ExpectedRevision: &summary.Production.Revision, Text: "并发新增集", SourceFormat: production.SourceScript}
			go func() {
				<-start
				_, err := svc.AddDramaEpisode("usr-drama", summary.Project.ID, req)
				outcomes <- err
			}()
			go func() {
				<-start
				var err error
				switch race {
				case "confirm":
					_, err = svc.ConfirmDramaGuide("usr-drama", summary.Project.ID, ConfirmDramaGuideRequest{ExpectedStep: model.DramaGuideAssets, ExpectedRevision: summary.Production.Revision})
				case "duplicate_append":
					_, err = svc.AddDramaEpisode("usr-drama", summary.Project.ID, req)
				case "style":
					_, err = svc.UpdateDramaWorkflowStyle("usr-drama", summary.Project.ID, UpdateDramaWorkflowStyleRequest{ExpectedRevision: &summary.Production.Revision, StyleName: "并发风格", StylePrompt: "并发的制作配置修改"})
				}
				outcomes <- err
			}()
			close(start)
			first, second := <-outcomes, <-outcomes
			if (first == nil) == (second == nil) {
				t.Fatalf("one operation must win the shared revision: %v / %v", first, second)
			}
			if first != nil {
				requireGuideConflict(t, first)
			} else {
				requireGuideConflict(t, second)
			}
			after := guideSummary(t, svc, summary.Project.ID)
			if after.Production.Revision != summary.Production.Revision+1 || len(after.Episodes) > len(summary.Episodes)+1 || len(after.Episodes) < len(summary.Episodes) {
				t.Fatalf("concurrent edit changed more than one snapshot: %+v", after)
			}
		})
	}
}

func TestDramaAddEpisodeCompletedAndPausedLifecycle(t *testing.T) {
	for _, tc := range []struct{ step, status string }{
		{model.DramaGuideAssets, model.DramaStatusPaused},
		{model.DramaGuideStory, model.DramaStatusPaused},
		{model.DramaGuideCompleted, model.DramaStatusCompleted},
		{"", model.DramaStatusCompleted},
		{"", model.DramaStatusPaused},
	} {
		t.Run(tc.step+"-"+tc.status, func(t *testing.T) {
			svc, fake, summary, _ := dramaEpisodeAddFixture(t, tc.step)
			if err := fake.db.Model(&model.DramaProduction{}).Where("project_id = ?", summary.Project.ID).Updates(map[string]any{"status": tc.status, "revision": 0}).Error; err != nil {
				t.Fatal(err)
			}
			before, _ := svc.repo.DramaProduction(summary.Project.ID)
			if _, err := svc.AddDramaEpisode("usr-drama", summary.Project.ID, AddDramaEpisodeRequest{ExpectedRevision: &before.Revision, Text: "新集原文"}); err != nil {
				t.Fatalf("present zero revision should be accepted: %v", err)
			}
			after, _ := svc.repo.DramaProduction(summary.Project.ID)
			if after.Revision != 1 || after.GuideStep != before.GuideStep || after.BibleJSON != before.BibleJSON {
				t.Fatal("append reset guide/Bible or advanced revision incorrectly")
			}
			if tc.status == model.DramaStatusPaused || dramaGuideActive(before) {
				if after.Status != before.Status || after.Stage != before.Stage {
					t.Fatal("append resumed paused work or reset active guide")
				}
			} else if after.Status != model.DramaStatusRunning || after.Stage != model.DramaStageProduce {
				t.Fatal("completed production did not reopen for appended work")
			}
		})
	}
}

func TestDramaAddEpisodeInsertionPreservesNonGuideBehavior(t *testing.T) {
	for _, position := range []string{"before", "after"} {
		t.Run(position, func(t *testing.T) {
			svc, fake, summary, chapters := dramaEpisodeAddFixture(t, "")
			projectID := summary.Project.ID
			second, err := svc.AddDramaEpisode("usr-drama", projectID, AddDramaEpisodeRequest{ExpectedRevision: &summary.Production.Revision, Text: "第二集原文"})
			if err != nil {
				t.Fatal(err)
			}
			job := model.DramaJob{ID: "insert-label", ProjectID: projectID, EpisodeID: second.Episode.ID, Status: model.DramaJobSucceeded, Kind: model.DramaJobScript, Label: model.DramaEpisodeDefaultTitle(2) + " · 剧本"}
			look := model.DramaCast{ID: "insert-look", ProjectID: projectID, Kind: "character", Name: "少年造型", LookFromChapter: 4, LookToChapter: 4}
			if err := fake.db.Create(&job).Error; err != nil {
				t.Fatal(err)
			}
			if err := fake.db.Create(&look).Error; err != nil {
				t.Fatal(err)
			}
			anchor := second.Episode.ID
			if position == "after" {
				anchor = summary.Episodes[0].ID
			}
			before := guideSummary(t, svc, projectID)
			inserted, err := svc.AddDramaEpisode("usr-drama", projectID, AddDramaEpisodeRequest{ExpectedRevision: &before.Production.Revision, Text: "插入集原文", AnchorEpisodeID: anchor, Position: position})
			if err != nil || inserted.Episode.Number != 2 || inserted.Episode.Title != model.DramaEpisodeDefaultTitle(2) {
				t.Fatalf("insert %s: %+v %v", position, inserted, err)
			}
			after := guideSummary(t, svc, projectID)
			shifted, _ := svc.repo.DramaEpisode(projectID, second.Episode.ID)
			if len(after.Episodes) != 3 || after.Episodes[0].ID != summary.Episodes[0].ID || after.Episodes[1].ID != inserted.Episode.ID || shifted.Number != 3 || shifted.Title != model.DramaEpisodeDefaultTitle(3) || after.Production.Revision != before.Production.Revision+1 || after.Production.PlanCursor != 3 {
				t.Fatalf("insert failed to preserve numbering and revision: %+v %+v", after, shifted)
			}
			if err := fake.db.First(&job, "id = ?", job.ID).Error; err != nil || job.Label != model.DramaEpisodeDefaultTitle(3)+" · 剧本" {
				t.Fatalf("job label not shifted: %+v %v", job, err)
			}
			if err := fake.db.First(&look, "id = ?", look.ID).Error; err != nil || look.LookFromChapter != 5 || look.LookToChapter != 5 {
				t.Fatalf("look chapter bounds not shifted: %+v %v", look, err)
			}
			outline, _ := svc.DramaChapterOutline("usr-drama", projectID)
			for _, chapter := range outline {
				if chapter.ID != chapters[1].ID && chapter.ID != chapters[2].ID {
					continue
				}
				want := 1
				if chapter.ID == chapters[2].ID {
					want = 2
				}
				if position == "after" {
					want++
				}
				if !chapter.Reserved || chapter.Position != want {
					t.Fatalf("insert misplaced reserved chapter: %+v want position %d", chapter, want)
				}
			}
		})
	}
}

func TestDramaAddEpisodeInsertionWaitsForSchedulerLease(t *testing.T) {
	svc, _, summary, _ := dramaEpisodeAddFixture(t, "")
	release, err := svc.lockDramaSchedule(summary.Project.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	result := make(chan error, 1)
	go func() {
		_, err := svc.AddDramaEpisode("usr-drama", summary.Project.ID, AddDramaEpisodeRequest{ExpectedRevision: &summary.Production.Revision, Text: "插入集", AnchorEpisodeID: summary.Episodes[0].ID, Position: "after"})
		result <- err
	}()
	select {
	case err := <-result:
		t.Fatalf("insert did not wait for scheduler lease: %v", err)
	case <-time.After(250 * time.Millisecond):
	}
	release()
	select {
	case err := <-result:
		if err != nil {
			t.Fatalf("insert after scheduler released its lease: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("insert remained blocked after scheduler lease release")
	}
}
