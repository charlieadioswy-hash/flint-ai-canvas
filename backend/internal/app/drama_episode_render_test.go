package app

import (
	"sync"
	"testing"

	"yingce/backend/internal/model"
	"yingce/backend/internal/platform"
)

func readyDramaEpisodeForRender(t *testing.T) (*Service, *fakeDramaBackend, string, model.DramaEpisode) {
	t.Helper()
	svc, fake, projectID, detail := dramaStudioFixture(t)
	svc.coordinator = platform.NewCoordinatorWithRedis(nil, t.Name())
	sqlDB, _ := fake.db.DB()
	sqlDB.SetMaxOpenConns(1)
	if err := svc.repo.UpdateDramaProduction(projectID, map[string]any{"status": model.DramaStatusPaused, "guide_step": model.DramaGuideCompleted}); err != nil {
		t.Fatal(err)
	}
	for _, segment := range detail.Segments {
		if err := svc.repo.UpdateDramaSegmentFields(segment.ID, map[string]any{"video_status": model.DramaMediaReady, "video_seconds": 5, "video_resource_id": fake.resource("usr-drama", "video", "video/mp4"), "tail_frame_resource_id": fake.resource("usr-drama", "image", "image/png")}); err != nil {
			t.Fatal(err)
		}
	}
	if err := fake.db.Model(&model.DramaEpisode{}).Where("id = ?", detail.Episode.ID).Updates(map[string]any{"stage": model.DramaEpisodeVideo, "video_requests_only": true}).Error; err != nil {
		t.Fatal(err)
	}
	episode, err := svc.repo.DramaEpisode(projectID, detail.Episode.ID)
	if err != nil {
		t.Fatal(err)
	}
	return svc, fake, projectID, *episode
}

func TestRenderDramaEpisodeOnlyAssemblesAdoptedVideos(t *testing.T) {
	svc, fake, projectID, episode := readyDramaEpisodeForRender(t)
	before, _ := svc.repo.DramaSegments(episode.ID)
	casts, _ := svc.repo.DramaCasts(projectID)
	if len(casts) == 0 {
		t.Fatal("fixture must have assets")
	}
	if err := svc.repo.UpdateDramaCastFields(casts[0].ID, map[string]any{"image_status": model.DramaMediaFailed}); err != nil {
		t.Fatal(err)
	}
	req := RenderDramaEpisodeRequest{ExpectedRevision: &episode.Revision}
	for i, want := range []int{1, 0} {
		result, err := svc.RenderDramaEpisode("usr-drama", projectID, episode.ID, req)
		if err != nil || result["jobs"] != want {
			t.Fatalf("request %d: %+v %v", i, result, err)
		}
	}
	runDramaTicks(t, svc, projectID, 8)
	current, _ := svc.repo.DramaEpisode(projectID, episode.ID)
	if current.Stage != model.DramaEpisodeDone || current.FinalStale || current.FinalResourceID == "" || fake.byKind["render"] != 1 || fake.byKind["image"] != 0 || fake.byKind["video"] != 0 {
		t.Fatalf("only requested assembly may run: episode=%+v calls=%v", current, fake.byKind)
	}
	if !current.VideoRequestsOnly || current.MediaReleased || current.Approved || current.Revision != episode.Revision {
		t.Fatalf("render must retain episode scope and version: %+v", current)
	}
	p, _ := svc.repo.DramaProduction(projectID)
	if p.MediaRequestsOnly || p.AssetsReleased || p.Status != model.DramaStatusPaused {
		t.Fatalf("render must not change production scope or resume it: %+v", p)
	}
	cast, _ := svc.repo.DramaCast(projectID, casts[0].ID)
	if cast.ImageStatus != model.DramaMediaFailed {
		t.Fatalf("render retried failed asset: %+v", cast)
	}
	for _, old := range before {
		new, _ := svc.repo.DramaSegment(projectID, old.ID)
		if old.VideoResourceID != new.VideoResourceID || old.VideoStatus != new.VideoStatus || old.Revision != new.Revision {
			t.Fatalf("render changed adopted video: old=%+v new=%+v", old, new)
		}
	}
	// Explicit recomposition keeps the existing final available until the replacement succeeds.
	previousFinal := current.FinalResourceID
	result, err := svc.RenderDramaEpisode("usr-drama", projectID, episode.ID, req)
	current, _ = svc.repo.DramaEpisode(projectID, episode.ID)
	if err != nil || result["jobs"] != 1 || current.FinalResourceID != previousFinal || !current.FinalStale {
		t.Fatalf("recompose: %+v %+v %v", result, current, err)
	}
	runDramaTicks(t, svc, projectID, 8)
	current, _ = svc.repo.DramaEpisode(projectID, episode.ID)
	if current.FinalResourceID == previousFinal || current.FinalStale || fake.byKind["render"] != 2 || fake.byKind["image"]+fake.byKind["video"] != 0 {
		t.Fatalf("recompose did not replace only final: %+v calls=%v", current, fake.byKind)
	}
}

