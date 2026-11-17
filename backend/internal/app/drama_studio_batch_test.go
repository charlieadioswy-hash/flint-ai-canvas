package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"yingce/backend/internal/model"
)

func confirmedDramaStudioBatch(view DramaStudioBatchView) DramaStudioBatchRequest {
	return DramaStudioBatchRequest{Action: view.Action, TargetIDs: view.TargetIDs, BaseRevision: &view.BaseRevision, ConfirmationToken: view.ConfirmationToken}
}

func TestDramaStudioBatchQueuesOnlyReadySelectedAssets(t *testing.T) {
	svc, fake, projectID, _ := dramaStudioFixture(t)
	casts, _ := svc.repo.DramaCasts(projectID)
	ready, queued, blocked, requested := casts[0], casts[1], casts[2], casts[3]
	resourceID := fake.resource("usr-drama", "image", "image/png")
	if err := svc.repo.UpdateDramaCastFields(ready.ID, map[string]any{"image_status": model.DramaMediaReady, "image_resource_id": resourceID}); err != nil {
		t.Fatal(err)
	}
	if err := svc.repo.UpdateDramaCastFields(queued.ID, map[string]any{"image_status": model.DramaMediaQueued}); err != nil {
		t.Fatal(err)
	}
	if err := svc.repo.UpdateDramaCastFields(blocked.ID, map[string]any{"locked": true}); err != nil {
		t.Fatal(err)
	}
	req := DramaStudioBatchRequest{Action: "cast_image", TargetIDs: []string{ready.ID, queued.ID, blocked.ID, requested.ID, requested.ID, "foreign-target"}}
	view, err := svc.PreflightDramaStudioBatch("usr-drama", projectID, req)
	if err != nil || !view.Ready || len(view.TargetIDs) != 5 || len(view.Items) != 5 || view.Counts["ready"] != 1 || view.Counts["skipped_ready"] != 1 || view.Counts["already_queued"] != 1 || view.Counts["blocked"] != 1 || view.Counts["failed"] != 1 {
		t.Fatalf("preflight must classify exact unique targets: %+v %v", view, err)
	}
	if fake.byKind["image"] != 0 || fake.byKind["video"] != 0 {
		t.Fatal("preflight generated media")
	}
	result, err := svc.ExecuteDramaStudioBatch("usr-drama", projectID, confirmedDramaStudioBatch(view))
	if err != nil || result.Counts["queued"] != 1 || result.Counts["blocked"] != 1 || result.Counts["failed"] != 1 {
		t.Fatalf("only ready item should queue: %+v %v", result, err)
	}
	savedReady, _ := svc.repo.DramaCast(projectID, ready.ID)
	savedBlocked, _ := svc.repo.DramaCast(projectID, blocked.ID)
	savedRequested, _ := svc.repo.DramaCast(projectID, requested.ID)
	if savedReady.ImageResourceID != resourceID || savedReady.ImageStatus != model.DramaMediaReady || savedBlocked.ImageStatus == model.DramaMediaQueued || savedRequested.ImageStatus != model.DramaMediaQueued {
		t.Fatalf("batch changed unrequested/blocked/successful media: %+v %+v %+v", savedReady, savedBlocked, savedRequested)
	}
	replay, err := svc.ExecuteDramaStudioBatch("usr-drama", projectID, confirmedDramaStudioBatch(view))
	var replayErr *AppError
	if !errors.As(err, &replayErr) || replayErr.Status != 409 || replay.Counts["queued"] != 0 || replay.Counts["already_queued"] != 2 {
		t.Fatalf("mixed blockers require fresh review while queued targets remain skipped: %+v %v", replay, err)
	}
	// 原本排队项也会继续；新增请求仍只有一张，不把旧成功图片重做。
	runDramaTicks(t, svc, projectID, 8)
	if fake.byKind["image"] != 2 || fake.byKind["video"] != 0 {
		t.Fatalf("scope expanded or successful target regenerated: %v", fake.byKind)
	}
}

func TestDramaStudioBatchCrossEpisodeVideoDoesNotInvalidateItsOwnToken(t *testing.T) {
	svc, fake, projectID, first := dramaStudioFixture(t)
	summary, _ := svc.DramaSummary("usr-drama", projectID)
	if len(summary.Episodes) < 2 {
		t.Fatal("fixture needs two episodes")
	}
	second, err := svc.DramaEpisodeDetail("usr-drama", projectID, summary.Episodes[1].ID)
	if err != nil {
		t.Fatal(err)
	}
	ids := []string{first.Segments[0].ID, second.Segments[0].ID, first.Segments[0].ID}
	view, err := svc.PreflightDramaStudioBatch("usr-drama", projectID, DramaStudioBatchRequest{Action: "segment_video", TargetIDs: ids})
	if err != nil || view.Counts["ready"] != 2 {
		t.Fatalf("cross episode preflight: %+v %v", view, err)
	}
	p, _ := svc.repo.DramaProduction(projectID)
	if p.MediaRequestsOnly {
		t.Fatal("fixture should exercise false-to-true scope restriction")
	}
	result, err := svc.ExecuteDramaStudioBatch("usr-drama", projectID, confirmedDramaStudioBatch(view))
	if err != nil || result.Counts["queued"] != 2 {
		t.Fatalf("all plans must validate before first scope mutation: %+v %v", result, err)
	}
	runDramaTicks(t, svc, projectID, 10)
	if fake.byKind["video"] != 2 || fake.byKind["image"] != 0 || fake.byKind["render"] != 0 {
		t.Fatalf("batch scope expanded: %v", fake.byKind)
	}
	for _, detail := range []DramaEpisodeDetail{first, second} {
		unselected, _ := svc.repo.DramaSegment(projectID, detail.Segments[1].ID)
		if unselected.VideoStatus != "" {
			t.Fatalf("unselected segment released: %+v", unselected)
		}
	}
	replay, err := svc.ExecuteDramaStudioBatch("usr-drama", projectID, confirmedDramaStudioBatch(view))
	if err != nil || replay.Counts["queued"] != 0 || replay.Counts["skipped_ready"] != 2 {
		t.Fatalf("successful videos must not regenerate on replay: %+v %v", replay, err)
	}
}

