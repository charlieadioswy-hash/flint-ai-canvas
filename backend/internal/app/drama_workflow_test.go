package app

import (
	"errors"
	"testing"

	"yingce/backend/internal/model"
	"yingce/backend/internal/platform"
	"yingce/backend/internal/repository"
)

func dramaWorkflowStoryFixture(t *testing.T) (*Service, *fakeDramaBackend, string, DramaEpisodeDetail, model.DramaEpisode) {
	t.Helper()
	svc, fake, projectID, detail := dramaStudioFixture(t)
	svc.coordinator = platform.NewCoordinatorWithRedis(nil, t.Name())
	if err := fake.db.Model(&model.DramaProduction{}).Where("project_id = ?", projectID).Updates(map[string]any{"guide_step": model.DramaGuideStory, "status": model.DramaStatusRunning}).Error; err != nil {
		t.Fatal(err)
	}
	episodes, _ := svc.repo.DramaEpisodes(projectID)
	if len(episodes) < 2 {
		t.Fatal("fixture needs two episodes")
	}
	other := episodes[1]
	if err := svc.repo.UpdateDramaEpisodeUser(other.ID, map[string]any{"stage": model.DramaEpisodeScript, "shot_count": 0, "error": "本集改编失败"}); err != nil {
		t.Fatal(err)
	}
	return svc, fake, projectID, detail, other
}

func TestDramaWorkflowReadyEpisodeContinuesWithoutFailedEpisode(t *testing.T) {
	svc, fake, projectID, detail, other := dramaWorkflowStoryFixture(t)
	view, err := svc.DramaWorkflowReadiness("usr-drama", projectID)
	if err != nil || view.GuideStep != model.DramaGuideStory || len(view.Episodes) != 2 || !view.Episodes[0].TextReady || view.Episodes[1].TextReady {
		t.Fatalf("readiness must be per episode: %+v %v", view, err)
	}
	preflight, err := svc.PreflightDramaStudioAction("usr-drama", projectID, DramaStudioActionRequest{Action: "segment_video", TargetID: detail.Segments[0].ID})
	if err != nil || !preflight.Ready {
		t.Fatalf("ready episode must not wait for failed episode: %+v %v", preflight, err)
	}
	p, _ := svc.repo.DramaProduction(projectID)
	episode, _ := svc.repo.DramaEpisode(projectID, detail.Episode.ID)
	if p.MediaRequestsOnly || episode.VideoRequestsOnly || fake.byKind["video"] != 0 {
		t.Fatal("readiness and preflight must not authorize media")
	}
	if _, err := svc.ExecuteDramaStudioAction("usr-drama", projectID, confirmedDramaStudioRequest(preflight)); err != nil {
		t.Fatal(err)
	}
	runDramaTicks(t, svc, projectID, 10)
	p, _ = svc.repo.DramaProduction(projectID)
	requested, _ := svc.repo.DramaSegment(projectID, detail.Segments[0].ID)
	unselected, _ := svc.repo.DramaSegment(projectID, detail.Segments[1].ID)
	failed, _ := svc.repo.DramaEpisode(projectID, other.ID)
	if !dramaSegmentVideoDone(*requested) || unselected.VideoStatus != "" || failed.Error == "" || p.GuideStep != model.DramaGuideStory || fake.byKind["video"] != 1 || fake.byKind["image"] != 0 || fake.byKind["render"] != 0 {
		t.Fatalf("only explicitly selected ready segment should continue: requested=%+v unselected=%+v failed=%+v production=%+v kinds=%v", requested, unselected, failed, p, fake.byKind)
	}
}

func TestDramaWorkflowEarlierPhasesCannotUseEpisodeMedia(t *testing.T) {
	for _, step := range []string{model.DramaGuideConfiguring, model.DramaGuideAssets} {
		t.Run(step, func(t *testing.T) {
			svc, _, projectID, detail, _ := dramaWorkflowStoryFixture(t)
			if err := svc.repo.UpdateDramaProduction(projectID, map[string]any{"guide_step": step, "media_requests_only": true}); err != nil {
				t.Fatal(err)
			}
			if err := svc.repo.UpdateDramaEpisodeUser(detail.Episode.ID, map[string]any{"video_requests_only": true}); err != nil {
				t.Fatal(err)
			}
			view, err := svc.PreflightDramaStudioAction("usr-drama", projectID, DramaStudioActionRequest{Action: "segment_video", TargetID: detail.Segments[0].ID})
			if err != nil || view.Ready {
				t.Fatalf("earlier phase media must stay blocked: %+v %v", view, err)
			}
			episode, _ := svc.repo.DramaEpisode(projectID, detail.Episode.ID)
			if _, err := svc.RenderDramaEpisode("usr-drama", projectID, episode.ID, RenderDramaEpisodeRequest{ExpectedRevision: &episode.Revision}); err == nil {
				t.Fatal("earlier phase allowed assembly")
			}
		})
	}
}