func TestRenderDramaEpisodeRejectsIncompleteStaleAndForeignVideos(t *testing.T) {
	for _, issue := range []string{"missing", "stale", "running", "resource", "foreign-resource", "duration", "missing-segment", "revision", "guide", "foreign-user", "foreign-episode", "missing-revision"} {
		t.Run(issue, func(t *testing.T) {
			svc, fake, projectID, episode := readyDramaEpisodeForRender(t)
			segments, _ := svc.repo.DramaSegments(episode.ID)
			req := RenderDramaEpisodeRequest{ExpectedRevision: &episode.Revision}
			userID, episodeID := "usr-drama", episode.ID
			fields := map[string]any{}
			switch issue {
			case "missing":
				fields["video_status"], fields["video_resource_id"] = "", ""
			case "stale":
				fields["video_status"] = model.DramaMediaStale
			case "running":
				fields["video_status"] = model.DramaMediaRunning
			case "resource":
				fields["video_resource_id"] = "missing-resource"
			case "foreign-resource":
				fields["video_resource_id"] = fake.resource("other-user", "video", "video/mp4")
			case "duration":
				fields["video_seconds"] = 0
			case "missing-segment":
				if err := fake.db.Delete(&model.DramaSegment{}, "id = ?", segments[0].ID).Error; err != nil {
					t.Fatal(err)
				}
			case "revision":
				old := episode.Revision - 1
				req.ExpectedRevision = &old
			case "guide":
				if err := svc.repo.UpdateDramaProduction(projectID, map[string]any{"guide_step": model.DramaGuideStory}); err != nil {
					t.Fatal(err)
				}
			case "foreign-user":
				userID = "someone"
			case "foreign-episode":
				other := model.DramaEpisode{ID: newID(), ProjectID: "other-project", Revision: episode.Revision}
				if err := fake.db.Create(&other).Error; err != nil {
					t.Fatal(err)
				}
				episodeID = other.ID
			case "missing-revision":
				req.ExpectedRevision = nil
			}
			if len(fields) > 0 {
				if err := svc.repo.UpdateDramaSegmentFields(segments[0].ID, fields); err != nil {
					t.Fatal(err)
				}
			}
			if result, err := svc.RenderDramaEpisode(userID, projectID, episodeID, req); err == nil {
				t.Fatalf("must reject %s: %+v", issue, result)
			}
			jobs, _ := svc.repo.DramaJobsByStatus(projectID, model.DramaJobQueued, model.DramaJobRunning)
			for _, job := range jobs {
				if job.Kind == model.DramaJobRender {
					t.Fatalf("rejected request queued render: %+v", job)
				}
			}
		})
	}
}

