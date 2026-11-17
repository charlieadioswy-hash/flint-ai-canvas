package app

import (
	"testing"

	"yingce/backend/internal/model"
)

func TestDramaGlobalRetryRegeneratesFailedVideoWithRetainedResult(t *testing.T) {
	for _, taskFailure := range []bool{false, true} {
		t.Run(map[bool]string{false: "submission-failed", true: "provider-task-failed"}[taskFailure], func(t *testing.T) {
			testDramaGlobalRetryRetainedVideo(t, taskFailure)
		})
	}
}

func testDramaGlobalRetryRetainedVideo(t *testing.T, taskFailure bool) {
	t.Helper()
	svc, fake, projectID, detail := dramaStudioFixture(t)
	generate := func() {
		t.Helper()
		view, err := svc.PreflightDramaStudioAction("usr-drama", projectID, DramaStudioActionRequest{Action: "segment_video", TargetID: detail.Segments[0].ID, EpisodeID: detail.Episode.ID})
		if err != nil || !view.Ready {
			t.Fatalf("preflight: %+v %v", view, err)
		}
		if _, err := svc.ExecuteDramaStudioAction("usr-drama", projectID, confirmedDramaStudioRequest(view)); err != nil {
			t.Fatal(err)
		}
	}
	generate()
	runDramaTicks(t, svc, projectID, 5)
	before, err := svc.repo.DramaSegment(projectID, detail.Segments[0].ID)
	if err != nil || before.VideoStatus != model.DramaMediaReady {
		t.Fatalf("initial video: %+v %v", before, err)
	}
	if !taskFailure {
		fake.fail = func(req CreateTaskRequest) bool { return req.Type == "canvas_video" }
	}
	generate()
	if taskFailure {
		runDramaTicks(t, svc, projectID, 1)
		jobs, err := svc.repo.DramaJobsByStatus(projectID, model.DramaJobRunning)
		if err != nil || len(jobs) != 1 || jobs[0].Kind != model.DramaJobSegmentVideo || jobs[0].TaskID == "" {
			t.Fatalf("missing replacement task: %+v %v", jobs, err)
		}
		if err := fake.db.Model(&model.Task{}).Where("id = ?", jobs[0].TaskID).Updates(map[string]any{"status": model.TaskStatusFailed, "result_json": "", "error": "provider failed"}).Error; err != nil {
			t.Fatal(err)
		}
	}
	runDramaTicks(t, svc, projectID, 3)
	failed, err := svc.repo.DramaSegment(projectID, before.ID)
	if err != nil || failed.VideoStatus != model.DramaMediaFailed || failed.VideoResourceID != before.VideoResourceID {
		t.Fatalf("failed regeneration must retain previous video: %+v %v", failed, err)
	}
	fake.fail = nil
	beforeRetry := fake.byKind["video"]
	for i := 0; i < 2; i++ {
		if _, err := svc.RetryFailedDrama("usr-drama", projectID); err != nil {
			t.Fatal(err)
		}
	}
	queued, err := svc.repo.DramaSegment(projectID, before.ID)
	if err != nil || queued.VideoStatus != model.DramaMediaQueued || queued.VideoResourceID != before.VideoResourceID {
		t.Fatalf("retry must queue once and retain old video until replacement: %+v %v", queued, err)
	}
	runDramaTicks(t, svc, projectID, 8)
	after, err := svc.repo.DramaSegment(projectID, before.ID)
	if err != nil || after.VideoStatus != model.DramaMediaReady || after.VideoResourceID == before.VideoResourceID || fake.byKind["video"] != beforeRetry+1 {
		t.Fatalf("retry must produce one replacement: %+v calls=%v err=%v", after, fake.byKind, err)
	}
	jobs, err := svc.repo.DramaJobsByStatus(projectID, model.DramaJobQueued, model.DramaJobRunning)
	if err != nil || len(jobs) != 0 {
		t.Fatalf("retry left active jobs: %+v %v", jobs, err)
	}
}
