package app

import (
	"encoding/json"
	"errors"
	"testing"

	"gorm.io/gorm"
	"yingce/backend/internal/model"
)

func TestDramaCastDeleteDetachesReferencesAndPreservesPromptIdentity(t *testing.T) {
	f := newDramaGuideRevisionFixture(t, model.DramaGuideStory)
	db, svc := f.fake.db, f.svc
	projectID, episodeID := f.summary.Project.ID, f.shot.EpisodeID
	look := model.DramaCast{ID: "look", ProjectID: projectID, Kind: "character", ParentID: f.cast.ID, Name: "原角色", LookName: "雨衣", ImageResourceID: "historic-look"}
	prop := model.DramaCast{ID: "prop", ProjectID: projectID, Kind: "prop", Name: "雨伞"}
	mediaOnlyShot := model.DramaShot{ID: "media-only-shot", ProjectID: projectID, EpisodeID: episodeID, Position: 1}
	media := model.DramaShotMedia{ID: "image-slot", ProjectID: projectID, EpisodeID: episodeID, ShotID: mediaOnlyShot.ID, Kind: "image", ConfigJSON: `{"prompt":"@［镜头主体］","referenceResourceIds":["historic-look"],"referenceSubjects":{"historic-look":"look"}}`}
	for _, row := range []any{&look, &prop, &mediaOnlyShot, &media} {
		if err := db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Model(&f.shot).Updates(map[string]any{"cast_ids_json": encodeStringList([]string{f.cast.ID}), "look_cast_ids_json": `["look"]`, "prop_ids_json": `["prop"]`, "action": "原角色撑开雨伞"}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.DramaEpisode{}).Where("id = ?", episodeID).Update("asset_ids_json", encodeStringList([]string{f.cast.ID, look.ID, prop.ID})).Error; err != nil {
		t.Fatal(err)
	}
	prompt := "@参考图 01 持有参考图02，保留这一句剧情。"
	modelPrompt := "参考图2在参考图1的手中。"
	if err := db.Model(&f.segment).Updates(map[string]any{"reference_cast_ids_json": `["look","prop"]`, "video_prompt_override": prompt, "video_prompt": modelPrompt, "video_status": model.DramaMediaReady, "video_resource_id": "old-video"}).Error; err != nil {
		t.Fatal(err)
	}
	impact, err := svc.DramaCastImpact("usr-drama", projectID, f.cast.ID)
	if err != nil || impact.Shots != 2 || impact.Segments != 1 {
		t.Fatalf("impact must include the media-only shot: %+v, %v", impact, err)
	}
	revision := f.summary.Production.Revision
	if err := svc.DeleteDramaCast("usr-drama", projectID, f.cast.ID, DeleteDramaCastRequest{ExpectedRevision: &revision, DeleteScopeToken: impact.DeleteScopeToken}); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{f.cast.ID, look.ID} {
		if _, err := svc.repo.DramaCast(projectID, id); !errors.Is(err, gorm.ErrRecordNotFound) {
			t.Fatalf("deleted cast %s still present: %v", id, err)
		}
	}
	shot, err := svc.repo.DramaShot(projectID, f.shot.ID)
	if err != nil || shot.CastIDsJSON != "[]" || shot.LookCastIDsJSON != "[]" || shot.PropIDsJSON != `["prop"]` || shot.Action != "原角色撑开雨伞" {
		t.Fatalf("unexpected shot after detaching: %+v, %v", shot, err)
	}
	episode, err := svc.repo.DramaEpisode(projectID, episodeID)
	if err != nil || episode.AssetIDsJSON != `["prop"]` {
		t.Fatalf("episode still links deleted assets: %+v, %v", episode, err)
	}
	segment, err := svc.repo.DramaSegment(projectID, f.segment.ID)
	if err != nil || segment.VideoPromptOverride != prompt || segment.VideoPrompt != modelPrompt || segment.ReferenceCastIDsJSON != `["prop"]` || segment.VideoStatus != model.DramaMediaReady || segment.VideoResourceID != "old-video" || segment.VideoRevision != f.segment.VideoRevision+1 {
		t.Fatalf("segment was altered beyond asset associations: %+v, %v", segment, err)
	}
	remaining := []DramaSegmentReference{{CastID: prop.ID, Label: "参考图1", Name: prop.Name}}
	got := resolveDramaSegmentPromptForReferences(*segment, remaining, remaining)
	if got != "原角色·雨衣 持有雨伞（参考图1），保留这一句剧情。" {
		t.Fatalf("old labels attached to the wrong identity: %q", got)
	}
	segment.VideoPromptOverride = ""
	if got := resolveDramaSegmentPromptForReferences(*segment, remaining, remaining); got != "雨伞（参考图1）在原角色·雨衣的手中。" {
		t.Fatalf("the restored model prompt lost its original identities: %q", got)
	}
	stored, err := svc.repo.DramaShotMedia(projectID, mediaOnlyShot.ID, "image")
	var config DramaShotMediaConfig
	if err != nil || json.Unmarshal([]byte(stored.ConfigJSON), &config) != nil || len(config.ReferenceSubjects) != 0 || len(config.ReferenceResourceIDs) != 1 || config.ReferenceResourceIDs[0] != look.ImageResourceID || config.Prompt != "@［镜头主体］" {
		t.Fatalf("pinned image or script lost: %+v, %v", stored, err)
	}
	takes, err := svc.repo.DramaTakes(projectID, look.ID, "cast", 10)
	if err != nil || len(takes) != 1 || takes[0].ResourceID != look.ImageResourceID {
		t.Fatalf("deleted look image not kept in history: %+v, %v", takes, err)
	}
}

func reviewedDramaCastDeletion(t *testing.T, svc *Service, projectID, castID string) DeleteDramaCastRequest {
	t.Helper()
	view, err := svc.DramaCastImpact("usr-drama", projectID, castID)
	if err != nil || view.DeleteScopeToken == "" {
		t.Fatalf("deletion impact = %+v: %v", view, err)
	}
	return DeleteDramaCastRequest{ExpectedRevision: &view.Revision, DeleteScopeToken: view.DeleteScopeToken}
}

func TestDramaCastDeleteRejectsNewShotMediaBindingAfterReview(t *testing.T) {
	f := newDramaGuideRevisionFixture(t, model.DramaGuideStory)
	projectID, shot := f.summary.Project.ID, f.shot
	request := reviewedDramaCastDeletion(t, f.svc, projectID, f.cast.ID)
	media := model.DramaShotMedia{ID: "new-binding", ProjectID: projectID, EpisodeID: shot.EpisodeID, ShotID: shot.ID, Kind: "video"}
	config, err := json.Marshal(DramaShotMediaConfig{ReferenceResourceIDs: []string{"first-image"}, ReferenceSubjects: map[string]string{"first-image": f.cast.ID}})
	if err != nil {
		t.Fatal(err)
	}
	media.ConfigJSON = string(config)
	if err := f.fake.db.Create(&media).Error; err != nil {
		t.Fatal(err)
	}
	err = f.svc.DeleteDramaCast("usr-drama", projectID, f.cast.ID, request)
	var conflict *AppError
	if !errors.As(err, &conflict) || conflict.Reason != "drama_cast_delete_scope_changed" {
		t.Fatalf("stale impact error = %+v", err)
	}
	stored, err := f.svc.repo.DramaShotMedia(projectID, shot.ID, media.Kind)
	if err != nil || stored.ConfigJSON != media.ConfigJSON {
		t.Fatalf("unreviewed binding was detached: %+v, %v", stored, err)
	}
	if _, err := f.svc.repo.DramaCast(projectID, f.cast.ID); err != nil {
		t.Fatalf("asset was deleted after conflict: %v", err)
	}
	fresh := reviewedDramaCastDeletion(t, f.svc, projectID, f.cast.ID)
	if *fresh.ExpectedRevision != *request.ExpectedRevision || fresh.DeleteScopeToken == request.DeleteScopeToken {
		t.Fatalf("shot media changes must invalidate the reviewed scope without changing the production version")
	}
	if err := f.svc.DeleteDramaCast("usr-drama", projectID, f.cast.ID, fresh); err != nil {
		t.Fatalf("delete after review: %v", err)
	}
}