func TestRenderDramaEpisodeConcurrentRequestsAreIdempotent(t *testing.T) {
	svc, _, projectID, episode := readyDramaEpisodeForRender(t)
	const requests = 4
	results := make(chan int, requests)
	errors := make(chan error, requests)
	var wait sync.WaitGroup
	for i := 0; i < requests; i++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			result, err := svc.RenderDramaEpisode("usr-drama", projectID, episode.ID, RenderDramaEpisodeRequest{ExpectedRevision: &episode.Revision})
			if err != nil {
				errors <- err
				return
			}
			results <- result["jobs"].(int)
		}()
	}
	wait.Wait()
	close(results)
	close(errors)
	for err := range errors {
		t.Errorf("concurrent request: %v", err)
	}
	queued := 0
	for count := range results {
		queued += count
	}
	if queued != 1 {
		t.Fatalf("queued %d render jobs, want 1", queued)
	}
}

func TestRenderDramaEpisodeNeedsNoModelsCreditsOrBudgetResume(t *testing.T) {
	svc, fake, projectID, episode := readyDramaEpisodeForRender(t)
	svc.dramaTaskHook = nil
	settings := parseDramaSettings("{}")
	if err := svc.repo.UpdateDramaProduction(projectID, map[string]any{"settings_json": encodeDramaSettings(settings), "budget_microcredits": 100, "pause_reason": dramaBudgetPauseReason}); err != nil {
		t.Fatal(err)
	}
	seedDramaBillingOrder(t, fake.db, projectID, "render-held", model.BillingOrder{AmountMicrocredits: 100, Status: model.BillingStatusReserved})
	before, _ := svc.repo.DramaProduction(projectID)
	for _, want := range []int{1, 0} {
		result, err := svc.RenderDramaEpisode("usr-drama", projectID, episode.ID, RenderDramaEpisodeRequest{ExpectedRevision: &episode.Revision})
		if err != nil || result["jobs"] != want {
			t.Fatalf("local render without generation admission: %+v %v", result, err)
		}
	}
	jobs, _ := svc.repo.DramaJobsByStatus(projectID, model.DramaJobQueued, model.DramaJobRunning)
	if len(jobs) != 1 || jobs[0].Kind != model.DramaJobRender || jobs[0].Status != model.DramaJobRunning {
		t.Fatalf("only local render should be submitted: %+v", jobs)
	}
	var task model.Task
	if err := fake.db.First(&task, "id = ?", jobs[0].TaskID).Error; err != nil || task.Type != model.TaskTypeTimelineRender || task.Status != model.TaskStatusQueued || task.Provider != "local" || task.BillingOrderID != "" {
		t.Fatalf("must use ordinary free local worker queue: %+v %v", task, err)
	}
	after, _ := svc.repo.DramaProduction(projectID)
	if before.Status != after.Status || before.PauseReason != after.PauseReason || before.MediaRequestsOnly != after.MediaRequestsOnly || before.AssetsReleased != after.AssetsReleased || before.SettingsJSON != after.SettingsJSON {
		t.Fatalf("local render altered production: before=%+v after=%+v", before, after)
	}
}

func TestRenderDramaEpisodeRetriesOnlyFailedAssembly(t *testing.T) {
	svc, fake, projectID, episode, oldJob := seedDramaRenderRetry(t, false)
	svc.coordinator = platform.NewCoordinatorWithRedis(nil, t.Name())
	result, err := svc.RenderDramaEpisode("usr-drama", projectID, episode.ID, RenderDramaEpisodeRequest{ExpectedRevision: &episode.Revision})
	if err != nil || result["jobs"] != 1 {
		t.Fatalf("retry: %+v %v", result, err)
	}
	runDramaTicks(t, svc, projectID, 8)
	current, _ := svc.repo.DramaEpisode(projectID, episode.ID)
	if current.Stage != model.DramaEpisodeDone || current.Error != "" || fake.byKind["render"] != 1 || fake.byKind["image"]+fake.byKind["video"] != 0 {
		t.Fatalf("retry: %+v calls=%v", current, fake.byKind)
	}
	var historical model.DramaJob
	if err := fake.db.First(&historical, "id = ?", oldJob.ID).Error; err != nil || historical.Status != model.DramaJobFailed {
		t.Fatalf("failed historical job must remain available: %+v %v", historical, err)
	}
}

