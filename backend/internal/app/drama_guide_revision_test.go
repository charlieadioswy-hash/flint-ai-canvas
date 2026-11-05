package app

import (
	"testing"

	"yingce/backend/internal/model"

	"gorm.io/gorm"
)

type dramaGuideRevisionFixture struct {
	svc     *Service
	fake    *fakeDramaBackend
	summary DramaSummary
	shot    model.DramaShot
	segment model.DramaSegment
	cast    model.DramaCast
}

func newDramaGuideRevisionFixture(t *testing.T, step string) dramaGuideRevisionFixture {
	t.Helper()
	svc, fake := newDramaTestService(t)
	summary := createGuidedDrama(t, svc, DramaChapterInput{Title: "原章节", Text: "原正文"})
	if err := fake.db.Model(&model.DramaProduction{}).Where("project_id = ?", summary.Project.ID).Update("guide_step", step).Error; err != nil {
		t.Fatal(err)
	}
	shot := model.DramaShot{ID: newID(), ProjectID: summary.Project.ID, EpisodeID: summary.Episodes[0].ID, Camera: "固定机位", Transition: "cut", DurationMs: 3000}
	segment := model.DramaSegment{ID: newID(), ProjectID: summary.Project.ID, EpisodeID: shot.EpisodeID, Revision: 4, PromptStatus: model.DramaMediaReady, VideoPromptOverride: "已确认的段提示词"}
	cast := model.DramaCast{ID: newID(), ProjectID: summary.Project.ID, Kind: "character", Name: "原角色", Revision: 2}
	for _, row := range []any{&shot, &segment, &cast} {
		if err := fake.db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	return dramaGuideRevisionFixture{svc: svc, fake: fake, summary: summary, shot: shot, segment: segment, cast: cast}
}

func TestDramaGuideShotNoopUsesSharedRevision(t *testing.T) {
	for _, test := range []struct {
		name     string
		step     string
		expected string
		busy     bool
		conflict bool
		advance  bool
	}{
		{name: "current-guided", step: model.DramaGuideStory, expected: "current", advance: true},
		{name: "stale-guided", step: model.DramaGuideStory, expected: "stale", conflict: true},
		{name: "missing-guided", step: model.DramaGuideStory, conflict: true},
		{name: "busy-guided", step: model.DramaGuideStory, expected: "current", busy: true, conflict: true},
		{name: "completed-guided-request", step: model.DramaGuideCompleted, expected: "current", conflict: true},
		{name: "traditional", step: ""},
		{name: "completed-traditional", step: model.DramaGuideCompleted},
	} {
		t.Run(test.name, func(t *testing.T) {
			fixture := newDramaGuideRevisionFixture(t, test.step)
			projectID := fixture.summary.Project.ID
			revision := fixture.summary.Production.Revision
			var expected *int64
			if test.expected != "" {
				value := revision
				if test.expected == "stale" {
					value--
				}
				expected = &value
			}
			if test.busy {
				job := model.DramaJob{ID: newID(), ProjectID: projectID, Kind: model.DramaJobSegmentPrompt, Status: model.DramaJobRunning}
				if err := fixture.fake.db.Create(&job).Error; err != nil {
					t.Fatal(err)
				}
			}
			camera, transition, seconds := " 固定机位 ", "cut", 3.0
			_, err := fixture.svc.UpdateDramaShot("usr-drama", projectID, fixture.shot.ID, UpdateDramaShotRequest{ExpectedRevision: expected, Camera: &camera, Transition: &transition, DurationSeconds: &seconds})
			if test.conflict {
				requireGuideConflict(t, err)
			} else if err != nil {
				t.Fatal(err)
			}
			production, err := fixture.svc.repo.DramaProduction(projectID)
			if err != nil {
				t.Fatal(err)
			}
			wantRevision := revision
			if test.advance {
				wantRevision++
			}
			if production.Revision != wantRevision || production.GuideStep != test.step {
				t.Fatalf("no-op revision/step: %+v, want revision %d and step %q", production, wantRevision, test.step)
			}
			shot, err := fixture.svc.repo.DramaShot(projectID, fixture.shot.ID)
			if err != nil || shot.Camera != fixture.shot.Camera || !shot.UpdatedAt.Equal(fixture.shot.UpdatedAt) {
				t.Fatalf("no-op must not update the shot: %+v %v", shot, err)
			}
			segments, err := fixture.svc.repo.DramaSegments(fixture.shot.EpisodeID)
			if err != nil || len(segments) != 1 || segments[0].Revision != fixture.segment.Revision || segments[0].VideoPromptOverride != fixture.segment.VideoPromptOverride || segments[0].PromptStatus != fixture.segment.PromptStatus {
				t.Fatalf("no-op must preserve downstream text: %+v %v", segments, err)
			}
			if len(fixture.fake.requests) != 0 {
				t.Fatal("no-op must not submit generation tasks")
			}
		})
	}
}

func TestDramaGuideCompletedRejectsVersionedTextEdits(t *testing.T) {
	fixture := newDramaGuideRevisionFixture(t, model.DramaGuideCompleted)
	projectID := fixture.summary.Project.ID
	revision := fixture.summary.Production.Revision
	chapters, err := fixture.svc.repo.DramaChapters(projectID)
	if err != nil || len(chapters) != 1 {
		t.Fatalf("load chapters: %+v %v", chapters, err)
	}
	changed := "过期建议的修改"
	settings := fixture.summary.Production.Settings
	settings.Language = changed
	for _, test := range []struct {
		name string
		edit func() error
	}{
		{name: "shot", edit: func() error {
			_, err := fixture.svc.UpdateDramaShot("usr-drama", projectID, fixture.shot.ID, UpdateDramaShotRequest{ExpectedRevision: &revision, Camera: &changed})
			return err
		}},
		{name: "cast", edit: func() error {
			_, err := fixture.svc.UpdateDramaCast("usr-drama", projectID, fixture.cast.ID, UpdateDramaCastRequest{ExpectedRevision: &revision, Name: &changed})
			return err
		}},
		{name: "segment-prompt", edit: func() error {
			return fixture.svc.UpdateDramaSegment("usr-drama", projectID, fixture.shot.EpisodeID, 0, UpdateDramaSegmentRequest{ExpectedRevision: &revision, VideoPromptOverride: &changed})
		}},
		{name: "chapter", edit: func() error {
			_, err := fixture.svc.UpdateDramaChapter("usr-drama", projectID, chapters[0].ID, UpdateDramaChapterRequest{ExpectedRevision: &revision, Text: &changed})
			return err
		}},
		{name: "setup", edit: func() error {
			_, err := fixture.svc.UpdateDramaSettings("usr-drama", projectID, UpdateDramaSettingsRequest{ExpectedRevision: &revision, Settings: &settings})
			return err
		}},
	} {
		t.Run(test.name, func(t *testing.T) { requireGuideConflict(t, test.edit()) })
	}
	production, err := fixture.svc.repo.DramaProduction(projectID)
	if err != nil || production.Revision != revision || production.GuideStep != model.DramaGuideCompleted || parseDramaSettings(production.SettingsJSON).Language != fixture.summary.Production.Settings.Language {
		t.Fatalf("old guide edits must not change production: %+v %v", production, err)
	}
	shot, err := fixture.svc.repo.DramaShot(projectID, fixture.shot.ID)
	if err != nil || shot.Camera != fixture.shot.Camera {
		t.Fatalf("old guide edit changed shot: %+v %v", shot, err)
	}
	cast, err := fixture.svc.repo.DramaCast(projectID, fixture.cast.ID)
	if err != nil || cast.Name != fixture.cast.Name || cast.Revision != fixture.cast.Revision {
		t.Fatalf("old guide edit changed cast: %+v %v", cast, err)
	}
	segments, err := fixture.svc.repo.DramaSegments(fixture.shot.EpisodeID)
	if err != nil || len(segments) != 1 || segments[0].Revision != fixture.segment.Revision || segments[0].VideoPromptOverride != fixture.segment.VideoPromptOverride {
		t.Fatalf("old guide edit changed segment: %+v %v", segments, err)
	}
	storedChapters, err := fixture.svc.repo.DramaChapters(projectID)
	if err != nil || len(storedChapters) != 1 || storedChapters[0].SourceText != chapters[0].SourceText {
		t.Fatalf("old guide edit changed chapter: %+v %v", storedChapters, err)
	}
	if len(fixture.fake.requests) != 0 {
		t.Fatal("rejected edits must not submit generation tasks")
	}
}

func TestDramaGuideSetupRechecksStepAfterValidation(t *testing.T) {
	fixture := newDramaGuideRevisionFixture(t, model.DramaGuideConfiguring)
	projectID := fixture.summary.Project.ID
	revision := fixture.summary.Production.Revision
	changed := false
	callback := "test:finish-guide-before-settings-lock"
	if err := fixture.fake.db.Callback().Query().After("gorm:query").Register(callback, func(tx *gorm.DB) {
		if changed || tx.Statement.Table != "drama_productions" {
			return
		}
		changed = true
		if err := fixture.fake.db.Model(&model.DramaProduction{}).Where("project_id = ?", projectID).Updates(map[string]any{"guide_step": model.DramaGuideCompleted, "revision": revision + 1}).Error; err != nil {
			t.Fatal(err)
		}
	}); err != nil {
		t.Fatal(err)
	}
	defer fixture.fake.db.Callback().Query().Remove(callback)
	settings := fixture.summary.Production.Settings
	settings.Language = "旧引导的语言修改"
	_, err := fixture.svc.UpdateDramaSettings("usr-drama", projectID, UpdateDramaSettingsRequest{ExpectedRevision: &revision, Settings: &settings})
	requireGuideConflict(t, err)
	production, err := fixture.svc.repo.DramaProduction(projectID)
	if err != nil || !changed || production.Revision != revision+1 || production.GuideStep != model.DramaGuideCompleted || parseDramaSettings(production.SettingsJSON).Language != fixture.summary.Production.Settings.Language {
		t.Fatalf("setup must not cross guide completion: %+v changed=%v error=%v", production, changed, err)
	}
}

func TestDramaGuideRevisionKeepsTraditionalSettingsSaves(t *testing.T) {
	for _, step := range []string{"", model.DramaGuideCompleted} {
		t.Run("step-"+step, func(t *testing.T) {
			fixture := newDramaGuideRevisionFixture(t, step)
			settings := fixture.summary.Production.Settings
			settings.Language = "英语"
			updated, err := fixture.svc.UpdateDramaSettings("usr-drama", fixture.summary.Project.ID, UpdateDramaSettingsRequest{Settings: &settings})
			if err != nil || updated.Production.Settings.Language != settings.Language {
				t.Fatalf("traditional settings save must remain available: %+v %v", updated, err)
			}
		})
	}
}

func TestDramaGuideRevisionKeepsWorkbenchTextRegeneration(t *testing.T) {
	for _, step := range []string{"", model.DramaGuideCompleted} {
		t.Run("step-"+step, func(t *testing.T) {
			fixture := newDramaGuideRevisionFixture(t, step)
			projectID, episodeID := fixture.summary.Project.ID, fixture.shot.EpisodeID
			queued, err := fixture.svc.RequestDramaSegmentPrompts("usr-drama", projectID, episodeID, GenerateDramaSegmentsRequest{Segments: []int{0}})
			if err != nil || queued["queued"] != 1 {
				t.Fatalf("workbench prompt rewrite must remain available: %+v %v", queued, err)
			}
			detail, err := fixture.svc.RescriptDramaEpisode("usr-drama", projectID, episodeID)
			if err != nil || detail.Episode.Stage != model.DramaEpisodeScript || len(detail.Shots) != 0 || len(detail.Segments) != 0 {
				t.Fatalf("workbench rescripting must remain available: %+v %v", detail, err)
			}
			production, err := fixture.svc.repo.DramaProduction(projectID)
			if err != nil || production.Revision != fixture.summary.Production.Revision || production.GuideStep != step {
				t.Fatalf("workbench edits must not use guide revision: %+v %v", production, err)
			}
			if len(fixture.fake.requests) != 0 {
				t.Fatal("requesting work must not synchronously submit generation tasks")
			}
		})
	}
}
