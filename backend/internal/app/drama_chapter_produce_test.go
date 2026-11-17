package app

import (
	"reflect"
	"strings"
	"testing"
	"time"

	"yingce/backend/internal/model"
	"yingce/backend/internal/production"
)

func dramaChapterProduceFixture(t *testing.T, step string) (*Service, *fakeDramaBackend, DramaSummary, []DramaChapterRef) {
	t.Helper()
	svc, fake := newDramaTestService(t)
	settings := DramaSettings{ReviewMode: DramaReviewAuto, MediaMode: DramaMediaManual, Concurrency: 16, Models: fakeDramaModels, EpisodeMode: DramaEpisodeModeChapter, ChaptersPerEpisode: 1}
	input := []DramaChapterInput{{Title: "序章", Text: "萧炎在萧家大厅起身。"}, {Title: "第一章", Text: "预留章节甲：少年走向后山。"}, {Title: "第二章", Text: "预留章节乙：药老现身。"}}
	if step != "" {
		input = input[:1]
	}
	summary, err := svc.CreateDrama("usr-drama", CreateDramaRequest{
		Name: "补入预留章节", Guided: step != "", SourceFormat: production.SourceScript, Settings: settings,
		Chapters: input, SelectedChapters: []int{0},
	})
	if err != nil {
		t.Fatal(err)
	}
	if step != "" && step != model.DramaGuideConfiguring {
		summary = confirmGuide(t, svc, summary)
		runDramaTicks(t, svc, summary.Project.ID, 8)
		summary = guideSummary(t, svc, summary.Project.ID)
		if step != model.DramaGuideAssets {
			summary = confirmGuide(t, svc, summary)
			runDramaTicks(t, svc, summary.Project.ID, 20)
			summary = guideSummary(t, svc, summary.Project.ID)
			if step == model.DramaGuideCompleted {
				summary = confirmGuide(t, svc, summary)
			}
		}
	}
	if step != "" {
		// 模拟升级前留下的原文，不通过已经取消选章的新建入口制造预留章。
		for i, item := range []DramaChapterInput{{Title: "第一章", Text: "预留章节甲：少年走向后山。"}, {Title: "第二章", Text: "预留章节乙：药老现身。"}} {
			chapter := model.ProjectUnit{ID: newID(), ProjectID: summary.Project.ID, Kind: model.ProjectUnitKindChapter, Title: item.Title, SourceText: item.Text, WordCount: len([]rune(item.Text)), Status: model.ProjectUnitStatusReserved, Position: i + 1, CreatedAt: time.Now(), UpdatedAt: time.Now()}
			if err := fake.db.Create(&chapter).Error; err != nil {
				t.Fatal(err)
			}
		}
		summary.Production.ReservedChapterCount = 2
	}
	chapters, err := svc.DramaChapterOutline("usr-drama", summary.Project.ID)
	if err != nil {
		t.Fatal(err)
	}
	return svc, fake, summary, chapters
}