func TestDramaWorkflowReadinessRequiresValidSegmentShotCoverage(t *testing.T) {
	svc, _, projectID, detail, _ := dramaWorkflowStoryFixture(t)
	p, err := svc.repo.DramaProduction(projectID)
	if err != nil {
		t.Fatal(err)
	}
	shots, err := svc.repo.DramaShots(detail.Episode.ID)
	if err != nil {
		t.Fatal(err)
	}
	storedSegments, err := svc.repo.DramaSegments(detail.Episode.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(storedSegments) < 2 || len(shots) < 2 {
		t.Fatal("fixture needs two segments and shots")
	}
	for _, invalid := range []string{"negative-index", "duplicate-index", "segment-without-shot", "shot-without-segment"} {
		t.Run(invalid, func(t *testing.T) {
			segments := append([]model.DramaSegment(nil), storedSegments...)
			currentShots := append([]model.DramaShot(nil), shots...)
			switch invalid {
			case "negative-index":
				segments[0].SegmentIndex = -1
			case "duplicate-index":
				segments[1].SegmentIndex = segments[0].SegmentIndex
			case "segment-without-shot":
				extra := segments[0]
				extra.SegmentIndex = 999
				segments = append(segments, extra)
			case "shot-without-segment":
				currentShots[0].SegmentIndex = 999
			}
			if reason := dramaWorkflowTextReason(p, &detail.Episode, segments, currentShots); reason == "" {
				t.Fatal("invalid segment and shot coverage must not authorize media")
			}
		})
	}
}

func TestDramaWorkflowBatchSkipsUnreadyEpisodeAndPreservesExactScope(t *testing.T) {
	svc, fake, projectID, detail, other := dramaWorkflowStoryFixture(t)
	otherSegments, _ := svc.repo.DramaSegments(other.ID)
	view, err := svc.PreflightDramaStudioBatch("usr-drama", projectID, DramaStudioBatchRequest{Action: "segment_video", TargetIDs: []string{detail.Segments[0].ID, otherSegments[0].ID}})
	if err != nil || view.Counts["ready"] != 1 || view.Counts["blocked"] != 1 {
		t.Fatalf("batch should classify per-episode readiness: %+v %v", view, err)
	}
	result, err := svc.ExecuteDramaStudioBatch("usr-drama", projectID, confirmedDramaStudioBatch(view))
	if err != nil || result.Counts["queued"] != 1 || result.Counts["blocked"] != 1 {
		t.Fatalf("ready subset should queue atomically: %+v %v", result, err)
	}
	runDramaTicks(t, svc, projectID, 10)
	if fake.byKind["video"] != 1 || fake.byKind["image"] != 0 || fake.byKind["render"] != 0 {
		t.Fatalf("batch expanded beyond ready selected scope: %v", fake.byKind)
	}
}

func TestDramaWorkflowReadinessRechecksWholeEpisodeAndActiveText(t *testing.T) {
	for _, blocker := range []string{"missing-prompt", "active-own-text", "active-other-text", "active-plan"} {
		t.Run(blocker, func(t *testing.T) {
			svc, fake, projectID, detail, other := dramaWorkflowStoryFixture(t)
			preflight, err := svc.PreflightDramaStudioAction("usr-drama", projectID, DramaStudioActionRequest{Action: "segment_video", TargetID: detail.Segments[0].ID})
			if err != nil || !preflight.Ready {
				t.Fatalf("initial preflight: %+v %v", preflight, err)
			}
			if blocker == "missing-prompt" {
				if err := fake.db.Model(&model.DramaSegment{}).Where("id = ?", detail.Segments[1].ID).Updates(map[string]any{"prompt_status": model.DramaMediaFailed, "video_prompt_override": ""}).Error; err != nil {
					t.Fatal(err)
				}
			} else {
				job := model.DramaJob{ID: "workflow-busy-text", ProjectID: projectID, EpisodeID: detail.Episode.ID, ShotID: detail.Segments[1].ID, Kind: model.DramaJobSegmentPrompt, Status: model.DramaJobRunning}
				if blocker == "active-other-text" {
					job.EpisodeID = other.ID
				} else if blocker == "active-plan" {
					job.Kind, job.EpisodeID, job.ShotID = model.DramaJobPlan, "", ""
				}
				if err := svc.repo.CreateDramaJobs([]model.DramaJob{job}); err != nil {
					t.Fatal(err)
				}
			}
			_, err = svc.ExecuteDramaStudioAction("usr-drama", projectID, confirmedDramaStudioRequest(preflight))
			if blocker == "active-other-text" {
				if err != nil {
					t.Fatalf("unrelated episode text must not block: %v", err)
				}
			} else {
				requireGuideConflict(t, err)
				p, _ := svc.repo.DramaProduction(projectID)
				segment, _ := svc.repo.DramaSegment(projectID, detail.Segments[0].ID)
				if p.MediaRequestsOnly || segment.VideoStatus != "" {
					t.Fatal("stale readiness must not authorize media")
				}
			}
		})
	}
}

func TestDramaWorkflowWorkerGateRetainsOnlyExplicitReadyMedia(t *testing.T) {
	svc, fake, projectID, detail, _ := dramaWorkflowStoryFixture(t)
	if err := svc.repo.RestrictDramaImplicitMedia(projectID); err != nil {
		t.Fatal(err)
	}
	if err := svc.repo.UpdateDramaEpisodeUser(detail.Episode.ID, map[string]any{"video_requests_only": true}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.repo.UpdateDramaSegmentRevision(detail.Segments[0].ID, detail.Segments[0].Revision, map[string]any{"video_status": model.DramaMediaQueued}); err != nil {
		t.Fatal(err)
	}
	jobs := []model.DramaJob{
		{ID: "workflow-authorized-video", ProjectID: projectID, EpisodeID: detail.Episode.ID, ShotID: detail.Segments[0].ID, Kind: model.DramaJobSegmentVideo, Status: model.DramaJobQueued},
		{ID: "workflow-unrequested-video", ProjectID: projectID, EpisodeID: detail.Episode.ID, ShotID: detail.Segments[1].ID, Kind: model.DramaJobSegmentVideo, Status: model.DramaJobQueued},
	}
	if err := svc.repo.CreateDramaJobs(jobs); err != nil {
		t.Fatal(err)
	}
	p, _ := svc.repo.DramaProduction(projectID)
	project, _ := svc.repo.ProjectForUser("usr-drama", projectID)
	run := &dramaRun{s: svc, production: p, project: project}
	allowed, err := run.queuedJobsForGuide()
	if err != nil || len(allowed) != 1 || allowed[0].ID != jobs[0].ID {
		t.Fatalf("queue cleanup must preserve exact authorized slot: %+v %v", allowed, err)
	}
	if err := svc.repo.UpdateDramaProduction(projectID, map[string]any{"guide_step": model.DramaGuideAssets}); err != nil {
		t.Fatal(err)
	}
	_, err = svc.persistDramaTask(&jobs[0], &model.Task{ID: "workflow-must-not-persist", UserID: "usr-drama", Type: "video", Status: "queued"}, nil)
	if !errors.Is(err, repository.ErrDramaJobChanged) {
		t.Fatalf("final task binding must recheck workflow gate: %v", err)
	}
	var count int64
	if err := fake.db.Model(&model.Task{}).Where("id = ?", "workflow-must-not-persist").Count(&count).Error; err != nil || count != 0 {
		t.Fatalf("rejected binding persisted a task: %d %v", count, err)
	}
}

func TestDramaWorkflowEpisodeRenderAndFinalConfirmationKeepCompletedMedia(t *testing.T) {
	for _, running := range []bool{false, true} {
		name := "completed"
		if running {
			name = "running"
		}
		t.Run(name, func(t *testing.T) {
			svc, fake, projectID, detail, other := dramaWorkflowStoryFixture(t)
			for _, segment := range detail.Segments {
				resource := fake.resource("usr-drama", "video", "video/mp4")
				if _, err := svc.repo.UpdateDramaSegmentRevision(segment.ID, segment.Revision, map[string]any{"video_status": model.DramaMediaReady, "video_resource_id": resource, "video_seconds": 3}); err != nil {
					t.Fatal(err)
				}
			}
			episode, _ := svc.repo.DramaEpisode(projectID, detail.Episode.ID)
			result, err := svc.RenderDramaEpisode("usr-drama", projectID, episode.ID, RenderDramaEpisodeRequest{ExpectedRevision: &episode.Revision})
			if err != nil || result["jobs"] != 1 {
				t.Fatalf("ready episode should render while other episode is failed: %+v %v", result, err)
			}
			if !running {
				runDramaTicks(t, svc, projectID, 5)
			}
			rendered, _ := svc.repo.DramaEpisode(projectID, episode.ID)
			otherShots, _ := svc.repo.DramaShots(other.ID)
			if err := svc.repo.UpdateDramaEpisodeUser(other.ID, map[string]any{"stage": model.DramaEpisodeReview, "shot_count": len(otherShots), "error": ""}); err != nil {
				t.Fatal(err)
			}
			current := guideSummary(t, svc, projectID)
			if !current.Guide.CanConfirm {
				t.Fatalf("all text is ready: %+v", current.Guide)
			}
			completed := confirmGuide(t, svc, current)
			saved, _ := svc.repo.DramaEpisode(projectID, rendered.ID)
			if completed.Production.GuideStep != model.DramaGuideCompleted || saved.Stage != rendered.Stage || saved.Revision != rendered.Revision || saved.FinalResourceID != rendered.FinalResourceID || saved.FinalStale {
				t.Fatalf("global confirmation rewound independent media: before=%+v after=%+v", rendered, saved)
			}
			runDramaTicks(t, svc, projectID, 5)
			saved, _ = svc.repo.DramaEpisode(projectID, episode.ID)
			if saved.Stage != model.DramaEpisodeDone || saved.FinalResourceID == "" || fake.byKind["render"] != 1 || fake.byKind["video"] != 0 {
				t.Fatalf("confirmed assembly must complete once: %+v %v", saved, fake.byKind)
			}
		})
	}
}

func TestDramaWorkflowStyleCASOnlyChangesFutureStyle(t *testing.T) {
	for _, step := range []string{model.DramaGuideAssets, model.DramaGuideStory, model.DramaGuideCompleted, ""} {
		t.Run("step-"+step, func(t *testing.T) {
			svc, fake, projectID, detail := dramaStudioFixture(t)
			if err := svc.repo.UpdateDramaProduction(projectID, map[string]any{"guide_step": step}); err != nil {
				t.Fatal(err)
			}
			p, _ := svc.repo.DramaProduction(projectID)
			before := parseDramaSettings(p.SettingsJSON)
			updated, err := svc.UpdateDramaWorkflowStyle("usr-drama", projectID, UpdateDramaWorkflowStyleRequest{ExpectedRevision: &p.Revision, StyleName: "手绘水彩", StylePrompt: "透明水彩，柔和边缘"})
			if err != nil || updated.Production.Revision != p.Revision+1 || updated.Production.GuideStep != step || updated.Production.Settings.StyleName != "手绘水彩" || updated.Production.Settings.AspectRatio != before.AspectRatio {
				t.Fatalf("style-only save: %+v %v", updated, err)
			}
			episode, _ := svc.repo.DramaEpisode(projectID, detail.Episode.ID)
			segment, _ := svc.repo.DramaSegment(projectID, detail.Segments[0].ID)
			if episode.Revision != detail.Episode.Revision || segment.Revision != detail.Segments[0].Revision || segment.PromptStatus != detail.Segments[0].PromptStatus || segment.VideoStatus != detail.Segments[0].VideoStatus || fake.byKind["video"] != 0 || fake.byKind["image"] != 0 {
				t.Fatal("style save changed existing work or generated media")
			}
			_, err = svc.UpdateDramaWorkflowStyle("usr-drama", projectID, UpdateDramaWorkflowStyleRequest{ExpectedRevision: &p.Revision, StyleName: "过期风格", StylePrompt: "过期"})
			requireGuideConflict(t, err)
			job := model.DramaJob{ID: "workflow-style-active", ProjectID: projectID, EpisodeID: detail.Episode.ID, Kind: model.DramaJobScript, Status: model.DramaJobRunning}
			if err := svc.repo.CreateDramaJobs([]model.DramaJob{job}); err != nil {
				t.Fatal(err)
			}
			revision := updated.Production.Revision
			_, err = svc.UpdateDramaWorkflowStyle("usr-drama", projectID, UpdateDramaWorkflowStyleRequest{ExpectedRevision: &revision, StyleName: "任务中风格", StylePrompt: "不能保存"})
			requireGuideConflict(t, err)
		})
	}
}
