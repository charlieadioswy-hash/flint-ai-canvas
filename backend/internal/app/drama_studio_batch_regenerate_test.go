package app

import (
	"reflect"
	"testing"

	"yingce/backend/internal/model"
)

func TestDramaStudioBatchRegenerateUsesExactTargetsAndRestylesOnlyQueuedAssets(t *testing.T) {
	svc, fake, projectID, detail := dramaStudioFixture(t)
	casts, _ := svc.repo.DramaCasts(projectID)
	base, locked := casts[0], casts[1]
	resourceID := fake.resource("usr-drama", "image", "image/png")
	for _, cast := range []model.DramaCast{base, locked} {
		if err := svc.repo.UpdateDramaCastFields(cast.ID, map[string]any{"image_status": model.DramaMediaReady, "image_resource_id": resourceID, "locked": cast.ID == locked.ID}); err != nil {
			t.Fatal(err)
		}
	}
	look := model.DramaCast{ID: newID(), ProjectID: projectID, ParentID: base.ID, Kind: "character", Name: base.Name, LookName: "选中造型", Appearance: "黑衣", ImageStatus: model.DramaMediaFailed, Revision: 1}
	unselected := model.DramaCast{ID: newID(), ProjectID: projectID, ParentID: base.ID, Kind: "character", Name: base.Name, LookName: "未选造型", Appearance: "白衣", ImageStatus: model.DramaMediaFailed, Revision: 1}
	for _, row := range []*model.DramaCast{&look, &unselected} {
		if err := fake.db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	// 第一段只引用被锁定主体，第二段引用本次实际重做的主体；清空自动提取引用，避免夹带其它资产。
	if err := fake.db.Model(&model.DramaShot{}).Where("project_id = ?", projectID).Updates(map[string]any{"cast_ids_json": "[]", "prop_ids_json": "[]", "look_cast_ids_json": "[]", "scene_cast_id": ""}).Error; err != nil {
		t.Fatal(err)
	}
	setDramaStudioAssetReferences(t, fake, detail.Segments[0].ID, locked.ID)
	setDramaStudioAssetReferences(t, fake, detail.Segments[1].ID, base.ID)
	for _, segment := range detail.Segments {
		if err := fake.db.Model(&model.DramaSegment{}).Where("id = ?", segment.ID).Updates(map[string]any{"video_status": model.DramaMediaReady, "video_resource_id": "keep-" + segment.ID}).Error; err != nil {
			t.Fatal(err)
		}
	}
	req := DramaStudioBatchRequest{Action: "cast_image", TargetIDs: []string{base.ID, look.ID, locked.ID}}
	ordinary, err := svc.PreflightDramaStudioBatch("usr-drama", projectID, req)
	if err != nil || ordinary.Counts["skipped_ready"] != 2 || ordinary.Counts["ready"] != 1 {
		t.Fatalf("ordinary batch must preserve existing images: %+v %v", ordinary, err)
	}
	req.Regenerate, req.RestyleSegments = true, true
	view, err := svc.PreflightDramaStudioBatch("usr-drama", projectID, req)
	if err != nil || view.Counts["ready"] != 2 || view.Counts["blocked"] != 1 {
		t.Fatalf("regenerate must still honor locks and exact selection: %+v %v", view, err)
	}
	req.BaseRevision, req.ConfirmationToken = &view.BaseRevision, view.ConfirmationToken
	result, err := svc.ExecuteDramaStudioBatch("usr-drama", projectID, req)
	if err != nil || result.Counts["queued"] != 2 || result.Counts["blocked"] != 1 {
		t.Fatalf("exact regenerate batch: %+v %v", result, err)
	}
	for _, id := range []string{base.ID, look.ID} {
		stored, _ := svc.repo.DramaCast(projectID, id)
		if stored.ImageStatus != model.DramaMediaQueued {
			t.Fatalf("selected image was not queued: %+v", stored)
		}
	}
	storedLocked, _ := svc.repo.DramaCast(projectID, locked.ID)
	storedUnselected, _ := svc.repo.DramaCast(projectID, unselected.ID)
	first, _ := svc.repo.DramaSegment(projectID, detail.Segments[0].ID)
	second, _ := svc.repo.DramaSegment(projectID, detail.Segments[1].ID)
	if storedLocked.ImageStatus != model.DramaMediaReady || storedLocked.ImageResourceID != resourceID || storedUnselected.ImageStatus != model.DramaMediaFailed || first.VideoStatus != model.DramaMediaReady || second.VideoStatus != model.DramaMediaStale || second.VideoResourceID != "keep-"+second.ID {
		t.Fatalf("regenerate expanded scope or lost existing media: locked=%+v unselected=%+v first=%+v second=%+v", storedLocked, storedUnselected, first, second)
	}
	if fake.byKind["image"] != 0 || fake.byKind["video"] != 0 {
		t.Fatal("batch admission directly generated media")
	}
}

func TestDramaStudioBatchRegenerateFlagsArePartOfConfirmation(t *testing.T) {
	svc, _, projectID, _ := dramaStudioFixture(t)
	casts, _ := svc.repo.DramaCasts(projectID)
	view, err := svc.PreflightDramaStudioBatch("usr-drama", projectID, DramaStudioBatchRequest{Action: "cast_image", TargetIDs: []string{casts[0].ID}})
	if err != nil || !view.Ready {
		t.Fatalf("preflight: %+v %v", view, err)
	}
	for _, flag := range []string{"regenerate", "restyleSegments"} {
		req := confirmedDramaStudioBatch(view)
		req.Regenerate, req.RestyleSegments = flag == "regenerate", flag == "restyleSegments"
		result, err := svc.ExecuteDramaStudioBatch("usr-drama", projectID, req)
		if !isAppErrorStatus(err, 409) || result.Counts["queued"] != 0 {
			t.Fatalf("changed %s accepted stale quote: %+v %v", flag, result, err)
		}
	}
	stored, _ := svc.repo.DramaCast(projectID, casts[0].ID)
	if stored.ImageStatus == model.DramaMediaQueued {
		t.Fatal("changed flags partially enqueued an image")
	}
}

func TestDramaStudioBatchCastDraftQuotesAreReadOnlyAndCannotExecute(t *testing.T) {
	svc, fake, projectID, detail := dramaStudioFixture(t)
	casts, _ := svc.repo.DramaCasts(projectID)
	before, _ := svc.repo.DramaCast(projectID, casts[0].ID)
	pBefore, _ := svc.repo.DramaProduction(projectID)
	appearance := "尚未保存的批量图片草稿"
	req := DramaStudioBatchRequest{Action: "cast_image", TargetIDs: []string{before.ID}, EpisodeID: detail.Episode.ID, CastDrafts: map[string]DramaStudioCastDraft{before.ID: {Appearance: &appearance}}}
	view, err := svc.PreflightDramaStudioBatch("usr-drama", projectID, req)
	if err != nil || !view.Ready || len(view.Items) != 1 || view.Items[0].EpisodeID != detail.Episode.ID {
		t.Fatalf("draft batch quote: %+v %v", view, err)
	}
	after, _ := svc.repo.DramaCast(projectID, before.ID)
	pAfter, _ := svc.repo.DramaProduction(projectID)
	if !reflect.DeepEqual(before, after) || !reflect.DeepEqual(pBefore, pAfter) || fake.byKind["image"] != 0 {
		t.Fatal("draft batch quote persisted or generated media")
	}
	req.BaseRevision, req.ConfirmationToken = &view.BaseRevision, view.ConfirmationToken
	if _, err := svc.ExecuteDramaStudioBatch("usr-drama", projectID, req); !isAppErrorStatus(err, 400) {
		t.Fatalf("unsaved draft batch accepted for execution: %v", err)
	}
	req.CastDrafts = map[string]DramaStudioCastDraft{"unselected": {Appearance: &appearance}}
	if _, err := svc.PreflightDramaStudioBatch("usr-drama", projectID, req); !isAppErrorStatus(err, 400) {
		t.Fatalf("draft outside explicit target scope accepted: %v", err)
	}
	for _, invalid := range []DramaStudioBatchRequest{
		{Action: "segment_video", TargetIDs: []string{detail.Segments[0].ID}, Regenerate: true},
		{Action: "segment_prompt", TargetIDs: []string{detail.Segments[0].ID}, RestyleSegments: true},
		{Action: "segment_assets", TargetIDs: []string{detail.Segments[0].ID}, CastDrafts: map[string]DramaStudioCastDraft{detail.Segments[0].ID: {}}},
	} {
		if _, err := svc.PreflightDramaStudioBatch("usr-drama", projectID, invalid); !isAppErrorStatus(err, 400) {
			t.Fatalf("cast-only batch fields accepted: %+v %v", invalid, err)
		}
	}
}

func TestDramaStudioBatchRestyleFailureRollsBackImageQueueAndVideos(t *testing.T) {
	svc, fake, projectID, detail := dramaStudioFixture(t)
	casts, _ := svc.repo.DramaCasts(projectID)
	setDramaStudioAssetReferences(t, fake, detail.Segments[0].ID, casts[0].ID)
	if err := fake.db.Model(&model.DramaSegment{}).Where("id = ?", detail.Segments[0].ID).Updates(map[string]any{"video_status": model.DramaMediaReady, "video_resource_id": "keep-existing-video"}).Error; err != nil {
		t.Fatal(err)
	}
	req := DramaStudioBatchRequest{Action: "cast_image", TargetIDs: []string{casts[0].ID}, Regenerate: true, RestyleSegments: true}
	view, err := svc.PreflightDramaStudioBatch("usr-drama", projectID, req)
	if err != nil || !view.Ready {
		t.Fatalf("preflight: %+v %v", view, err)
	}
	if err := fake.db.Exec("CREATE TRIGGER fail_studio_restyle BEFORE UPDATE OF video_status ON drama_segments WHEN NEW.id = '" + detail.Segments[0].ID + "' BEGIN SELECT RAISE(ABORT, 'test restyle rollback'); END").Error; err != nil {
		t.Fatal(err)
	}
	req.BaseRevision, req.ConfirmationToken = &view.BaseRevision, view.ConfirmationToken
	result, err := svc.ExecuteDramaStudioBatch("usr-drama", projectID, req)
	if err == nil || result.Counts["queued"] != 0 {
		t.Fatalf("failed restyle must roll back all writes: %+v %v", result, err)
	}
	cast, _ := svc.repo.DramaCast(projectID, casts[0].ID)
	segment, _ := svc.repo.DramaSegment(projectID, detail.Segments[0].ID)
	p, _ := svc.repo.DramaProduction(projectID)
	if cast.ImageStatus == model.DramaMediaQueued || segment.VideoStatus != model.DramaMediaReady || segment.VideoResourceID != "keep-existing-video" || p.MediaRequestsOnly || fake.byKind["image"] != 0 {
		t.Fatalf("failed restyle leaked image or video changes: cast=%+v segment=%+v production=%+v", cast, segment, p)
	}
}

func TestDramaStudioBatchReportsNewOutputVersionForRegenerateRecovery(t *testing.T) {
	svc, fake, projectID, _ := dramaStudioFixture(t)
	casts, _ := svc.repo.DramaCasts(projectID)
	cast := casts[0]
	oldResource := fake.resource("usr-drama", "image", "image/png")
	if err := svc.repo.UpdateDramaCastFields(cast.ID, map[string]any{"image_status": model.DramaMediaReady, "image_resource_id": oldResource, "image_version": 3}); err != nil {
		t.Fatal(err)
	}
	req := DramaStudioBatchRequest{Action: "cast_image", TargetIDs: []string{cast.ID}, Regenerate: true}
	before, err := svc.PreflightDramaStudioBatch("usr-drama", projectID, req)
	if err != nil || !before.Ready || len(before.Items) != 1 || before.Items[0].ResultVersion == nil || *before.Items[0].ResultVersion != 3 || before.Items[0].ResultResourceID != oldResource {
		t.Fatalf("regenerate quote must expose current output: %+v %v", before, err)
	}
	confirmed := req
	confirmed.BaseRevision, confirmed.ConfirmationToken = &before.BaseRevision, before.ConfirmationToken
	if _, err := svc.ExecuteDramaStudioBatch("usr-drama", projectID, confirmed); err != nil {
		t.Fatal(err)
	}
	runDramaTicks(t, svc, projectID, 6)
	after, err := svc.PreflightDramaStudioBatch("usr-drama", projectID, req)
	if err != nil || len(after.Items) != 1 || after.Items[0].Status != "ready" || after.Items[0].ResultVersion == nil || *after.Items[0].ResultVersion <= *before.Items[0].ResultVersion || after.Items[0].ResultResourceID == "" || after.Items[0].ResultResourceID == oldResource || after.ScopeHash != before.ScopeHash {
		t.Fatalf("completed regenerate must expose a newer result without changing generation scope: before=%+v after=%+v %v", before, after, err)
	}
	if fake.byKind["image"] != 1 || fake.byKind["video"] != 0 {
		t.Fatalf("output recovery must only read the completed generation: %v", fake.byKind)
	}
}
