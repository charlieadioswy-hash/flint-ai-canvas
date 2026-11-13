package app

import (
	"testing"

	"yingce/backend/internal/model"
)

func TestDramaChapterTextEditAdvancesCompletedRevision(t *testing.T) {
	fixture := newDramaGuideRevisionFixture(t, model.DramaGuideCompleted)
	projectID := fixture.summary.Project.ID
	revision := fixture.summary.Production.Revision
	chapters, err := fixture.svc.repo.DramaChapters(projectID)
	if err != nil || len(chapters) != 1 {
		t.Fatalf("load chapters: %+v %v", chapters, err)
	}
	other := model.ProjectUnit{ID: newID(), ProjectID: projectID, Kind: model.ProjectUnitKindChapter, Title: "未修改章节", SourceText: "保留原文"}
	if err := fixture.fake.db.Create(&other).Error; err != nil {
		t.Fatal(err)
	}
	otherEpisode := model.DramaEpisode{ID: newID(), ProjectID: projectID, Number: 2, Title: "未修改剧集", ChapterIDsJSON: encodeStringList([]string{other.ID}), Stage: model.DramaEpisodeDone, Revision: 3}
	if err := fixture.fake.db.Create(&otherEpisode).Error; err != nil {
		t.Fatal(err)
	}
	changed := "制作期确认的正文"
	updated, err := fixture.svc.UpdateDramaChapter("usr-drama", projectID, chapters[0].ID, UpdateDramaChapterRequest{ExpectedRevision: &revision, Text: &changed})
	if err != nil || updated.SourceText != changed {
		t.Fatalf("current revision chapter save: %+v %v", updated, err)
	}
	production, err := fixture.svc.repo.DramaProduction(projectID)
	if err != nil || production.Revision != revision+1 || production.GuideStep != model.DramaGuideCompleted {
		t.Fatalf("chapter save revision/step: %+v %v", production, err)
	}
	shot, err := fixture.svc.repo.DramaShot(projectID, fixture.shot.ID)
	if err != nil || shot.Camera != fixture.shot.Camera || !shot.UpdatedAt.Equal(fixture.shot.UpdatedAt) {
		t.Fatalf("chapter save must not rewrite shots: %+v %v", shot, err)
	}
	segments, err := fixture.svc.repo.DramaSegments(fixture.shot.EpisodeID)
	if err != nil || len(segments) != 1 || segments[0].Revision != fixture.segment.Revision || segments[0].VideoPromptOverride != fixture.segment.VideoPromptOverride || segments[0].PromptStatus != fixture.segment.PromptStatus {
		t.Fatalf("chapter save must not rewrite segments: %+v %v", segments, err)
	}
	if len(fixture.fake.requests) != 0 {
		t.Fatal("chapter save must not submit generation tasks")
	}
	storedOther, err := fixture.svc.repo.ProjectUnit(projectID, other.ID)
	if err != nil || storedOther.SourceText != other.SourceText || !storedOther.UpdatedAt.Equal(other.UpdatedAt) {
		t.Fatalf("chapter save changed unrelated source: %+v %v", storedOther, err)
	}
	storedEpisode, err := fixture.svc.repo.DramaEpisode(projectID, otherEpisode.ID)
	if err != nil || storedEpisode.Stage != otherEpisode.Stage || storedEpisode.Revision != otherEpisode.Revision || !storedEpisode.UpdatedAt.Equal(otherEpisode.UpdatedAt) {
		t.Fatalf("chapter save changed unrelated episode: %+v %v", storedEpisode, err)
	}

	stale := "过期建议的正文"
	_, err = fixture.svc.UpdateDramaChapter("usr-drama", projectID, chapters[0].ID, UpdateDramaChapterRequest{ExpectedRevision: &revision, Text: &stale})
	requireGuideConflict(t, err)
	stored, err := fixture.svc.repo.ProjectUnit(projectID, chapters[0].ID)
	if err != nil || stored.SourceText != changed {
		t.Fatalf("stale chapter save changed source: %+v %v", stored, err)
	}
	production, err = fixture.svc.repo.DramaProduction(projectID)
	if err != nil || production.Revision != revision+1 || production.GuideStep != model.DramaGuideCompleted {
		t.Fatalf("stale chapter save changed production: %+v %v", production, err)
	}
}

