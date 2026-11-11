package app

import (
	"encoding/json"
	"testing"
	"time"

	"yingce/backend/internal/model"
)

func seedDramaRenderRetry(t *testing.T, succeeded bool) (*Service, *fakeDramaBackend, string, model.DramaEpisode, model.DramaJob) {
	t.Helper()
	svc, fake, projectID, detail := dramaStudioFixture(t)
	p, _ := svc.repo.DramaProduction(projectID)
	settings := parseDramaSettings(p.SettingsJSON)
	settings.MediaMode, settings.ReviewMode = DramaMediaAuto, DramaReviewAuto
	if err := svc.repo.UpdateDramaProduction(projectID, map[string]any{"settings_json": encodeDramaSettings(settings), "status": model.DramaStatusPaused, "guide_step": model.DramaGuideCompleted}); err != nil {
		t.Fatal(err)
	}
	for _, segment := range detail.Segments {
		if err := svc.repo.UpdateDramaSegmentFields(segment.ID, map[string]any{"video_status": model.DramaMediaReady, "video_seconds": 5, "video_resource_id": fake.resource("usr-drama", "video", "video/mp4"), "tail_frame_resource_id": fake.resource("usr-drama", "image", "image/png")}); err != nil {
			t.Fatal(err)
		}
	}
	if err := fake.db.Model(&model.DramaEpisode{}).Where("id = ?", detail.Episode.ID).Updates(map[string]any{"stage": model.DramaEpisodeRender, "error": "合成失败", "final_resource_id": "previous-final", "final_stale": true}).Error; err != nil {
		t.Fatal(err)
	}
	episode, _ := svc.repo.DramaEpisode(projectID, detail.Episode.ID)
	task := model.Task{ID: newID(), UserID: "usr-drama", ProjectID: projectID, Type: model.TaskTypeTimelineRender, Status: model.TaskStatusFailed}
	if succeeded {
		task.Status = model.TaskStatusSucceeded
		result, _ := json.Marshal(timelineRenderResult{ResourceID: fake.resource("usr-drama", "video", "video/mp4"), DurationMs: 11000})
		task.ResultJSON = string(result)
	}
	job := model.DramaJob{ID: newID(), ProjectID: projectID, EpisodeID: episode.ID, Kind: model.DramaJobRender, Status: model.DramaJobFailed, TaskID: task.ID, Error: episode.Error, PayloadJSON: encodeDramaRevision(episode.Revision), CreatedAt: time.Now()}
	for _, row := range []any{&task, &job} {
		if err := fake.db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	return svc, fake, projectID, *episode, job
}

func TestDramaEpisodeRenderRetryResumesOnlyCurrentAssembly(t *testing.T) {
	svc, fake, projectID, episode, job := seedDramaRenderRetry(t, false)
	segments, _ := svc.repo.DramaSegments(episode.ID)
	casts, _ := svc.repo.DramaCasts(projectID)
	if len(casts) == 0 {
		t.Fatal("fixture must contain assets")
	}
	if err := svc.repo.UpdateDramaCastFields(casts[0].ID, map[string]any{"image_status": model.DramaMediaFailed}); err != nil {
		t.Fatal(err)
	}
	other := model.DramaEpisode{ID: newID(), ProjectID: projectID, Number: 90, Stage: model.DramaEpisodeRender, Revision: 5, Error: "其他集的合成失败"}
	otherJob := model.DramaJob{ID: newID(), ProjectID: projectID, EpisodeID: other.ID, Kind: model.DramaJobRender, Status: model.DramaJobFailed, Error: other.Error, PayloadJSON: encodeDramaRevision(other.Revision)}
	oldJob := job
	oldJob.ID, oldJob.CreatedAt, oldJob.Error = newID(), time.Now().Add(-time.Hour), "历史合成失败"
	for _, row := range []any{&other, &otherJob, &oldJob} {
		if err := fake.db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	result, err := svc.RetryFailedDramaEpisodeRender("usr-drama", projectID, episode.ID)
	if err != nil || result["jobs"] != 1 {
		t.Fatalf("retry render: %+v %v", result, err)
	}
	current, _ := svc.repo.DramaEpisode(projectID, episode.ID)
	if current.Error != "" || current.Revision != episode.Revision || current.FinalResourceID != episode.FinalResourceID {
		t.Fatalf("retry must preserve episode version and previous final: %+v", current)
	}
	result, err = svc.RetryFailedDramaEpisodeRender("usr-drama", projectID, episode.ID)
	if err != nil || result["jobs"] != 0 {
		t.Fatalf("duplicate retry: %+v %v", result, err)
	}
	runDramaTicks(t, svc, projectID, 8)
	current, _ = svc.repo.DramaEpisode(projectID, episode.ID)
	if current.Stage != model.DramaEpisodeDone || current.FinalStale || fake.byKind["render"] != 1 || fake.byKind["image"] != 0 || fake.byKind["video"] != 0 {
		t.Fatalf("only assembly may resume: %+v calls=%v", current, fake.byKind)
	}
	for _, before := range segments {
		after, _ := svc.repo.DramaSegment(projectID, before.ID)
		if after.VideoResourceID != before.VideoResourceID || after.Revision != before.Revision || after.VideoStatus != before.VideoStatus || after.VideoPromptOverride != before.VideoPromptOverride {
			t.Fatalf("successful video changed: before=%+v after=%+v", before, after)
		}
	}
	cast, _ := svc.repo.DramaCast(projectID, casts[0].ID)
	if cast.ImageStatus != model.DramaMediaFailed {
		t.Fatalf("render retry must not retry an asset: %+v", cast)
	}
	for _, before := range []model.DramaJob{job, oldJob, otherJob} {
		var after model.DramaJob
		if err := fake.db.First(&after, "id = ?", before.ID).Error; err != nil || after.Status != before.Status || after.Error != before.Error || after.TaskID != before.TaskID {
			t.Fatalf("historical or other jobs changed: %+v %v", after, err)
		}
	}
	otherCurrent, _ := svc.repo.DramaEpisode(projectID, other.ID)
	if otherCurrent.Error != other.Error {
		t.Fatalf("other episode failure cleared: %+v", otherCurrent)
	}
}

func TestDramaEpisodeRenderRetryReusesSuccessfulResult(t *testing.T) {
	svc, fake, projectID, episode, job := seedDramaRenderRetry(t, true)
	result, err := svc.RetryFailedDramaEpisodeRender("usr-drama", projectID, episode.ID)
	if err != nil || result["jobs"] != 1 {
		t.Fatalf("replay render: %+v %v", result, err)
	}
	runDramaTicks(t, svc, projectID, 2)
	var currentJob model.DramaJob
	if err := fake.db.First(&currentJob, "id = ?", job.ID).Error; err != nil {
		t.Fatal(err)
	}
	current, _ := svc.repo.DramaEpisode(projectID, episode.ID)
	if currentJob.Status != model.DramaJobSucceeded || currentJob.TaskID != job.TaskID || current.Stage != model.DramaEpisodeDone || current.Error != "" || fake.byKind["render"]+fake.byKind["image"]+fake.byKind["video"] != 0 {
		t.Fatalf("successful result must be reapplied without generating again: %+v %+v calls=%v", currentJob, current, fake.byKind)
	}
}

func TestDramaEpisodeRenderRetryRejectsUnauthorizedAndGuideRequests(t *testing.T) {
	svc, fake, projectID, episode, _ := seedDramaRenderRetry(t, false)
	for _, args := range []struct{ user, episode string }{{"someone", episode.ID}, {"usr-drama", ""}, {"usr-drama", "  "}, {"usr-drama", "missing"}} {
		if _, err := svc.RetryFailedDramaEpisodeRender(args.user, projectID, args.episode); err == nil {
			t.Fatalf("must reject unauthorized or invalid scope: %+v", args)
		}
	}
	other := model.DramaEpisode{ID: newID(), ProjectID: "other-project", Stage: model.DramaEpisodeRender, Error: "失败"}
	if err := fake.db.Create(&other).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := svc.RetryFailedDramaEpisodeRender("usr-drama", projectID, other.ID); err == nil {
		t.Fatal("must reject another project's episode")
	}
	if err := svc.repo.UpdateDramaProduction(projectID, map[string]any{"guide_step": model.DramaGuideStory}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.RetryFailedDramaEpisodeRender("usr-drama", projectID, episode.ID); err == nil {
		t.Fatal("must not render before guide completion")
	}
}

func TestDramaEpisodeRenderRetrySkipsStaleAndSupersededJobs(t *testing.T) {
	for _, latest := range []string{"stale", model.DramaJobQueued, model.DramaJobRunning, model.DramaJobSucceeded} {
		t.Run(latest, func(t *testing.T) {
			svc, fake, projectID, episode, job := seedDramaRenderRetry(t, false)
			if latest == "stale" {
				job.PayloadJSON = encodeDramaRevision(episode.Revision - 1)
				if err := svc.repo.SaveDramaJob(&job); err != nil {
					t.Fatal(err)
				}
			} else {
				job.ID, job.Status, job.CreatedAt = newID(), latest, time.Now().Add(time.Minute)
				if err := fake.db.Create(&job).Error; err != nil {
					t.Fatal(err)
				}
			}
			result, err := svc.RetryFailedDramaEpisodeRender("usr-drama", projectID, episode.ID)
			current, _ := svc.repo.DramaEpisode(projectID, episode.ID)
			if err != nil || result["jobs"] != 0 || current.Error != episode.Error {
				t.Fatalf("must not revive stale failure: %+v %+v %v", result, current, err)
			}
		})
	}
}