func TestRenderDramaEpisodeDiscardsOutdatedQueuedRevision(t *testing.T) {
	svc, fake, projectID, episode := readyDramaEpisodeForRender(t)
	old := episode.Revision - 1
	job := model.DramaJob{ProjectID: projectID, EpisodeID: episode.ID, Kind: model.DramaJobRender, PayloadJSON: encodeDramaRevision(old)}
	if err := fake.db.Model(&model.DramaEpisode{}).Where("id = ?", episode.ID).Update("stage", model.DramaEpisodeRender).Error; err != nil {
		t.Fatal(err)
	}
	p, _ := svc.repo.DramaProduction(projectID)
	run := &dramaRun{s: svc, project: &model.Project{ID: projectID, UserID: "usr-drama"}, production: p}
	if task, skipped, err := run.submitRender(&job); err != nil || !skipped || task != nil || fake.byKind["render"] != 0 {
		t.Fatalf("old queued version must not render new videos: %+v %v %v", task, skipped, err)
	}
}

func TestRenderDramaEpisodeRejectsAnActiveOldVersion(t *testing.T) {
	for _, status := range []string{model.DramaJobQueued, model.DramaJobRunning} {
		t.Run(status, func(t *testing.T) {
			svc, fake, projectID, episode := readyDramaEpisodeForRender(t)
			old := episode.Revision - 1
			job := model.DramaJob{ID: newID(), ProjectID: projectID, EpisodeID: episode.ID, Kind: model.DramaJobRender, Status: status, PayloadJSON: encodeDramaRevision(old)}
			if status == model.DramaJobQueued {
				job.TaskID = "already-bound-task"
			}
			if err := fake.db.Create(&job).Error; err != nil {
				t.Fatal(err)
			}
			if err := fake.db.Model(&model.DramaEpisode{}).Where("id = ?", episode.ID).Update("stage", model.DramaEpisodeRender).Error; err != nil {
				t.Fatal(err)
			}
			if _, err := svc.RenderDramaEpisode("usr-drama", projectID, episode.ID, RenderDramaEpisodeRequest{ExpectedRevision: &episode.Revision}); err == nil || fake.byKind["render"] != 0 {
				t.Fatalf("must not reuse old active render: %v calls=%v", err, fake.byKind)
			}
		})
	}
}

func TestRenderDramaEpisodeRecoversUnboundQueuedAssembly(t *testing.T) {
	svc, fake, projectID, episode := readyDramaEpisodeForRender(t)
	job := model.DramaJob{ID: newID(), ProjectID: projectID, EpisodeID: episode.ID, Kind: model.DramaJobRender, Status: model.DramaJobQueued}
	if err := fake.db.Create(&job).Error; err != nil {
		t.Fatal(err)
	}
	if err := fake.db.Model(&model.DramaEpisode{}).Where("id = ?", episode.ID).Update("stage", model.DramaEpisodeRender).Error; err != nil {
		t.Fatal(err)
	}
	result, err := svc.RenderDramaEpisode("usr-drama", projectID, episode.ID, RenderDramaEpisodeRequest{ExpectedRevision: &episode.Revision})
	if err != nil || result["jobs"] != 0 || fake.byKind["render"] != 1 {
		t.Fatalf("resume queued assembly: %+v %v calls=%v", result, err, fake.byKind)
	}
	var bound model.DramaJob
	if err := fake.db.First(&bound, "id = ?", job.ID).Error; err != nil || bound.Status != model.DramaJobRunning || bound.TaskID == "" || bound.PayloadJSON != encodeDramaRevision(episode.Revision) {
		t.Fatalf("must bind original job and current revision: %+v %v", bound, err)
	}
	runDramaTicks(t, svc, projectID, 2)
	current, _ := svc.repo.DramaEpisode(projectID, episode.ID)
	if current.Stage != model.DramaEpisodeDone || current.FinalResourceID == "" || fake.byKind["render"] != 1 {
		t.Fatalf("recovered assembly must apply normally: %+v calls=%v", current, fake.byKind)
	}
}

