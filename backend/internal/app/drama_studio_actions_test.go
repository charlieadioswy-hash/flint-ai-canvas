package app

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"yingce/backend/internal/model"
	"yingce/backend/internal/repository"
)

func dramaStudioFixture(t *testing.T) (*Service, *fakeDramaBackend, string, DramaEpisodeDetail) {
	t.Helper()
	svc, fake := newDramaTestService(t)
	projectID := createTestDramaWithMedia(t, svc, DramaReviewEvery, DramaMediaManual).Project.ID
	runDramaTicks(t, svc, projectID, 20)
	summary, err := svc.DramaSummary("usr-drama", projectID)
	if err != nil {
		t.Fatal(err)
	}
	detail, err := svc.DramaEpisodeDetail("usr-drama", projectID, summary.Episodes[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	return svc, fake, projectID, detail
}

func confirmedDramaStudioRequest(view DramaStudioActionPreflight) DramaStudioActionRequest {
	return DramaStudioActionRequest{Action: view.Action, TargetID: view.TargetID, EpisodeID: view.EpisodeID, TargetRevision: &view.TargetRevision, BaseRevision: &view.BaseRevision, ConfirmationToken: view.ConfirmationToken}
}

func TestDramaStudioSingleVideoDoesNotReleaseEpisodeOrGenerateAssets(t *testing.T) {
	svc, fake, projectID, detail := dramaStudioFixture(t)
	view, err := svc.PreflightDramaStudioAction("usr-drama", projectID, DramaStudioActionRequest{Action: "segment_video", TargetID: detail.Segments[0].ID, EpisodeID: detail.Episode.ID})
	if err != nil || !view.Ready || !view.CanUseText || len(view.MissingCasts) == 0 {
		t.Fatalf("preflight = %+v, %v", view, err)
	}
	if fake.byKind["video"] != 0 || fake.byKind["image"] != 0 {
		t.Fatal("preflight generated media")
	}
	if _, err := svc.ExecuteDramaStudioAction("usr-drama", projectID, confirmedDramaStudioRequest(view)); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ExecuteDramaStudioAction("usr-drama", projectID, confirmedDramaStudioRequest(view)); err == nil {
		t.Fatal("duplicate confirmation accepted")
	}
	runDramaTicks(t, svc, projectID, 10)
	if fake.byKind["video"] != 1 || fake.byKind["image"] != 0 {
		t.Fatalf("unexpected scope: %v", fake.byKind)
	}
	episode, _ := svc.repo.DramaEpisode(projectID, detail.Episode.ID)
	p, _ := svc.repo.DramaProduction(projectID)
	if episode.MediaReleased || episode.Approved || p.AssetsReleased {
		t.Fatalf("single video released unrelated work: %+v %+v", episode, p)
	}
	segments, _ := svc.repo.DramaSegments(detail.Episode.ID)
	if segments[1].VideoStatus != "" {
		t.Fatalf("other segment changed: %+v", segments[1])
	}
}

func TestDramaStudioPreflightValidatesTargetsAndFreshConfirmation(t *testing.T) {
	svc, _, projectID, detail := dramaStudioFixture(t)
	req := DramaStudioActionRequest{Action: "segment_video", TargetID: detail.Segments[0].ID, EpisodeID: detail.Episode.ID}
	if _, err := svc.PreflightDramaStudioAction("other", projectID, req); err == nil {
		t.Fatal("foreign owner accepted")
	}
	wrongEpisode := req
	wrongEpisode.EpisodeID = "other"
	if _, err := svc.PreflightDramaStudioAction("usr-drama", projectID, wrongEpisode); err == nil {
		t.Fatal("wrong episode accepted")
	}
	if _, err := svc.ExecuteDramaStudioAction("usr-drama", projectID, req); err == nil {
		t.Fatal("unconfirmed request accepted")
	}
	view, err := svc.PreflightDramaStudioAction("usr-drama", projectID, req)
	if err != nil {
		t.Fatal(err)
	}
	casts, _ := svc.repo.DramaCasts(projectID)
	for _, missing := range view.MissingCasts {
		if err := svc.repo.UpdateDramaCastFields(missing.ID, map[string]any{"appearance": "变更后的外观"}); err != nil {
			t.Fatal(err)
		}
		break
	}
	if _, err := svc.ExecuteDramaStudioAction("usr-drama", projectID, confirmedDramaStudioRequest(view)); err == nil {
		t.Fatal("changed inputs accepted old confirmation")
	}
	if len(casts) == 0 {
		t.Fatal("fixture missing casts")
	}
}

func TestDramaStudioPreflightTailFrameAndRequiredReferences(t *testing.T) {
	svc, fake, projectID, detail := dramaStudioFixture(t)
	view, err := svc.PreflightDramaStudioAction("usr-drama", projectID, DramaStudioActionRequest{Action: "segment_video", TargetID: detail.Segments[1].ID})
	if err != nil || view.Ready || !strings.Contains(view.Reason, "上一段") {
		t.Fatalf("tail wait = %+v, %v", view, err)
	}
	capability := dramaVideoFixture()
	capability.References.MinImages = 1
	setDramaVideoCapability(t, svc, fake, capability)
	view, err = svc.PreflightDramaStudioAction("usr-drama", projectID, DramaStudioActionRequest{Action: "segment_video", TargetID: detail.Segments[0].ID})
	if err != nil || view.Ready || view.CanUseText || len(view.MissingCasts) == 0 || !strings.Contains(view.Reason, "参考图") {
		t.Fatalf("required reference = %+v, %v", view, err)
	}
	if fake.byKind["image"] != 0 || fake.byKind["video"] != 0 {
		t.Fatal("dependency preflight generated media")
	}
}

func TestDramaStudioCastGenerationDoesNotRetryOtherLooks(t *testing.T) {
	svc, fake, projectID, _ := dramaStudioFixture(t)
	casts, _ := svc.repo.DramaCasts(projectID)
	cast := casts[0]
	look := model.DramaCast{ID: "studio-failed-look", ProjectID: projectID, ParentID: cast.ID, Kind: "character", Name: "造型", ImageStatus: model.DramaMediaFailed}
	if err := fake.db.Create(&look).Error; err != nil {
		t.Fatal(err)
	}
	view, err := svc.PreflightDramaStudioAction("usr-drama", projectID, DramaStudioActionRequest{Action: "cast_image", TargetID: cast.ID})
	if err != nil || !view.Ready {
		t.Fatalf("cast preflight = %+v, %v", view, err)
	}
	if _, err := svc.ExecuteDramaStudioAction("usr-drama", projectID, confirmedDramaStudioRequest(view)); err != nil {
		t.Fatal(err)
	}
	runDramaTicks(t, svc, projectID, 5)
	if fake.byKind["image"] != 1 || fake.byKind["video"] != 0 {
		t.Fatalf("unexpected image scope: %v", fake.byKind)
	}
	gotLook, _ := svc.repo.DramaCast(projectID, look.ID)
	if gotLook.ImageStatus != model.DramaMediaFailed {
		t.Fatalf("unrequested look changed: %+v", gotLook)
	}
}

func TestDramaStudioReprocessReusesSuccessfulTask(t *testing.T) {
	svc, fake, projectID, detail := dramaStudioFixture(t)
	svc.dramaTailFrameHook = func(_, _ string) (string, error) { return "", errors.New("尾帧处理失败") }
	view, err := svc.PreflightDramaStudioAction("usr-drama", projectID, DramaStudioActionRequest{Action: "segment_video", TargetID: detail.Segments[0].ID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ExecuteDramaStudioAction("usr-drama", projectID, confirmedDramaStudioRequest(view)); err != nil {
		t.Fatal(err)
	}
	runDramaTicks(t, svc, projectID, 5)
	view, err = svc.PreflightDramaStudioAction("usr-drama", projectID, DramaStudioActionRequest{Action: "segment_reprocess", TargetID: detail.Segments[0].ID})
	if err != nil || !view.Ready || !view.Reprocessable || view.AmountMicrocredits != 0 {
		t.Fatalf("reprocess preflight = %+v, %v", view, err)
	}
	svc.dramaTailFrameHook = func(userID, _ string) (string, error) { return fake.resource(userID, "image", "image/png"), nil }
	if _, err := svc.ExecuteDramaStudioAction("usr-drama", projectID, confirmedDramaStudioRequest(view)); err != nil {
		t.Fatal(err)
	}
	runDramaTicks(t, svc, projectID, 5)
	segment, _ := svc.repo.DramaSegment(projectID, detail.Segments[0].ID)
	if fake.byKind["video"] != 1 || !dramaSegmentVideoDone(*segment) {
		t.Fatalf("reprocess generated new task or failed: %v %+v", fake.byKind, segment)
	}
}

func TestDramaStudioPromptRetryPreservesIndependentQueuedWork(t *testing.T) {
	svc, fake, projectID, detail := dramaStudioFixture(t)
	first, second := detail.Segments[0], detail.Segments[1]
	if err := fake.db.Model(&model.DramaSegment{}).Where("id = ?", first.ID).Updates(map[string]any{"prompt_status": model.DramaMediaFailed, "prompt_error": "临时失败"}).Error; err != nil {
		t.Fatal(err)
	}
	job := model.DramaJob{ID: "studio-other-prompt", ProjectID: projectID, EpisodeID: detail.Episode.ID, ShotID: second.ID, Kind: model.DramaJobSegmentPrompt, Status: model.DramaJobQueued}
	if err := fake.db.Create(&job).Error; err != nil {
		t.Fatal(err)
	}
	view, err := svc.PreflightDramaStudioAction("usr-drama", projectID, DramaStudioActionRequest{Action: "segment_prompt", TargetID: first.ID})
	if err != nil || !view.Ready {
		t.Fatalf("prompt preflight = %+v, %v", view, err)
	}
	if _, err := svc.ExecuteDramaStudioAction("usr-drama", projectID, confirmedDramaStudioRequest(view)); err != nil {
		t.Fatal(err)
	}
	var got model.DramaJob
	if err := fake.db.First(&got, "id = ?", job.ID).Error; err != nil || got.Status != model.DramaJobQueued {
		t.Fatalf("unrelated job canceled: %+v %v", got, err)
	}
	gotSecond, _ := svc.repo.DramaSegment(projectID, second.ID)
	if gotSecond.Revision != second.Revision || gotSecond.PromptStatus != second.PromptStatus {
		t.Fatalf("other segment changed: %+v", gotSecond)
	}
	if fake.byKind["image"] != 0 || fake.byKind["video"] != 0 {
		t.Fatal("prompt retry generated media")
	}
}

func TestDramaStudioExactVideoScopesAutoModeAndCanReleaseLater(t *testing.T) {
	svc, fake, projectID, detail := dramaStudioFixture(t)
	p, _ := svc.repo.DramaProduction(projectID)
	settings := parseDramaSettings(p.SettingsJSON)
	settings.MediaMode, settings.ReviewMode = DramaMediaAuto, DramaReviewAuto
	encoded, _ := json.Marshal(settings)
	if err := fake.db.Model(&model.DramaProduction{}).Where("project_id = ?", projectID).Update("settings_json", string(encoded)).Error; err != nil {
		t.Fatal(err)
	}
	view, err := svc.PreflightDramaStudioAction("usr-drama", projectID, DramaStudioActionRequest{Action: "segment_video", TargetID: detail.Segments[0].ID})
	if err != nil || !view.Ready {
		t.Fatalf("preflight = %+v, %v", view, err)
	}
	if _, err := svc.ExecuteDramaStudioAction("usr-drama", projectID, confirmedDramaStudioRequest(view)); err != nil {
		t.Fatal(err)
	}
	runDramaTicks(t, svc, projectID, 10)
	second, _ := svc.repo.DramaSegment(projectID, detail.Segments[1].ID)
	episode, _ := svc.repo.DramaEpisode(projectID, detail.Episode.ID)
	if fake.byKind["video"] != 1 || fake.byKind["image"] != 0 || second.VideoStatus != "" || !episode.VideoRequestsOnly || fake.byKind["render"] != 0 {
		t.Fatalf("auto mode expanded scope: %v, %+v, %+v", fake.byKind, second, episode)
	}
	otherEpisodes, _ := svc.repo.DramaEpisodes(projectID)
	for _, other := range otherEpisodes {
		if other.ID == episode.ID {
			continue
		}
		segments, _ := svc.repo.DramaSegments(other.ID)
		for _, segment := range segments {
			if segment.VideoStatus != "" {
				t.Fatalf("other episode implicitly requested: %+v", segment)
			}
		}
	}
	if _, err := svc.ReleaseDramaMedia("usr-drama", projectID, ReleaseDramaMediaRequest{Target: "episodes", EpisodeIDs: []string{detail.Episode.ID}}); err != nil {
		t.Fatal(err)
	}
	runDramaTicks(t, svc, projectID, 10)
	episode, _ = svc.repo.DramaEpisode(projectID, detail.Episode.ID)
	if episode.VideoRequestsOnly || fake.byKind["video"] != 2 || fake.byKind["render"] != 1 {
		t.Fatalf("explicit full release failed: %v %+v", fake.byKind, episode)
	}
}

func TestDramaStudioVideoModelOverrideMatchesSubmission(t *testing.T) {
	svc, fake, projectID, detail := dramaStudioFixture(t)
	capability := dramaVideoFixture()
	capability.Duration.Values, capability.Duration.Default = []int{10}, 10
	raw, _ := json.Marshal(&ModelCapabilityConfig{Version: 1, Video: &capability})
	if err := fake.db.Create(&model.ChannelModel{ID: "drama-video-alt", ChannelID: "ch", ModelKey: "video-alt", Capability: "video", Protocol: model.ChannelInterfaceVolcengineArkVideo, Enabled: true, CapabilityConfigJSON: string(raw)}).Error; err != nil {
		t.Fatal(err)
	}
	if err := fake.db.Model(&model.DramaSegment{}).Where("id = ?", detail.Segments[0].ID).Update("prompt_seconds", 0).Error; err != nil {
		t.Fatal(err)
	}
	choice := DramaModelChoice{ChannelID: "ch", ModelKey: "video-alt"}
	view, err := svc.PreflightDramaStudioAction("usr-drama", projectID, DramaStudioActionRequest{Action: "segment_video", TargetID: detail.Segments[0].ID, VideoModel: &choice})
	if err != nil || !view.Ready || view.Request == nil || view.Request.Seconds != 10 {
		t.Fatalf("override preflight = %+v, %v", view, err)
	}
	req := confirmedDramaStudioRequest(view)
	req.VideoModel = &choice
	if _, err := svc.ExecuteDramaStudioAction("usr-drama", projectID, req); err != nil {
		t.Fatal(err)
	}
	runDramaTicks(t, svc, projectID, 8)
	requests := dramaVideoRequests(fake)
	if len(requests) != 1 || requests[0].Model != "video-alt" || requests[0].Input["config"].(map[string]any)["videoSeconds"] != "10" {
		t.Fatalf("override submission = %+v", requests)
	}
}

func TestDramaStudioPreservesPreviouslyQueuedAutomaticJob(t *testing.T) {
	svc, fake, projectID, detail := dramaStudioFixture(t)
	p, _ := svc.repo.DramaProduction(projectID)
	settings := parseDramaSettings(p.SettingsJSON)
	settings.MediaMode = DramaMediaAuto
	encoded, _ := json.Marshal(settings)
	if err := fake.db.Model(&model.DramaProduction{}).Where("project_id = ?", projectID).Update("settings_json", string(encoded)).Error; err != nil {
		t.Fatal(err)
	}
	job := model.DramaJob{ID: "previous-auto-video", ProjectID: projectID, EpisodeID: detail.Episode.ID, ShotID: detail.Segments[0].ID, Kind: model.DramaJobSegmentVideo, Status: model.DramaJobQueued}
	if err := svc.repo.CreateDramaJobs([]model.DramaJob{job}); err != nil {
		t.Fatal(err)
	}
	duplicate, err := svc.PreflightDramaStudioAction("usr-drama", projectID, DramaStudioActionRequest{Action: "segment_video", TargetID: detail.Segments[0].ID})
	if err != nil || duplicate.Ready {
		t.Fatalf("existing job was not reported: %+v %v", duplicate, err)
	}
	casts, _ := svc.repo.DramaCasts(projectID)
	view, err := svc.PreflightDramaStudioAction("usr-drama", projectID, DramaStudioActionRequest{Action: "cast_image", TargetID: casts[0].ID})
	if err != nil || !view.Ready {
		t.Fatalf("cast preflight: %+v %v", view, err)
	}
	if _, err := svc.ExecuteDramaStudioAction("usr-drama", projectID, confirmedDramaStudioRequest(view)); err != nil {
		t.Fatal(err)
	}
	runDramaTicks(t, svc, projectID, 8)
	var saved model.DramaJob
	if err := fake.db.First(&saved, "id = ?", job.ID).Error; err != nil {
		t.Fatal(err)
	}
	if saved.Status != model.DramaJobSucceeded || fake.byKind["video"] != 1 || fake.byKind["image"] != 1 {
		t.Fatalf("old authorization lost or new scope expanded: %+v %v", saved, fake.byKind)
	}
}

func TestDramaStudioExactRequestRejectsOlderAutomaticPlan(t *testing.T) {
	for _, scope := range []string{"production", "episode"} {
		t.Run(scope, func(t *testing.T) {
			svc, fake, projectID, detail := dramaStudioFixture(t)
			p, _ := svc.repo.DramaProduction(projectID)
			settings := parseDramaSettings(p.SettingsJSON)
			settings.MediaMode, settings.ReviewMode = DramaMediaAuto, DramaReviewAuto
			encoded, _ := json.Marshal(settings)
			if err := fake.db.Model(&model.DramaProduction{}).Where("project_id = ?", projectID).Updates(map[string]any{"settings_json": string(encoded), "media_requests_only": scope == "episode"}).Error; err != nil {
				t.Fatal(err)
			}
			if scope == "episode" {
				if err := fake.db.Model(&model.DramaEpisode{}).Where("id = ?", detail.Episode.ID).Updates(map[string]any{"stage": model.DramaEpisodeVideo, "media_released": true}).Error; err != nil {
					t.Fatal(err)
				}
				if err := fake.db.Model(&model.DramaSegment{}).Where("id = ?", detail.Segments[0].ID).Updates(map[string]any{"video_status": model.DramaMediaReady, "video_resource_id": fake.resource("usr-drama", "video", "video/mp4"), "tail_frame_resource_id": fake.resource("usr-drama", "image", "image/png")}).Error; err != nil {
					t.Fatal(err)
				}
			}
			p, _ = svc.repo.DramaProduction(projectID)
			project, _ := svc.repo.ProjectForUser("usr-drama", projectID)
			run := &dramaRun{s: svc, project: project, production: p, settings: parseDramaSettings(p.SettingsJSON), meta: parseDramaBibleMeta(p.BibleJSON)}
			if err := run.syncJobs(); err != nil {
				t.Fatal(err)
			}
			if err := run.loadCasts(); err != nil {
				t.Fatal(err)
			}
			if err := run.plan(); err != nil {
				t.Fatal(err)
			}
			if len(run.newJobs) == 0 {
				t.Fatal("fixture did not prepare an automatic plan")
			}
			view, err := svc.PreflightDramaStudioAction("usr-drama", projectID, DramaStudioActionRequest{Action: "segment_video", TargetID: detail.Segments[0].ID})
			if err != nil || !view.Ready {
				t.Fatalf("preflight = %+v %v", view, err)
			}
			if _, err := svc.ExecuteDramaStudioAction("usr-drama", projectID, confirmedDramaStudioRequest(view)); err != nil {
				t.Fatal(err)
			}
			if err := run.persistJobs(); !errors.Is(err, repository.ErrDramaGuideChanged) {
				t.Fatalf("stale automatic plan persisted: %v, jobs=%+v", err, run.newJobs)
			}
			var queued int64
			if err := fake.db.Model(&model.DramaJob{}).Where("project_id = ? AND kind IN ? AND status = ?", projectID, []string{model.DramaJobCastImage, model.DramaJobSegmentVideo}, model.DramaJobQueued).Count(&queued).Error; err != nil || queued != 0 {
				t.Fatalf("stale media entered queue: %d %v", queued, err)
			}
			runDramaTicks(t, svc, projectID, 8)
			if fake.byKind["video"] != 1 || fake.byKind["image"] != 0 {
				t.Fatalf("scope leaked after interleaving: %v", fake.byKind)
			}
		})
	}
}
