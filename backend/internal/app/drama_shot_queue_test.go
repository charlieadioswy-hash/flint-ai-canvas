package app

import (
	"testing"
	"time"

	"yingce/backend/internal/model"
)

func TestDramaQueueIncludesDirectShotMediaTask(t *testing.T) {
	s, db, _ := shotMediaFixture(t)
	const user, project, shot = "user", "drama-project", "real-shot"
	task, err := s.ExecuteDramaShotMedia(user, project, shot, "video", shotMediaConfirmed(t, s, "queue-video"))
	if err != nil {
		t.Fatal(err)
	}
	old := task.CreatedAt.Add(-time.Hour)
	for _, row := range []any{
		&model.Task{ID: "unbound-task", UserID: user, ProjectID: project, Type: "canvas_video", Status: model.TaskStatusRunning},
		&model.Task{ID: "foreign-task", UserID: "other", ProjectID: project, Type: "canvas_video", Status: model.TaskStatusRunning},
		&model.DramaTake{ID: "foreign-take", ProjectID: project, OwnerID: shot, Kind: "shot_video", TaskID: "foreign-task"},
		&model.DramaJob{ID: "scheduled-job", ProjectID: project, Kind: model.DramaJobScript, Status: model.DramaJobSucceeded, CreatedAt: old, UpdatedAt: old},
	} {
		if err := db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	id := dramaShotQueueJobPrefix + task.ID
	queue := func(status string) DramaJobView {
		t.Helper()
		jobs, err := s.DramaJobs(user, project, 1)
		if err != nil || len(jobs) != 1 || jobs[0].ID != id || jobs[0].Kind != "shot_video" || jobs[0].EpisodeID != "episode" || jobs[0].ShotID != shot || jobs[0].Status != status {
			t.Fatalf("expected latest visible shot task (%s), got %+v, %v", status, jobs, err)
		}
		summary, err := s.DramaSummary(user, project)
		if err != nil || summary.JobCounts[status] != 1 || summary.JobCounts[model.DramaJobSucceeded] != 1 {
			t.Fatalf("expected one shot task and one scheduled job: %+v, %v", summary.JobCounts, err)
		}
		return jobs[0]
	}
	if job := queue(model.DramaJobQueued); job.Wait != task.Stage {
		t.Fatalf("expected direct task wait reason %q, got %q", task.Stage, job.Wait)
	}
	if err := db.Model(&model.Task{}).Where("id = ?", task.ID).Updates(map[string]any{
		"status": model.TaskStatusRunning, "stage": "上游生成中", "provider_request_id": "provider-job",
	}).Error; err != nil {
		t.Fatal(err)
	}
	if job := queue(model.DramaJobRunning); job.ProviderStage != "上游生成中" {
		t.Fatalf("expected provider stage in the active job: %+v", job)
	}
	detail, err := s.DramaJobDetail(user, project, id)
	if err != nil || detail.Job.Status != model.DramaJobRunning || len(detail.Attempts) != 1 || detail.Attempts[0].Task == nil || detail.Attempts[0].Task.ID != task.ID {
		t.Fatalf("expected detail for the bound task: %+v, %v", detail, err)
	}
	for _, denied := range []struct{ user, id string }{
		{"other", id}, {user, dramaShotQueueJobPrefix + "foreign-task"}, {user, dramaShotQueueJobPrefix + "unbound-task"},
	} {
		if _, err := s.DramaJobDetail(denied.user, project, denied.id); err == nil {
			t.Fatalf("exposed unrelated task details: %+v", denied)
		}
	}
	if err := db.Model(&model.Task{}).Where("id = ?", task.ID).Updates(map[string]any{
		"status": model.TaskStatusFailed, "error": "视频生成失败",
	}).Error; err != nil {
		t.Fatal(err)
	}
	// Editing this slot clears its latest task link, but must retain queue history.
	if err := db.Model(&model.DramaShotMedia{}).Where("project_id = ? AND shot_id = ? AND kind = ?", project, shot, "video").
		Updates(map[string]any{"task_id": "", "pending_take_id": ""}).Error; err != nil {
		t.Fatal(err)
	}
	if job := queue(model.DramaJobFailed); job.Error != "视频生成失败" {
		t.Fatalf("expected the failure reason in the queue: %+v", job)
	}
	if err := db.Model(&model.DramaJob{}).Where("id = ?", "scheduled-job").Update("task_id", task.ID).Error; err != nil {
		t.Fatal(err)
	}
	jobs, err := s.DramaJobs(user, project, 10)
	if err != nil || len(jobs) != 1 || jobs[0].ID != "scheduled-job" {
		t.Fatalf("task already covered by a scheduled job was listed twice: %+v, %v", jobs, err)
	}
	summary, err := s.DramaSummary(user, project)
	if err != nil || summary.JobCounts[model.DramaJobFailed] != 0 || summary.JobCounts[model.DramaJobSucceeded] != 1 {
		t.Fatalf("task already covered by a scheduled job was counted twice: %+v, %v", summary.JobCounts, err)
	}
}

func TestDramaQueueRetainsTaskAfterShotRemoved(t *testing.T) {
	s, db, _ := shotMediaFixture(t)
	const user, project, shot = "user", "drama-project", "real-shot"
	for _, row := range []any{
		&model.DramaShot{ID: "remaining", ProjectID: project, EpisodeID: "episode", Position: 2, DurationMs: 5000},
		&model.DramaSegment{ID: "segment", ProjectID: project, EpisodeID: "episode"},
	} {
		if err := db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	task, err := s.ExecuteDramaShotMedia(user, project, shot, "video", shotMediaConfirmed(t, s, "removed-shot-video"))
	if err != nil {
		t.Fatal(err)
	}
	if err := s.DeleteDramaShot(user, project, shot); err != nil {
		t.Fatal(err)
	}
	id := dramaShotQueueJobPrefix + task.ID
	for _, status := range []string{model.DramaJobQueued, model.DramaJobSucceeded} {
		matchesRemovedShot := func(job DramaJobView) bool {
			return job.ID == id && job.Status == status && job.EpisodeID == "" && job.ShotID == "" && job.Label == "原分镜已移除"
		}
		if status == model.DramaJobSucceeded {
			completeShotMedia(t, s, db, task.ID, "orphan-shot-result")
		}
		jobs, err := s.DramaJobs(user, project, 10)
		if err != nil || len(jobs) != 1 || !matchesRemovedShot(jobs[0]) {
			t.Fatalf("expected retained queue job without a location (%s): %+v, %v", status, jobs, err)
		}
		summary, err := s.DramaSummary(user, project)
		if err != nil || summary.JobCounts[status] != 1 {
			t.Fatalf("expected retained job in counts (%s): %+v, %v", status, summary.JobCounts, err)
		}
		detail, err := s.DramaJobDetail(user, project, id)
		if err != nil || !matchesRemovedShot(detail.Job) || len(detail.Attempts) != 1 || detail.Attempts[0].Task == nil {
			t.Fatalf("expected accessible job detail with no location (%s): %+v, %v", status, detail, err)
		}
		if status == model.DramaJobSucceeded {
			resources := detail.Attempts[0].Task.ResourceIDs
			if len(resources) != 1 || resources[0] != "orphan-shot-result" {
				t.Fatalf("expected retained output after removal: %+v", resources)
			}
		}
	}
}

func TestDramaQueueAppliesStatusAndKindBeforeLimit(t *testing.T) {
	s, db, _ := shotMediaFixture(t)
	const user, project, shot = "user", "drama-project", "real-shot"
	now := time.Now()
	for _, job := range []model.DramaJob{
		{ID: "latest-text", Kind: model.DramaJobScript, Status: model.DramaJobSucceeded, UpdatedAt: now},
		{ID: "asset-extraction", Kind: model.DramaJobBible, Status: model.DramaJobRunning, UpdatedAt: now.Add(-5 * time.Minute)},
		{ID: "legacy-failed", Kind: model.DramaJobScript, Status: model.DramaJobFailed, UpdatedAt: now.Add(-4 * time.Minute)},
	} {
		job.ProjectID = project
		if err := db.Create(&job).Error; err != nil {
			t.Fatal(err)
		}
	}
	for _, task := range []model.Task{
		{ID: "latest-shot", Status: model.TaskStatusSucceeded, UpdatedAt: now.Add(time.Second)},
		{ID: "queued-shot", Status: model.TaskStatusQueued, UpdatedAt: now.Add(-time.Minute)},
		{ID: "retrying-shot", Status: model.TaskStatusQueued, Error: "provider unavailable", UpdatedAt: now.Add(-2 * time.Minute)},
		{ID: "failed-shot", Status: model.TaskStatusFailed, UpdatedAt: now.Add(-3 * time.Minute)},
	} {
		task.UserID, task.ProjectID, task.Type = user, project, "canvas_video"
		if err := db.Create(&task).Error; err != nil {
			t.Fatal(err)
		}
		if err := db.Create(&model.DramaTake{ID: "take-" + task.ID, ProjectID: project, OwnerID: shot, Kind: "shot_video", TaskID: task.ID}).Error; err != nil {
			t.Fatal(err)
		}
	}
	for _, test := range []struct{ status, kinds, want string }{
		{want: dramaShotQueueJobPrefix + "latest-shot"},
		{status: "active", want: dramaShotQueueJobPrefix + "queued-shot"},
		{status: "failed", want: dramaShotQueueJobPrefix + "retrying-shot"},
		{status: "failed", kinds: "script", want: "legacy-failed"},
		{status: "active", kinds: "bible,plan,script,segment_prompt", want: "asset-extraction"},
		{kinds: "bible", want: "asset-extraction"},
	} {
		jobs, err := s.DramaJobsFiltered(user, project, 1, test.status, test.kinds)
		if err != nil || len(jobs) != 1 || jobs[0].ID != test.want {
			t.Fatalf("status %q, kinds %q should select %q before limiting results: %+v, %v", test.status, test.kinds, test.want, jobs, err)
		}
	}
}