func TestRenderDramaEpisodeDoesNotReplaceBoundQueuedTask(t *testing.T) {
	svc, fake, projectID, episode := readyDramaEpisodeForRender(t)
	job := model.DramaJob{ID: newID(), ProjectID: projectID, EpisodeID: episode.ID, Kind: model.DramaJobRender, Status: model.DramaJobQueued, TaskID: "existing-render-task", PayloadJSON: encodeDramaRevision(episode.Revision)}
	if err := fake.db.Create(&job).Error; err != nil {
		t.Fatal(err)
	}
	if err := fake.db.Model(&model.DramaEpisode{}).Where("id = ?", episode.ID).Update("stage", model.DramaEpisodeRender).Error; err != nil {
		t.Fatal(err)
	}
	result, err := svc.RenderDramaEpisode("usr-drama", projectID, episode.ID, RenderDramaEpisodeRequest{ExpectedRevision: &episode.Revision})
	if err != nil || result["jobs"] != 0 || fake.byKind["render"] != 0 {
		t.Fatalf("bound queued task must remain unique: %+v %v calls=%v", result, err, fake.byKind)
	}
	var current model.DramaJob
	if err := fake.db.First(&current, "id = ?", job.ID).Error; err != nil || current.TaskID != job.TaskID || current.Status != job.Status || current.PayloadJSON != job.PayloadJSON {
		t.Fatalf("bound queued job must remain unchanged: %+v %v", current, err)
	}
}

func TestRenderDramaEpisodeReplacesUnboundOldQueuedAssembly(t *testing.T) {
	svc, fake, projectID, episode := readyDramaEpisodeForRender(t)
	old := episode.Revision - 1
	job := model.DramaJob{ID: newID(), ProjectID: projectID, EpisodeID: episode.ID, Kind: model.DramaJobRender, Status: model.DramaJobQueued, PayloadJSON: encodeDramaRevision(old)}
	if err := fake.db.Create(&job).Error; err != nil {
		t.Fatal(err)
	}
	result, err := svc.RenderDramaEpisode("usr-drama", projectID, episode.ID, RenderDramaEpisodeRequest{ExpectedRevision: &episode.Revision})
	if err != nil || result["jobs"] != 1 || fake.byKind["render"] != 1 {
		t.Fatalf("replace obsolete queued assembly: %+v %v calls=%v", result, err, fake.byKind)
	}
	var obsolete model.DramaJob
	if err := fake.db.First(&obsolete, "id = ?", job.ID).Error; err != nil || obsolete.Status != model.DramaJobCanceled || obsolete.TaskID != "" {
		t.Fatalf("old unbound job must be canceled: %+v %v", obsolete, err)
	}
	runDramaTicks(t, svc, projectID, 2)
	current, _ := svc.repo.DramaEpisode(projectID, episode.ID)
	p, _ := svc.repo.DramaProduction(projectID)
	if current.Stage != model.DramaEpisodeDone || current.FinalResourceID == "" || fake.byKind["render"] != 1 || p.Status != model.DramaStatusPaused {
		t.Fatalf("new current revision must finish without resuming other work: %+v %+v calls=%v", current, p, fake.byKind)
	}
}