func TestDramaProduceChaptersDuringGuidePreservesExistingWork(t *testing.T) {
	for _, step := range []string{model.DramaGuideAssets, model.DramaGuideStory} {
		t.Run(step, func(t *testing.T) {
			svc, fake, before, chapters := dramaChapterProduceFixture(t, step)
			projectID, originalID := before.Project.ID, before.Episodes[0].ID
			original, _ := svc.repo.DramaEpisode(projectID, originalID)
			shots, _ := svc.repo.DramaShots(originalID)
			segments, _ := svc.repo.DramaSegments(originalID)
			casts, _ := svc.repo.DramaCasts(projectID)
			requests, scripts, bibles := len(fake.requests), fake.byKind["script"], fake.byKind["bible"]
			req := ProduceDramaChaptersRequest{ExpectedRevision: &before.Production.Revision, ChapterIDs: []string{chapters[2].ID, chapters[1].ID}, ChaptersPerEpisode: 12}
			result, err := svc.ProduceDramaChapters("usr-drama", projectID, req)
			if err != nil || len(result.EpisodeIDs) != 2 || result.Revision != before.Production.Revision+1 {
				t.Fatalf("append in %s: %+v %v", step, result, err)
			}
			after := guideSummary(t, svc, projectID)
			if len(after.Episodes) != 3 || after.Episodes[0].ID != originalID || after.Episodes[1].Title != "第一章" || after.Episodes[2].Title != "第二章" || after.Production.Revision != result.Revision || after.Production.ReservedChapterCount != 0 || after.Production.PlanCursor != 3 {
				t.Fatalf("summary did not include the real appended episodes: %+v", after)
			}
			if after.Production.GuideStep != step || after.Production.Stage != before.Production.Stage || after.Production.Status != before.Production.Status || len(fake.requests) != requests {
				t.Fatal("adding chapters changed the guide stage or dispatched work inline")
			}
			current, _ := svc.repo.DramaEpisode(projectID, originalID)
			currentShots, _ := svc.repo.DramaShots(originalID)
			currentSegments, _ := svc.repo.DramaSegments(originalID)
			currentCasts, _ := svc.repo.DramaCasts(projectID)
			if !reflect.DeepEqual(original, current) || !reflect.DeepEqual(shots, currentShots) || !reflect.DeepEqual(segments, currentSegments) || !reflect.DeepEqual(casts, currentCasts) {
				t.Fatal("append rewrote existing episodes, shots, segments or assets")
			}
			_, err = svc.ProduceDramaChapters("usr-drama", projectID, req)
			requireGuideConflict(t, err)
			req.ExpectedRevision = &after.Production.Revision
			if _, err := svc.ProduceDramaChapters("usr-drama", projectID, req); err == nil {
				t.Fatal("already included chapters were duplicated with a fresh revision")
			}
			runDramaTicks(t, svc, projectID, 20)
			if fake.byKind["bible"] != bibles || fake.byKind["image"]+fake.byKind["video"]+fake.byKind["render"] != 0 {
				t.Fatal("append reran the initial Bible or released media")
			}
			if step == model.DramaGuideAssets && (fake.byKind["script"] != scripts || len(fake.requests) != requests) {
				t.Fatal("asset guide dispatched downstream scripts for new episodes")
			}
			if step == model.DramaGuideStory && fake.byKind["script"] != scripts+2 {
				t.Fatalf("story guide did not process only the two appended scripts: %v", fake.byKind)
			}
			current, _ = svc.repo.DramaEpisode(projectID, originalID)
			if !reflect.DeepEqual(original, current) {
				t.Fatal("scheduling the new episodes rewrote the original episode")
			}
		})
	}
}

