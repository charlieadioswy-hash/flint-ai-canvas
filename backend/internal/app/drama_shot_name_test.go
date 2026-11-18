package app

import (
	"strings"
	"testing"

	"yingce/backend/internal/model"
)

func TestDramaShotRenamePreservesAdoptedMediaAndSegmentPrompt(t *testing.T) {
	f := newDramaGuideRevisionFixture(t, model.DramaGuideStory)
	projectID := f.summary.Project.ID
	revision := f.summary.Production.Revision
	media := model.DramaShotMedia{
		ID: newID(), ProjectID: projectID, EpisodeID: f.shot.EpisodeID, ShotID: f.shot.ID, Kind: "image",
		Status: model.DramaMediaReady, Revision: 4, ResourceID: "adopted-image", ScriptHash: dramaShotScriptHash(f.shot), ConfigJSON: `{}`,
	}
	if err := f.fake.db.Create(&media).Error; err != nil {
		t.Fatal(err)
	}

	name := "  初见 · 夜外  "
	renamed, err := f.svc.UpdateDramaShot("usr-drama", projectID, f.shot.ID, UpdateDramaShotRequest{ExpectedRevision: &revision, Name: &name})
	if err != nil || renamed.Name != "初见 · 夜外" {
		t.Fatalf("rename shot: %+v, %v", renamed, err)
	}
	detail, err := f.svc.DramaEpisodeDetail("usr-drama", projectID, f.shot.EpisodeID)
	if err != nil || len(detail.Shots) != 1 || detail.Shots[0].Name != renamed.Name || detail.Episode.Revision != f.summary.Episodes[0].Revision {
		t.Fatalf("reloaded name and episode: %+v, %v", detail, err)
	}
	segments, err := f.svc.repo.DramaSegments(f.shot.EpisodeID)
	if err != nil || len(segments) != 1 || segments[0].Revision != f.segment.Revision || segments[0].PromptStatus != f.segment.PromptStatus || segments[0].VideoPromptOverride != f.segment.VideoPromptOverride {
		t.Fatalf("rename changed segment prompt: %+v, %v", segments, err)
	}
	view, err := f.svc.DramaShotMedia("usr-drama", projectID, f.shot.ID, "image")
	if err != nil || view.Status != model.DramaMediaReady || view.Revision != media.Revision || view.ResourceID != media.ResourceID || dramaShotScriptHash(detail.Shots[0]) != media.ScriptHash {
		t.Fatalf("rename changed adopted image or its script fingerprint: %+v, %v", view, err)
	}
	production, err := f.svc.repo.DramaProduction(projectID)
	if err != nil || production.GuideStep != model.DramaGuideStory || production.Revision != revision+1 || len(f.fake.requests) != 0 {
		t.Fatalf("rename changed workflow or missed project revision: %+v, %v", production, err)
	}

	reset := " "
	_, err = f.svc.UpdateDramaShot("usr-drama", projectID, f.shot.ID, UpdateDramaShotRequest{ExpectedRevision: &revision, Name: &reset})
	requireGuideConflict(t, err)
	oversized := strings.Repeat("镜", 121)
	if _, err := f.svc.UpdateDramaShot("usr-drama", projectID, f.shot.ID, UpdateDramaShotRequest{ExpectedRevision: &production.Revision, Name: &oversized}); err == nil {
		t.Fatal("oversized shot name was accepted")
	}
	cleared, err := f.svc.UpdateDramaShot("usr-drama", projectID, f.shot.ID, UpdateDramaShotRequest{ExpectedRevision: &production.Revision, Name: &reset})
	if err != nil || cleared.Name != "" {
		t.Fatalf("reset to default title: %+v, %v", cleared, err)
	}
}