func TestRenderDramaEpisodeHandlesUnversionedAssemblyAfterAdoption(t *testing.T) {
	for _, test := range []struct {
		name, status, taskID string
	}{
		{name: "unbound", status: model.DramaJobQueued},
		{name: "bound", status: model.DramaJobQueued, taskID: "existing-render-task"},
		{name: "running", status: model.DramaJobRunning, taskID: "existing-render-task"},
	} {
		t.Run(test.name, func(t *testing.T) {
			svc, fake, projectID, episode := readyDramaEpisodeForRender(t)
			if err := fake.db.Model(&model.DramaEpisode{}).Where("id = ?", episode.ID).Update("stage", model.DramaEpisodeRender).Error; err != nil {
				t.Fatal(err)
			}
			episode.Stage = model.DramaEpisodeRender
			p, _ := svc.repo.DramaProduction(projectID)
			project, _ := svc.repo.ProjectForUser("usr-drama", projectID)
			run := &dramaRun{s: svc, project: project, production: p, settings: parseDramaSettings(p.SettingsJSON), active: map[string]bool{}}
			if err := run.advanceEpisode(&episode, episode.Stage); err != nil {
				t.Fatal(err)
			}
			if len(run.newJobs) != 1 || run.newJobs[0].PayloadJSON != "" {
				t.Fatalf("automatic assembly must start without a bound revision: %+v", run.newJobs)
			}
			run.newJobs[0].Status, run.newJobs[0].TaskID = test.status, test.taskID
			if err := run.persistJobs(); err != nil {
				t.Fatal(err)
			}
			segments, _ := svc.repo.DramaSegments(episode.ID)
			newVideoID := fake.resource("usr-drama", "video", "video/mp4")
			if err := fake.db.Model(&model.Resource{}).Where("id = ?", newVideoID).Update("duration_ms", 5000).Error; err != nil {
				t.Fatal(err)
			}
			if _, err := svc.adoptDramaSegmentVideoDeferred("usr-drama", projectID, episode.ID, segments[0].SegmentIndex, AdoptDramaSegmentVideoRequest{ResourceID: newVideoID}); err != nil {
				t.Fatal(err)
			}
			current, _ := svc.repo.DramaEpisode(projectID, episode.ID)
			if current.Stage != model.DramaEpisodeVideo || current.Revision == episode.Revision {
				t.Fatalf("adopting a new video must rewind assembly: %+v", current)
			}
			result, err := svc.RenderDramaEpisode("usr-drama", projectID, episode.ID, RenderDramaEpisodeRequest{ExpectedRevision: &current.Revision})
			var oldJob model.DramaJob
			if loadErr := fake.db.First(&oldJob, "id = ?", run.newJobs[0].ID).Error; loadErr != nil {
				t.Fatal(loadErr)
			}
			if test.taskID != "" {
				if err == nil || fake.byKind["render"] != 0 || oldJob.Status != test.status || oldJob.TaskID != test.taskID {
					t.Fatalf("bound or running assembly must remain protected: job=%+v calls=%v error=%v", oldJob, fake.byKind, err)
				}
				return
			}
			if err != nil || result["jobs"] != 1 || oldJob.Status != model.DramaJobCanceled || oldJob.TaskID != "" {
				t.Fatalf("unbound old assembly must be replaced: job=%+v result=%v error=%v", oldJob, result, err)
			}
			if len(fake.renders) != 1 || fake.renders[0].Clips[0].DirectMedia.ID != newVideoID {
				t.Fatalf("assembly must use the newly adopted video: %+v", fake.renders)
			}
			runDramaTicks(t, svc, projectID, 2)
			current, _ = svc.repo.DramaEpisode(projectID, episode.ID)
			p, _ = svc.repo.DramaProduction(projectID)
			if current.Stage != model.DramaEpisodeDone || current.FinalResourceID == "" || current.FinalStale || p.Status != model.DramaStatusPaused || fake.byKind["render"] != 1 || fake.byKind["image"]+fake.byKind["video"] != 0 {
				t.Fatalf("new assembly must finish without resuming generation: episode=%+v production=%+v calls=%v", current, p, fake.byKind)
			}
		})
	}
}