func TestDramaChapterTextEditRejectsActiveTextJobs(t *testing.T) {
	for _, test := range []struct {
		name   string
		step   string
		kind   string
		status string
	}{
		{name: "completed-script", step: model.DramaGuideCompleted, kind: model.DramaJobScript, status: model.DramaJobRunning},
		{name: "completed-queued-prompt", step: model.DramaGuideCompleted, kind: model.DramaJobSegmentPrompt, status: model.DramaJobQueued},
		{name: "guided-story-script", step: model.DramaGuideStory, kind: model.DramaJobScript, status: model.DramaJobRunning},
	} {
		t.Run(test.name, func(t *testing.T) {
			fixture := newDramaGuideRevisionFixture(t, test.step)
			projectID := fixture.summary.Project.ID
			revision := fixture.summary.Production.Revision
			chapters, err := fixture.svc.repo.DramaChapters(projectID)
			if err != nil || len(chapters) != 1 {
				t.Fatalf("load chapters: %+v %v", chapters, err)
			}
			if err := fixture.svc.repo.CreateDramaJobs([]model.DramaJob{{
				ID: newID(), ProjectID: projectID, Kind: test.kind, Status: test.status,
			}}); err != nil {
				t.Fatal(err)
			}
			changed := "作业进行中的正文"
			_, err = fixture.svc.UpdateDramaChapter("usr-drama", projectID, chapters[0].ID, UpdateDramaChapterRequest{ExpectedRevision: &revision, Text: &changed})
			requireGuideConflict(t, err)
			stored, err := fixture.svc.repo.DramaChapters(projectID)
			if err != nil || len(stored) != 1 || stored[0].SourceText != chapters[0].SourceText {
				t.Fatalf("active text job must keep source: %+v %v", stored, err)
			}
			production, err := fixture.svc.repo.DramaProduction(projectID)
			if err != nil || production.Revision != revision || production.GuideStep != test.step {
				t.Fatalf("active text job must not advance production: %+v %v", production, err)
			}
		})
	}
}

func TestDramaChapterImpactListsCitingEpisodes(t *testing.T) {
	fixture := newDramaGuideRevisionFixture(t, model.DramaGuideCompleted)
	projectID := fixture.summary.Project.ID
	chapters, err := fixture.svc.repo.DramaChapters(projectID)
	if err != nil || len(chapters) != 1 {
		t.Fatalf("load chapters: %+v %v", chapters, err)
	}
	other := model.ProjectUnit{ID: newID(), ProjectID: projectID, Kind: model.ProjectUnitKindChapter, Title: "第二章", SourceText: "其他正文"}
	if err := fixture.fake.db.Create(&other).Error; err != nil {
		t.Fatal(err)
	}
	second := model.DramaEpisode{
		ID: newID(), ProjectID: projectID, Number: 2, Title: "第二集",
		ChapterIDsJSON: encodeStringList([]string{other.ID}), Stage: model.DramaEpisodeReview, Revision: 1,
	}
	if err := fixture.fake.db.Create(&second).Error; err != nil {
		t.Fatal(err)
	}

	impact, err := fixture.svc.DramaChapterImpact("usr-drama", projectID, chapters[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	if impact.ChapterID != chapters[0].ID || impact.Revision != fixture.summary.Production.Revision || impact.Message == "" || len(impact.Episodes) != 1 {
		t.Fatalf("impact = %+v", impact)
	}
	got := impact.Episodes[0]
	want := fixture.summary.Episodes[0]
	if got.ID != want.ID || got.Number != want.Number || got.Title != want.Title || got.Stage != want.Stage {
		t.Fatalf("citing episode = %+v, want %+v", got, want)
	}

	_, err = fixture.svc.DramaChapterImpact("usr-other", projectID, chapters[0].ID)
	if err == nil {
		t.Fatal("other user must not read chapter impact")
	}
	_, err = fixture.svc.DramaChapterImpact("usr-drama", projectID, newID())
	if err == nil {
		t.Fatal("missing chapter must fail")
	}
	orphan := model.ProjectUnit{ID: newID(), ProjectID: projectID, Kind: model.ProjectUnitKindChapter, Title: "预留章节", SourceText: "未加入制作"}
	if err := fixture.fake.db.Create(&orphan).Error; err != nil {
		t.Fatal(err)
	}
	empty, err := fixture.svc.DramaChapterImpact("usr-drama", projectID, orphan.ID)
	if err != nil || empty.Episodes == nil || len(empty.Episodes) != 0 {
		t.Fatalf("unreferenced source must return an empty list: %+v %v", empty, err)
	}
	orphan.Kind = "scene"
	if err := fixture.fake.db.Model(&orphan).Update("kind", orphan.Kind).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.svc.DramaChapterImpact("usr-drama", projectID, orphan.ID); err == nil {
		t.Fatal("non-chapter unit must not have chapter impact")
	}
}