func TestDramaProduceChaptersRejectsInvalidScopeAndStateAtomically(t *testing.T) {
	for _, mutation := range []string{"missing_revision", "stale_revision", "foreign_owner", "foreign_chapter", "already_produced", "duplicate", "blank", "mixed_scope", "active_text", "pending_plan", "long_chapter"} {
		t.Run(mutation, func(t *testing.T) {
			svc, fake, summary, chapters := dramaChapterProduceFixture(t, model.DramaGuideAssets)
			projectID, userID := summary.Project.ID, "usr-drama"
			req := ProduceDramaChaptersRequest{ExpectedRevision: &summary.Production.Revision, ChapterIDs: []string{chapters[1].ID}}
			switch mutation {
			case "missing_revision":
				req.ExpectedRevision = nil
			case "stale_revision":
				stale := summary.Production.Revision - 1
				req.ExpectedRevision = &stale
			case "foreign_owner":
				userID = "other-user"
			case "foreign_chapter":
				req.ChapterIDs = []string{"foreign-chapter"}
			case "already_produced":
				req.ChapterIDs = []string{chapters[0].ID}
			case "duplicate":
				req.ChapterIDs = append(req.ChapterIDs, chapters[1].ID)
			case "blank":
				req.ChapterIDs = append(req.ChapterIDs, " ")
			case "mixed_scope":
				req.ChapterIDs = append(req.ChapterIDs, chapters[0].ID)
			case "active_text":
				if err := fake.db.Create(&model.DramaJob{ID: "chapter-active", ProjectID: projectID, Kind: model.DramaJobBible, Status: model.DramaJobQueued}).Error; err != nil {
					t.Fatal(err)
				}
			case "pending_plan":
				if err := fake.db.Model(&model.DramaProduction{}).Where("project_id = ?", projectID).Update("plan_done", false).Error; err != nil {
					t.Fatal(err)
				}
			case "long_chapter":
				if err := fake.db.Model(&model.ProjectUnit{}).Where("id = ?", chapters[1].ID).Updates(map[string]any{"word_count": 13000, "source_text": strings.Repeat("长", 13000)}).Error; err != nil {
					t.Fatal(err)
				}
			}
			before, _ := svc.repo.DramaProduction(projectID)
			beforeChapters, _ := svc.repo.DramaGuideSourceChapters(projectID)
			beforeEpisodes, _ := svc.repo.DramaEpisodes(projectID)
			if _, err := svc.ProduceDramaChapters(userID, projectID, req); err == nil {
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

func TestDramaProduceChaptersConfiguringCannotBypassSourceSelection(t *testing.T) {
	svc, _, summary, chapters := dramaChapterProduceFixture(t, model.DramaGuideConfiguring)
	if _, err := svc.ProduceDramaChapters("usr-drama", summary.Project.ID, ProduceDramaChaptersRequest{ExpectedRevision: &summary.Production.Revision, ChapterIDs: []string{chapters[1].ID}}); err == nil {
		t.Fatal("configuring guide bypassed source selection")
	}
	after := guideSummary(t, svc, summary.Project.ID)
	if len(after.Episodes) != 3 || after.Production.Revision != summary.Production.Revision+1 || after.Production.ReservedChapterCount != 0 {
		t.Fatal("reading the rejected legacy selection must recover all original episodes")
	}
}

func TestDramaProduceChaptersCASSerializesGuideConfirmation(t *testing.T) {
	for _, race := range []string{"confirm", "duplicate_append"} {
		t.Run(race, func(t *testing.T) {
			svc, fake, summary, chapters := dramaChapterProduceFixture(t, model.DramaGuideAssets)
			// The shared-memory fixture uses table locks without a busy timeout;
			// one connection serializes its writers while exercising the real CAS.
			connection, err := fake.db.DB()
			if err != nil {
				t.Fatal(err)
			}
			connection.SetMaxOpenConns(1)
			start, outcomes := make(chan struct{}), make(chan error, 2)
			req := ProduceDramaChaptersRequest{ExpectedRevision: &summary.Production.Revision, ChapterIDs: []string{chapters[1].ID}}
			go func() {
				<-start
				_, err := svc.ProduceDramaChapters("usr-drama", summary.Project.ID, req)
				outcomes <- err
			}()
			go func() {
				<-start
				var err error
				if race == "confirm" {
					_, err = svc.ConfirmDramaGuide("usr-drama", summary.Project.ID, ConfirmDramaGuideRequest{ExpectedStep: model.DramaGuideAssets, ExpectedRevision: summary.Production.Revision})
				} else {
					_, err = svc.ProduceDramaChapters("usr-drama", summary.Project.ID, req)
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
			if after.Production.Revision != summary.Production.Revision+2 || len(after.Episodes) != 3 {
				t.Fatalf("one CAS edit followed by one catalog recovery must preserve all original chapters: %+v", after)
			}
		})
	}
}

func TestDramaProduceChaptersCompletedAndPausedLifecycle(t *testing.T) {
	for _, tc := range []struct {
		step, status string
	}{
		{model.DramaGuideAssets, model.DramaStatusPaused},
		{model.DramaGuideStory, model.DramaStatusPaused},
		{model.DramaGuideCompleted, model.DramaStatusCompleted},
		{"", model.DramaStatusCompleted},
		{"", model.DramaStatusPaused},
	} {
		t.Run(tc.step+"-"+tc.status, func(t *testing.T) {
			svc, fake, summary, chapters := dramaChapterProduceFixture(t, tc.step)
			if err := fake.db.Model(&model.DramaProduction{}).Where("project_id = ?", summary.Project.ID).Updates(map[string]any{"status": tc.status, "revision": 0}).Error; err != nil {
				t.Fatal(err)
			}
			before, _ := svc.repo.DramaProduction(summary.Project.ID)
			result, err := svc.ProduceDramaChapters("usr-drama", summary.Project.ID, ProduceDramaChaptersRequest{ExpectedRevision: &before.Revision, ChapterIDs: []string{chapters[1].ID}})
			if err != nil || result.Revision != 1 {
				t.Fatalf("present zero revision should be accepted: %+v %v", result, err)
			}
			after, _ := svc.repo.DramaProduction(summary.Project.ID)
			if after.GuideStep != before.GuideStep || after.BibleJSON != before.BibleJSON {
				t.Fatal("append reset guide or Bible")
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