func dramaStudioBatchTailFixture(t *testing.T) (*Service, *fakeDramaBackend, string, []model.DramaSegment) {
	t.Helper()
	svc, fake, projectID, detail := dramaStudioFixture(t)
	segments, err := svc.repo.DramaSegments(detail.Episode.ID)
	if err != nil || len(segments) != 2 {
		t.Fatalf("fixture segments: %+v %v", segments, err)
	}
	shots, err := svc.repo.DramaShots(detail.Episode.ID)
	if err != nil || len(shots) != 2 {
		t.Fatalf("fixture shots: %+v %v", shots, err)
	}
	for i := 2; i < 4; i++ {
		segment, shot := segments[i-2], shots[i-2]
		segment.ID, segment.SegmentIndex = fmt.Sprintf("batch-tail-segment-%d", i), i
		shot.ID, shot.SegmentIndex, shot.Position = fmt.Sprintf("batch-tail-shot-%d", i), i, i
		if err := fake.db.Create(&segment).Error; err != nil {
			t.Fatal(err)
		}
		if err := fake.db.Create(&shot).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err := fake.db.Model(&model.DramaSegment{}).Where("episode_id = ?", detail.Episode.ID).Update("reference_cast_ids_json", "[]").Error; err != nil {
		t.Fatal(err)
	}
	image := fake.resource("usr-drama", "image", "image/png")
	refs, _ := json.Marshal([]model.DramaReferenceImage{{ResourceID: image, Name: "首段参考图"}})
	if err := fake.db.Model(&model.DramaSegment{}).Where("id = ?", segments[0].ID).Update("reference_images_json", string(refs)).Error; err != nil {
		t.Fatal(err)
	}
	capability := dramaVideoFixture()
	capability.References.MinImages = 1
	setDramaVideoCapability(t, svc, fake, capability)
	for _, row := range []any{
		&model.ModelChannel{ID: "ch", Scope: model.ChannelScopeSystem, Enabled: true},
		&model.ChannelModelPriceTier{ID: "batch-tail-video-price", ChannelModelID: "drama-video", SelectorKey: "{}", SelectorJSON: "{}", BillingMode: "fixed_request", UnitPriceMicrocredits: 100, PriceConfigured: true, Enabled: true},
		&model.CreditAccount{UserID: "usr-drama", AvailableMicrocredits: 1000},
	} {
		if err := fake.db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	segments, err = svc.repo.DramaSegments(detail.Episode.ID)
	if err != nil {
		t.Fatal(err)
	}
	return svc, fake, projectID, segments
}

func TestDramaStudioBatchTailVideosQuotesAndQueuesWholeSelectedChain(t *testing.T) {
	for _, scenario := range []string{"four_fixed_requests", "different_models_and_durations", "failed_with_previous_results"} {
		t.Run(scenario, func(t *testing.T) {
			svc, fake, projectID, segments := dramaStudioBatchTailFixture(t)
			wantAmount := int64(400)
			if scenario == "failed_with_previous_results" {
				for _, segment := range segments {
					if err := fake.db.Model(&model.DramaSegment{}).Where("id = ?", segment.ID).Updates(map[string]any{"video_status": model.DramaMediaFailed, "video_resource_id": fake.resource("usr-drama", "video", "video/mp4"), "tail_frame_resource_id": fake.resource("usr-drama", "image", "image/png")}).Error; err != nil {
						t.Fatal(err)
					}
				}
			}
			if scenario == "different_models_and_durations" {
				if err := fake.db.Model(&model.ChannelModelPriceTier{}).Where("id = ?", "batch-tail-video-price").Updates(map[string]any{"billing_mode": "per_second", "unit_price_microcredits": 10}).Error; err != nil {
					t.Fatal(err)
				}
				capability := dramaVideoFixture()
				capability.References.MinImages = 1
				profile, _ := json.Marshal(&ModelCapabilityConfig{Version: 1, Video: &capability})
				for _, row := range []any{
					&model.ChannelModel{ID: "batch-tail-alternate", ChannelID: "ch", ModelKey: "alternate-video", Capability: "video", Protocol: model.ChannelInterfaceVolcengineArkVideo, Enabled: true, CapabilityConfigJSON: string(profile)},
					&model.ChannelModelPriceTier{ID: "batch-tail-alternate-price", ChannelModelID: "batch-tail-alternate", SelectorKey: "{}", SelectorJSON: "{}", BillingMode: "per_second", UnitPriceMicrocredits: 20, PriceConfigured: true, Enabled: true},
				} {
					if err := fake.db.Create(row).Error; err != nil {
						t.Fatal(err)
					}
				}
				choice, _ := json.Marshal(DramaModelChoice{ChannelID: "ch", ModelKey: "alternate-video"})
				if err := fake.db.Model(&model.DramaSegment{}).Where("id IN ?", []string{segments[1].ID, segments[3].ID}).Update("video_model_json", string(choice)).Error; err != nil {
					t.Fatal(err)
				}
				if err := fake.db.Model(&model.DramaShot{}).Where("episode_id = ? AND segment_index IN ?", segments[0].EpisodeID, []int{1, 3}).Update("duration_ms", 8000).Error; err != nil {
					t.Fatal(err)
				}
				if err := fake.db.Model(&model.DramaSegment{}).Where("id IN ?", []string{segments[1].ID, segments[3].ID}).Update("prompt_seconds", 10).Error; err != nil {
					t.Fatal(err)
				}
				wantAmount = 500 // 5s×10 + 10s×20 + 5s×10 + 10s×20。
			}
			ids := []string{segments[3].ID, segments[1].ID, segments[0].ID, segments[2].ID}
			view, err := svc.PreflightDramaStudioBatch("usr-drama", projectID, DramaStudioBatchRequest{Action: "segment_video", TargetIDs: ids})
			if err != nil || !view.Ready || !view.Priced || view.Counts["ready"] != 4 || view.AmountMicrocredits != wantAmount {
				t.Fatalf("all selected tail-dependent videos must be quoted: %+v %v", view, err)
			}
			if fake.byKind["video"] != 0 || fake.byKind["image"] != 0 {
				t.Fatal("preflight generated media")
			}
			result, err := svc.ExecuteDramaStudioBatch("usr-drama", projectID, confirmedDramaStudioBatch(view))
			if err != nil || result.Counts["queued"] != 4 || result.AmountMicrocredits != wantAmount {
				t.Fatalf("whole selected chain must queue: %+v %v", result, err)
			}
			replay, err := svc.ExecuteDramaStudioBatch("usr-drama", projectID, confirmedDramaStudioBatch(view))
			if err != nil || replay.Counts["queued"] != 0 || replay.Counts["already_queued"] != 4 {
				t.Fatalf("repeated request must not enqueue twice: %+v %v", replay, err)
			}
			for _, segment := range segments {
				stored, _ := svc.repo.DramaSegment(projectID, segment.ID)
				if stored.VideoStatus != model.DramaMediaQueued {
					t.Fatalf("continuity invalidation lost a selected request: %+v", stored)
				}
			}
			fake.fail = func(req CreateTaskRequest) bool {
				if req.Type == "canvas_video" && fake.byKind["video"] > 0 {
					previous, _ := svc.repo.DramaSegment(projectID, segments[fake.byKind["video"]-1].ID)
					if !dramaSegmentVideoDone(*previous) {
						t.Fatalf("next segment dispatched before preceding tail was ready: %+v", previous)
					}
				}
				return false
			}
			runDramaTicks(t, svc, projectID, 18)
			requests := dramaVideoRequests(fake)
			if len(requests) != 4 || fake.byKind["image"] != 0 || fake.byKind["render"] != 0 {
				t.Fatalf("selected chain scope changed: %v", fake.byKind)
			}
			for i, before := range segments {
				stored, _ := svc.repo.DramaSegment(projectID, before.ID)
				if !dramaSegmentVideoDone(*stored) {
					t.Fatalf("segment %d did not complete in order: %+v", i, stored)
				}
				metadata := requests[i].Input["metadata"].(map[string]any)
				if i > 0 && (metadata["videoEditOperation"] != "image_to_video" || metadata["videoStartFrameNodeId"] != "first-frame") {
					t.Fatalf("segment %d lost tail dependency: %+v", i, requests[i])
				}
			}
		})
	}
}

func TestDramaStudioBatchTailVideosKeepUnselectedAndBlockedDependenciesBlocked(t *testing.T) {
	for _, blocker := range []string{"unselected_first", "blocked_middle"} {
		t.Run(blocker, func(t *testing.T) {
			svc, fake, projectID, segments := dramaStudioBatchTailFixture(t)
			ids := []string{segments[1].ID, segments[2].ID, segments[3].ID}
			wantReady, wantBlocked, wantAmount := 0, 3, int64(0)
			if blocker == "blocked_middle" {
				ids = append(ids, segments[0].ID)
				if err := fake.db.Model(&model.DramaSegment{}).Where("id = ?", segments[1].ID).Updates(map[string]any{"prompt_status": model.DramaMediaFailed, "video_prompt": ""}).Error; err != nil {
					t.Fatal(err)
				}
				wantReady, wantAmount = 1, 100
			}
			view, err := svc.PreflightDramaStudioBatch("usr-drama", projectID, DramaStudioBatchRequest{Action: "segment_video", TargetIDs: ids})
			if err != nil || view.Counts["ready"] != wantReady || view.Counts["blocked"] != wantBlocked || view.AmountMicrocredits != wantAmount {
				t.Fatalf("broken dependency must block its descendants: %+v %v", view, err)
			}
			result, err := svc.ExecuteDramaStudioBatch("usr-drama", projectID, confirmedDramaStudioBatch(view))
			if err != nil || result.Counts["queued"] != wantReady || result.Counts["blocked"] != wantBlocked {
				t.Fatalf("blocked descendants were requested: %+v %v", result, err)
			}
			for _, segment := range segments[1:] {
				stored, _ := svc.repo.DramaSegment(projectID, segment.ID)
				if mediaBusyStatus(stored.VideoStatus) {
					t.Fatalf("unavailable dependency released video: %+v", stored)
				}
			}
		})
	}
}

func TestDramaStudioBatchTailRetryDoesNotStrandVideosAfterSkippedSuccessfulDependency(t *testing.T) {
	for _, selectMiddle := range []bool{false, true} {
		t.Run(fmt.Sprintf("select_successful_middle_%t", selectMiddle), func(t *testing.T) {
			svc, fake, projectID, segments := dramaStudioBatchTailFixture(t)
			if err := fake.db.Model(&model.DramaSegment{}).Where("id = ?", segments[0].ID).Updates(map[string]any{"video_status": model.DramaMediaFailed, "video_resource_id": fake.resource("usr-drama", "video", "video/mp4")}).Error; err != nil {
				t.Fatal(err)
			}
			if err := fake.db.Model(&model.DramaSegment{}).Where("id = ?", segments[1].ID).Updates(map[string]any{"video_status": model.DramaMediaReady, "video_resource_id": fake.resource("usr-drama", "video", "video/mp4"), "tail_frame_resource_id": fake.resource("usr-drama", "image", "image/png")}).Error; err != nil {
				t.Fatal(err)
			}
			ids := []string{segments[0].ID, segments[2].ID, segments[3].ID}
			if selectMiddle {
				ids = append(ids, segments[1].ID)
			}
			view, err := svc.PreflightDramaStudioBatch("usr-drama", projectID, DramaStudioBatchRequest{Action: "segment_video", TargetIDs: ids})
			if err != nil || view.Counts["ready"] != 1 || view.Counts["blocked"] != 2 || view.AmountMicrocredits != 100 || selectMiddle && view.Counts["skipped_ready"] != 1 {
				t.Fatalf("a skipped old tail cannot satisfy a chain invalidated by this batch: %+v %v", view, err)
			}
			result, err := svc.ExecuteDramaStudioBatch("usr-drama", projectID, confirmedDramaStudioBatch(view))
			if err != nil || result.Counts["queued"] != 1 || result.Counts["blocked"] != 2 {
				t.Fatalf("batch queued stranded descendants: %+v %v", result, err)
			}
			runDramaTicks(t, svc, projectID, 8)
			if fake.byKind["video"] != 1 {
				t.Fatalf("batch implicitly regenerated skipped middle video: %v", fake.byKind)
			}
			for _, segment := range segments[1:] {
				stored, _ := svc.repo.DramaSegment(projectID, segment.ID)
				if mediaBusyStatus(stored.VideoStatus) {
					t.Fatalf("batch stranded an unauthorized descendant: %+v", stored)
				}
			}
		})
	}
}

func TestDramaStudioBatchTailVideosChecksCombinedBalanceBeforeQueuing(t *testing.T) {
	svc, fake, projectID, segments := dramaStudioBatchTailFixture(t)
	ids := make([]string, 0, len(segments))
	for _, segment := range segments {
		ids = append(ids, segment.ID)
	}
	view, err := svc.PreflightDramaStudioBatch("usr-drama", projectID, DramaStudioBatchRequest{Action: "segment_video", TargetIDs: ids})
	if err != nil || view.Counts["ready"] != 4 || view.AmountMicrocredits != 400 {
		t.Fatalf("initial chain quote: %+v %v", view, err)
	}
	if err := fake.db.Model(&model.CreditAccount{}).Where("user_id = ?", "usr-drama").Update("available_microcredits", 150).Error; err != nil {
		t.Fatal(err)
	}
	result, err := svc.ExecuteDramaStudioBatch("usr-drama", projectID, confirmedDramaStudioBatch(view))
	if err != nil || result.Ready || result.Counts["blocked"] != 4 || result.Counts["queued"] != 0 || !result.Priced || result.AmountMicrocredits != 400 || !strings.Contains(result.Reason, "积分不足") {
		t.Fatalf("combined balance must block the whole chain and retain its quote: %+v %v", result, err)
	}
	for _, segment := range segments {
		stored, _ := svc.repo.DramaSegment(projectID, segment.ID)
		if mediaBusyStatus(stored.VideoStatus) {
			t.Fatalf("insufficient batch balance partially queued: %+v", stored)
		}
	}
	if fake.byKind["video"] != 0 {
		t.Fatal("insufficient batch balance generated video")
	}
}

func TestDramaStudioBatchConfirmationChangeIsAtomic(t *testing.T) {
	svc, fake, projectID, _ := dramaStudioFixture(t)
	casts, _ := svc.repo.DramaCasts(projectID)
	view, err := svc.PreflightDramaStudioBatch("usr-drama", projectID, DramaStudioBatchRequest{Action: "cast_image", TargetIDs: []string{casts[0].ID, casts[1].ID}})
	if err != nil || view.Counts["ready"] != 2 {
		t.Fatalf("preflight: %+v %v", view, err)
	}
	if err := svc.repo.UpdateDramaCastFields(casts[1].ID, map[string]any{"appearance": "预检后手动改动"}); err != nil {
		t.Fatal(err)
	}
	result, err := svc.ExecuteDramaStudioBatch("usr-drama", projectID, confirmedDramaStudioBatch(view))
	var appErr *AppError
	if !errors.As(err, &appErr) || appErr.Status != 409 || appErr.Details["batch"] == nil || result.Counts["conflict"] != 2 || result.Counts["queued"] != 0 {
		t.Fatalf("stale batch must report per-item conflict: %+v %v", result, err)
	}
	for _, cast := range casts[:2] {
		saved, _ := svc.repo.DramaCast(projectID, cast.ID)
		if saved.ImageStatus == model.DramaMediaQueued {
			t.Fatalf("stale batch partially applied: %+v", saved)
		}
	}
	p, _ := svc.repo.DramaProduction(projectID)
	if p.MediaRequestsOnly || fake.byKind["image"] != 0 {
		t.Fatal("stale confirmation changed scope or generated media")
	}
}

func TestDramaStudioBatchAllNewBlockersInvalidateConfirmation(t *testing.T) {
	svc, fake, projectID, _ := dramaStudioFixture(t)
	casts, _ := svc.repo.DramaCasts(projectID)
	view, err := svc.PreflightDramaStudioBatch("usr-drama", projectID, DramaStudioBatchRequest{Action: "cast_image", TargetIDs: []string{casts[0].ID, casts[1].ID}})
	if err != nil || view.Counts["ready"] != 2 {
		t.Fatalf("preflight: %+v %v", view, err)
	}
	for _, cast := range casts[:2] {
		if err := svc.repo.UpdateDramaCastFields(cast.ID, map[string]any{"locked": true}); err != nil {
			t.Fatal(err)
		}
	}
	result, err := svc.ExecuteDramaStudioBatch("usr-drama", projectID, confirmedDramaStudioBatch(view))
	var appErr *AppError
	if !errors.As(err, &appErr) || appErr.Status != 409 || result.Counts["conflict"] != 2 || result.Counts["queued"] != 0 {
		t.Fatalf("all ready targets becoming blocked must invalidate confirmation: %+v %v", result, err)
	}
	p, _ := svc.repo.DramaProduction(projectID)
	if p.MediaRequestsOnly || fake.byKind["image"] != 0 {
		t.Fatal("all-blocked conflict must not write or dispatch")
	}
}

func seedDramaStudioBatchImagePrice(t *testing.T, fake *fakeDramaBackend) {
	t.Helper()
	profile := DefaultModelCapabilityConfigForModel(string(model.ChannelInterfaceGeminiImage), "image")
	profile.Image.Resolution = ImageResolutionConfig{Supported: true, Values: []string{"1k"}, Default: "1k"}
	raw, _ := json.Marshal(profile)
	for _, row := range []any{
		&model.ModelChannel{ID: "ch", Scope: model.ChannelScopeSystem, Enabled: true, APIFormat: "legacy"},
		&model.ChannelModel{ID: "studio-batch-image", ChannelID: "ch", ModelKey: "image", Capability: "image", Protocol: model.ChannelInterfaceGeminiImage, Enabled: true, CapabilityConfigJSON: string(raw)},
		&model.ChannelModelPriceTier{ID: "studio-batch-price", ChannelModelID: "studio-batch-image", SelectorKey: `{"imageResolution":"1k"}`, SelectorJSON: `{"imageResolution":"1k"}`, BillingMode: "fixed_request", UnitPriceMicrocredits: 100, PriceConfigured: true, Enabled: true},
		&model.CreditAccount{UserID: "usr-drama", AvailableMicrocredits: 1000},
	} {
		if err := fake.db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
}

func TestDramaStudioBatchMissingAssetsDeduplicatesPriceAcrossSegments(t *testing.T) {
	svc, fake, projectID, detail := dramaStudioFixture(t)
	seedDramaStudioBatchImagePrice(t, fake)
	casts, _ := svc.repo.DramaCasts(projectID)
	first, second, locked := casts[0], casts[1], casts[2]
	if err := svc.repo.UpdateDramaCastFields(locked.ID, map[string]any{"locked": true}); err != nil {
		t.Fatal(err)
	}
	setDramaStudioAssetReferences(t, fake, detail.Segments[0].ID, first.ID, second.ID)
	setDramaStudioAssetReferences(t, fake, detail.Segments[1].ID, second.ID, locked.ID)
	req := DramaStudioBatchRequest{Action: "segment_assets", TargetIDs: []string{detail.Segments[0].ID, detail.Segments[1].ID}}
	view, err := svc.PreflightDramaStudioBatch("usr-drama", projectID, req)
	if err != nil || !view.Ready || !view.Priced || view.AmountMicrocredits != 200 || view.Counts["ready"] != 2 || view.Counts["blocked"] != 1 || len(view.Items) != 3 {
		t.Fatalf("quote must count unique actionable assets only: %+v %v", view, err)
	}
	for _, item := range view.Items {
		if item.TargetID == second.ID && len(item.SourceTargetIDs) != 2 {
			t.Fatalf("shared asset must preserve both source segments: %+v", item)
		}
	}
	if err := fake.db.Model(&model.ChannelModelPriceTier{}).Where("id = ?", "studio-batch-price").Update("unit_price_microcredits", 125).Error; err != nil {
		t.Fatal(err)
	}
	changed, err := svc.ExecuteDramaStudioBatch("usr-drama", projectID, confirmedDramaStudioBatch(view))
	if err == nil || changed.Counts["queued"] != 0 || changed.Counts["conflict"] != 2 {
		t.Fatalf("changed deduplicated quote must invalidate whole confirmation: %+v %v", changed, err)
	}
	if err := fake.db.Model(&model.ChannelModelPriceTier{}).Where("id = ?", "studio-batch-price").Update("unit_price_microcredits", 100).Error; err != nil {
		t.Fatal(err)
	}
	view, _ = svc.PreflightDramaStudioBatch("usr-drama", projectID, req)
	if err := fake.db.Model(&model.CreditAccount{}).Where("user_id = ?", "usr-drama").Update("available_microcredits", 150).Error; err != nil {
		t.Fatal(err)
	}
	blocked, err := svc.ExecuteDramaStudioBatch("usr-drama", projectID, confirmedDramaStudioBatch(view))
	if err != nil || blocked.Ready || blocked.Counts["queued"] != 0 || blocked.AmountMicrocredits != 200 || !strings.Contains(blocked.Reason, "积分不足") {
		t.Fatalf("combined balance must block the entire actionable set: %+v %v", blocked, err)
	}
	if err := fake.db.Model(&model.CreditAccount{}).Where("user_id = ?", "usr-drama").Update("available_microcredits", 1000).Error; err != nil {
		t.Fatal(err)
	}
	if err := fake.db.Model(&model.DramaProduction{}).Where("project_id = ?", projectID).Update("budget_microcredits", 150).Error; err != nil {
		t.Fatal(err)
	}
	blocked, err = svc.PreflightDramaStudioBatch("usr-drama", projectID, req)
	if err != nil || blocked.Ready || !strings.Contains(blocked.Reason, "预算") {
		t.Fatalf("combined budget must block batch even when one target fits: %+v %v", blocked, err)
	}
	if err := fake.db.Model(&model.DramaProduction{}).Where("project_id = ?", projectID).Update("budget_microcredits", 0).Error; err != nil {
		t.Fatal(err)
	}
	view, _ = svc.PreflightDramaStudioBatch("usr-drama", projectID, req)
	result, err := svc.ExecuteDramaStudioBatch("usr-drama", projectID, confirmedDramaStudioBatch(view))
	if err != nil || result.Counts["queued"] != 2 || result.AmountMicrocredits != 200 {
		t.Fatalf("deduplicated missing images should queue: %+v %v", result, err)
	}
	runDramaTicks(t, svc, projectID, 8)
	if fake.byKind["image"] != 2 || fake.byKind["video"] != 0 {
		t.Fatalf("missing asset batch must never generate video: %v", fake.byKind)
	}
}

func TestDramaStudioBatchParentsAndBlockedChildren(t *testing.T) {
	svc, fake, projectID, _ := dramaStudioFixture(t)
	casts, _ := svc.repo.DramaCasts(projectID)
	base := casts[0]
	look := model.DramaCast{ID: newID(), ProjectID: projectID, Kind: "character", ParentID: base.ID, Name: base.Name, LookName: "夜行", Appearance: "黑色夜行衣", ImageStatus: model.DramaMediaDraft, Revision: 1}
	if err := fake.db.Create(&look).Error; err != nil {
		t.Fatal(err)
	}
	req := DramaStudioBatchRequest{Action: "cast_image", TargetIDs: []string{base.ID, look.ID}}
	view, err := svc.PreflightDramaStudioBatch("usr-drama", projectID, req)
	if err != nil || view.Counts["ready"] != 2 {
		t.Fatalf("batch must allow selected base then child dependency: %+v %v", view, err)
	}
	if err := svc.repo.UpdateDramaCastFields(base.ID, map[string]any{"locked": true}); err != nil {
		t.Fatal(err)
	}
	view, err = svc.PreflightDramaStudioBatch("usr-drama", projectID, req)
	if err != nil || view.Ready || view.Counts["blocked"] != 2 {
		t.Fatalf("blocked parent must block dependent child without a charge: %+v %v", view, err)
	}
	if err := svc.repo.UpdateDramaCastFields(base.ID, map[string]any{"locked": false}); err != nil {
		t.Fatal(err)
	}
	view, _ = svc.PreflightDramaStudioBatch("usr-drama", projectID, req)
	if result, err := svc.ExecuteDramaStudioBatch("usr-drama", projectID, confirmedDramaStudioBatch(view)); err != nil || result.Counts["queued"] != 2 {
		t.Fatalf("base and child queue atomically: %+v %v", result, err)
	}
	runDramaTicks(t, svc, projectID, 10)
	stored, _ := svc.repo.DramaCast(projectID, look.ID)
	if fake.byKind["image"] != 2 || stored.ImageStatus != model.DramaMediaReady {
		t.Fatalf("child must follow its generated parent: %v %+v", fake.byKind, stored)
	}
}

func TestDramaStudioBatchRejectsEmptyScopeAndForeignOwner(t *testing.T) {
	svc, _, projectID, detail := dramaStudioFixture(t)
	for _, req := range []DramaStudioBatchRequest{
		{Action: "segment_video"}, {Action: "cast_image", TargetIDs: []string{}},
		{Action: "cast_image", TargetIDs: []string{" "}}, {Action: "all", TargetIDs: []string{detail.Segments[0].ID}},
	} {
		if _, err := svc.PreflightDramaStudioBatch("usr-drama", projectID, req); err == nil {
			t.Fatalf("accepted invalid/all scope: %+v", req)
		}
	}
	req := DramaStudioBatchRequest{Action: "segment_video", TargetIDs: []string{detail.Segments[0].ID}}
	if _, err := svc.PreflightDramaStudioBatch("someone", projectID, req); err == nil {
		t.Fatal("foreign owner accepted")
	}
	if _, err := svc.ExecuteDramaStudioBatch("usr-drama", projectID, req); err == nil {
		t.Fatal("unconfirmed batch accepted")
	}
}

func TestDramaStudioBatchWriteFailureRollsBackEveryTarget(t *testing.T) {
	svc, fake, projectID, _ := dramaStudioFixture(t)
	casts, _ := svc.repo.DramaCasts(projectID)
	req := DramaStudioBatchRequest{Action: "cast_image", TargetIDs: []string{casts[0].ID, casts[1].ID}}
	view, err := svc.PreflightDramaStudioBatch("usr-drama", projectID, req)
	if err != nil || !view.Ready {
		t.Fatalf("preflight: %+v %v", view, err)
	}
	// 真正的数据库写错误必须回滚先前目标和 scope 标记，不能靠内存中标记 queued 伪装成功。
	if err := fake.db.Exec("CREATE TRIGGER fail_studio_batch BEFORE UPDATE OF image_status ON drama_casts WHEN NEW.id = '" + casts[1].ID + "' BEGIN SELECT RAISE(ABORT, 'test batch rollback'); END").Error; err != nil {
		t.Fatal(err)
	}
	result, err := svc.ExecuteDramaStudioBatch("usr-drama", projectID, confirmedDramaStudioBatch(view))
	if err == nil || result.Counts["queued"] != 0 {
		t.Fatalf("database failure must not claim durable queue success: %+v %v", result, err)
	}
	for _, cast := range casts[:2] {
		stored, _ := svc.repo.DramaCast(projectID, cast.ID)
		if stored.ImageStatus == model.DramaMediaQueued {
			t.Fatalf("transaction partially committed: %+v", stored)
		}
	}
	p, _ := svc.repo.DramaProduction(projectID)
	if p.MediaRequestsOnly || fake.byKind["image"] != 0 {
		t.Fatal("failed transaction retained scope restriction or generated media")
	}
}

func TestDramaStudioBatchPromptRetriesKeepSelectedLaterSegmentsRequested(t *testing.T) {
	svc, fake, projectID, detail := dramaStudioFixture(t)
	before := fake.byKind["segment_prompt"]
	ids := []string{detail.Segments[0].ID, detail.Segments[1].ID}
	for _, id := range ids {
		if err := fake.db.Model(&model.DramaSegment{}).Where("id = ?", id).Updates(map[string]any{"prompt_status": model.DramaMediaFailed, "video_status": model.DramaMediaStale, "video_resource_id": "keep-old-video"}).Error; err != nil {
			t.Fatal(err)
		}
	}
	view, err := svc.PreflightDramaStudioBatch("usr-drama", projectID, DramaStudioBatchRequest{Action: "segment_prompt", TargetIDs: ids})
	if err != nil || view.Counts["ready"] != 2 {
		t.Fatalf("prompt retry preflight: %+v %v", view, err)
	}
	result, err := svc.ExecuteDramaStudioBatch("usr-drama", projectID, confirmedDramaStudioBatch(view))
	if err != nil || result.Counts["queued"] != 2 {
		t.Fatalf("later target must not CAS-conflict with earlier continuity invalidation: %+v %v", result, err)
	}
	runDramaTicks(t, svc, projectID, 10)
	for _, id := range ids {
		segment, _ := svc.repo.DramaSegment(projectID, id)
		if !dramaPromptReady(*segment) || segment.VideoResourceID != "keep-old-video" {
			t.Fatalf("prompt batch lost request or old video: %+v", segment)
		}
	}
	if fake.byKind["segment_prompt"] != before+2 || fake.byKind["video"] != 0 {
		t.Fatalf("prompt retry batch scope changed: %v", fake.byKind)
	}
}

func TestDramaStudioBatchCanStartPendingPromptWithoutActiveJob(t *testing.T) {
	svc, fake, projectID, detail := dramaStudioFixture(t)
	id := detail.Segments[0].ID
	before := fake.byKind["segment_prompt"]
	if err := fake.db.Model(&model.DramaSegment{}).Where("id = ?", id).Updates(map[string]any{"prompt_status": "", "video_prompt": "", "video_status": ""}).Error; err != nil {
		t.Fatal(err)
	}
	if err := fake.db.Model(&model.DramaProduction{}).Where("project_id = ?", projectID).Update("status", model.DramaStatusPaused).Error; err != nil {
		t.Fatal(err)
	}
	view, err := svc.PreflightDramaStudioBatch("usr-drama", projectID, DramaStudioBatchRequest{Action: "segment_prompt", TargetIDs: []string{id}})
	if err != nil || view.Counts["ready"] != 1 || view.Counts["already_queued"] != 0 {
		t.Fatalf("empty status without a job is actionable pending work: %+v %v", view, err)
	}
	result, err := svc.ExecuteDramaStudioBatch("usr-drama", projectID, confirmedDramaStudioBatch(view))
	if err != nil || result.Counts["queued"] != 1 || result.DispatchPending {
		t.Fatalf("explicit pending prompt must wake paused work: %+v %v", result, err)
	}
	runDramaTicks(t, svc, projectID, 8)
	stored, _ := svc.repo.DramaSegment(projectID, id)
	if !dramaPromptReady(*stored) || fake.byKind["segment_prompt"] != before+1 || fake.byKind["video"] != 0 || fake.byKind["image"] != 0 {
		t.Fatalf("pending request must only generate selected prompt: %+v %v", stored, fake.byKind)
	}
}

func TestDramaStudioBatchPendingPromptWithActiveJobIsSkipped(t *testing.T) {
	svc, fake, projectID, detail := dramaStudioFixture(t)
	id := detail.Segments[0].ID
	if err := fake.db.Model(&model.DramaSegment{}).Where("id = ?", id).Update("prompt_status", "").Error; err != nil {
		t.Fatal(err)
	}
	view, err := svc.PreflightDramaStudioBatch("usr-drama", projectID, DramaStudioBatchRequest{Action: "segment_prompt", TargetIDs: []string{id}})
	if err != nil || view.Counts["ready"] != 1 {
		t.Fatalf("pending preflight: %+v %v", view, err)
	}
	job := model.DramaJob{ID: "studio-batch-active-prompt", ProjectID: projectID, EpisodeID: detail.Episode.ID, ShotID: id, Kind: model.DramaJobSegmentPrompt, Status: model.DramaJobRunning}
	if err := svc.repo.CreateDramaJobs([]model.DramaJob{job}); err != nil {
		t.Fatal(err)
	}
	result, err := svc.ExecuteDramaStudioBatch("usr-drama", projectID, confirmedDramaStudioBatch(view))
	if err != nil || result.Counts["already_queued"] != 1 || result.Counts["queued"] != 0 {
		t.Fatalf("active job must be skipped even with empty target status: %+v %v", result, err)
	}
	stored, _ := svc.repo.DramaSegment(projectID, id)
	if stored.Revision != detail.Segments[0].Revision {
		t.Fatalf("skipped prompt must not be invalidated: %+v", stored)
	}
}

func TestDramaStudioQueuedResultSurvivesResumeFailure(t *testing.T) {
	for _, batch := range []bool{false, true} {
		t.Run(map[bool]string{false: "single", true: "batch"}[batch], func(t *testing.T) {
			svc, fake, projectID, _ := dramaStudioFixture(t)
			casts, _ := svc.repo.DramaCasts(projectID)
			p, _ := svc.repo.DramaProduction(projectID)
			settings := parseDramaSettings(p.SettingsJSON)
			settings.Models = DramaModels{Image: fakeDramaModels.Image}
			if err := fake.db.Model(p).Updates(map[string]any{"status": model.DramaStatusPaused, "settings_json": encodeDramaSettings(settings)}).Error; err != nil {
				t.Fatal(err)
			}
			if batch {
				view, err := svc.PreflightDramaStudioBatch("usr-drama", projectID, DramaStudioBatchRequest{Action: "cast_image", TargetIDs: []string{casts[0].ID}})
				if err != nil || !view.Ready {
					t.Fatalf("preflight: %+v %v", view, err)
				}
				result, err := svc.ExecuteDramaStudioBatch("usr-drama", projectID, confirmedDramaStudioBatch(view))
				if err != nil || result.Counts["queued"] != 1 || !result.DispatchPending || len(result.Warnings) == 0 {
					t.Fatalf("persisted queue must be reported honestly after resume failure: %+v %v", result, err)
				}
			} else {
				view, err := svc.PreflightDramaStudioAction("usr-drama", projectID, DramaStudioActionRequest{Action: "cast_image", TargetID: casts[0].ID})
				if err != nil || !view.Ready {
					t.Fatalf("single preflight: %+v %v", view, err)
				}
				result, err := svc.ExecuteDramaStudioAction("usr-drama", projectID, confirmedDramaStudioRequest(view))
				if err != nil || result["queued"] != 1 || result["dispatchPending"] != true {
					t.Fatalf("single persisted queue must survive resume failure: %+v %v", result, err)
				}
			}
			stored, _ := svc.repo.DramaCast(projectID, casts[0].ID)
			if stored.ImageStatus != model.DramaMediaQueued || fake.byKind["image"] != 0 {
				t.Fatalf("queue should remain durable without dispatch: %+v %v", stored, fake.byKind)
			}
		})
	}
}

func TestDramaStudioBatchDoesNotRegeneratePaidVideoAwaitingReprocess(t *testing.T) {
	svc, fake, projectID, detail := dramaStudioFixture(t)
	svc.dramaTailFrameHook = func(_, _ string) (string, error) { return "", errors.New("尾帧暂时处理失败") }
	single, err := svc.PreflightDramaStudioAction("usr-drama", projectID, DramaStudioActionRequest{Action: "segment_video", TargetID: detail.Segments[0].ID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ExecuteDramaStudioAction("usr-drama", projectID, confirmedDramaStudioRequest(single)); err != nil {
		t.Fatal(err)
	}
	runDramaTicks(t, svc, projectID, 5)
	view, err := svc.PreflightDramaStudioBatch("usr-drama", projectID, DramaStudioBatchRequest{Action: "segment_video", TargetIDs: []string{detail.Segments[0].ID}})
	if err != nil || view.Ready || view.Counts["blocked"] != 1 || !strings.Contains(view.Items[0].Reason, "重新处理") || view.AmountMicrocredits != 0 {
		t.Fatalf("paid successful video should use reprocess, not another generation: %+v %v", view, err)
	}
	result, err := svc.ExecuteDramaStudioBatch("usr-drama", projectID, confirmedDramaStudioBatch(view))
	if err != nil || result.Counts["queued"] != 0 || fake.byKind["video"] != 1 {
		t.Fatalf("blocked reprocess must not generate/charge again: %+v %v requests=%v", result, err, fake.byKind)
	}
}
