package app

import (
	"errors"
	"testing"

	"yingce/backend/internal/model"
	"yingce/backend/internal/repository"
)

func TestDramaWorkflowRenderPersistsSelectedVideoSource(t *testing.T) {
	for _, source := range []string{"shots", "segments"} {
		t.Run(source, func(t *testing.T) {
			svc, fake, projectID, episode := readyDramaEpisodeForRender(t)
			if err := svc.repo.UpdateDramaProduction(projectID, map[string]any{"guide_step": model.DramaGuideStory}); err != nil {
				t.Fatal(err)
			}
			if source == "shots" {
				adoptedDramaShotVideos(t, svc, fake, projectID, episode.ID)
				if err := fake.db.Model(&model.DramaSegment{}).Where("episode_id = ?", episode.ID).
					Updates(map[string]any{"video_status": "", "video_resource_id": "", "video_seconds": 0}).Error; err != nil {
					t.Fatal(err)
				}
			}
			p, err := svc.repo.DramaProduction(projectID)
			if err != nil {
				t.Fatal(err)
			}
			ready, err := dramaWorkflowEpisodeReadiness(svc.repo, p, &episode)
			if err != nil || !ready.CanRender || ready.RenderSource != source || source == "shots" && ready.ReadyVideos != 0 {
				t.Fatalf("selected source must be independently renderable: %+v %v", ready, err)
			}
			// Use the real task admission and binding path; the fake executor bypasses its guide gate.
			svc.dramaTaskHook = nil
			result, err := svc.RenderDramaEpisode("usr-drama", projectID, episode.ID, RenderDramaEpisodeRequest{ExpectedRevision: &episode.Revision})
			if err != nil || result["jobs"] != 1 {
				t.Fatalf("ready %s must pass the story-stage persistence gate: %+v %v", source, result, err)
			}
			jobs, err := svc.repo.DramaJobsByStatus(projectID, model.DramaJobQueued, model.DramaJobRunning)
			if err != nil || len(jobs) != 1 || jobs[0].Kind != model.DramaJobRender || jobs[0].Status != model.DramaJobRunning {
				t.Fatalf("render job must bind once: %+v %v", jobs, err)
			}
			task, err := svc.repo.Task(jobs[0].TaskID)
			if err != nil || task.Type != model.TaskTypeTimelineRender || task.Status != model.TaskStatusQueued || task.Provider != "local" {
				t.Fatalf("render must use the persisted local worker queue: %+v %v", task, err)
			}
			p, err = svc.repo.DramaProduction(projectID)
			if err != nil {
				t.Fatal(err)
			}
			current, err := svc.repo.DramaEpisode(projectID, episode.ID)
			if err != nil {
				t.Fatal(err)
			}
			if p.GuideStep != model.DramaGuideStory || !p.MediaRequestsOnly || !current.VideoRequestsOnly || current.Revision != episode.Revision {
				t.Fatalf("render must retain the guide, revision and explicit media scope: production=%+v episode=%+v", p, current)
			}
		})
	}
}

func TestDramaWorkflowRenderBindingRejectsInvalidAdoptedShots(t *testing.T) {
	for _, issue := range []string{"missing-slot", "stale", "script-changed", "missing-resource"} {
		t.Run(issue, func(t *testing.T) {
			svc, fake, projectID, episode := readyDramaEpisodeForRender(t)
			_, rows, _ := adoptedDramaShotVideos(t, svc, fake, projectID, episode.ID)
			if err := svc.repo.UpdateDramaProduction(projectID, map[string]any{"guide_step": model.DramaGuideStory, "media_requests_only": true}); err != nil {
				t.Fatal(err)
			}
			if err := fake.db.Model(&model.DramaEpisode{}).Where("id = ?", episode.ID).Update("stage", model.DramaEpisodeRender).Error; err != nil {
				t.Fatal(err)
			}
			job := model.DramaJob{ID: newID(), ProjectID: projectID, EpisodeID: episode.ID, Kind: model.DramaJobRender, Status: model.DramaJobQueued, PayloadJSON: encodeDramaRevision(episode.Revision)}
			if err := svc.repo.CreateDramaJobs([]model.DramaJob{job}); err != nil {
				t.Fatal(err)
			}
			// The old segment videos remain ready. A late change to the selected shot source must still reject admission.
			row := rows[len(rows)-1]
			var err error
			switch issue {
			case "missing-slot":
				err = fake.db.Delete(&model.DramaShotMedia{}, "id = ?", row.ID).Error
			case "stale":
				err = fake.db.Model(&model.DramaShotMedia{}).Where("id = ?", row.ID).Update("status", model.DramaMediaStale).Error
			case "script-changed":
				err = fake.db.Model(&model.DramaShotMedia{}).Where("id = ?", row.ID).Update("script_hash", "old-script").Error
			case "missing-resource":
				err = fake.db.Delete(&model.Resource{}, "id = ?", row.ResourceID).Error
			}
			if err != nil {
				t.Fatal(err)
			}
			task := &model.Task{ID: newID(), UserID: "usr-drama", ProjectID: projectID, Type: model.TaskTypeTimelineRender, Status: model.TaskStatusQueued, InputJSON: "{}"}
			if _, err := svc.persistDramaTask(&job, task, nil); !errors.Is(err, repository.ErrDramaJobChanged) {
				t.Fatalf("invalid selected shots must not fall back to ready segment videos at binding: %v", err)
			}
			var count int64
			if err := fake.db.Model(&model.Task{}).Where("id = ?", task.ID).Count(&count).Error; err != nil || count != 0 {
				t.Fatalf("rejected binding must not persist an orphan task: count=%d err=%v", count, err)
			}
			var stored model.DramaJob
			if err := fake.db.First(&stored, "id = ?", job.ID).Error; err != nil || stored.Status != model.DramaJobQueued || stored.TaskID != "" {
				t.Fatalf("rejected binding must leave its job untouched: %+v %v", stored, err)
			}
		})
	}
}
