package app

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"yingce/backend/internal/model"
	"yingce/backend/internal/protocol"
	"yingce/backend/internal/repository"
)

func TestProviderProgressStagesAndPublicOutput(t *testing.T) {
	db := newSQLiteTestDB(t)
	if err := db.AutoMigrate(&model.Task{}); err != nil {
		t.Fatal(err)
	}
	expires := time.Now().Add(time.Minute)
	task := model.Task{ID: "progress-task", Type: "canvas_image", Status: model.TaskStatusRunning, Progress: 35, LeaseOwner: "worker", LeaseExpiresAt: &expires}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	s := &Service{repo: repository.New(db)}
	ctx := withProviderAnalytics(context.Background(), s, task)
	zero, percent, completed := 0, 68, 100
	for _, tc := range []struct {
		status   protocol.Status
		progress *int
		stage    string
		want     *int
	}{
		{protocol.StatusPending, nil, "上游排队中", nil},
		{protocol.StatusPending, &zero, "上游排队中", &zero},
		{protocol.StatusProcessing, &percent, "上游生成中", &percent},
		{protocol.StatusProcessing, nil, "上游生成中", nil},
		{protocol.StatusProcessing, &completed, "上游生成中", nil},
		{protocol.StatusSucceeded, &completed, "作品已生成，正在保存", nil},
		{protocol.StatusFailed, &percent, "上游生成结束", nil},
	} {
		syncProviderTaskProgress(ctx, tc.status, tc.progress)
		stored, err := s.repo.Task(task.ID)
		if err != nil {
			t.Fatal(err)
		}
		if stored.Stage != tc.stage || stored.Progress != 35 {
			t.Fatalf("stage/legacy progress = %+v", stored)
		}
		body, err := json.Marshal(taskForOutput(*stored))
		if err != nil {
			t.Fatal(err)
		}
		var output map[string]any
		if err := json.Unmarshal(body, &output); err != nil {
			t.Fatal(err)
		}
		value, present := output["providerProgress"]
		if present != (tc.want != nil) || (present && value != float64(*tc.want)) {
			t.Fatalf("public progress %s, want %v", body, tc.want)
		}
	}
	for _, status := range []model.TaskStatus{model.TaskStatusQueued, model.TaskStatusSucceeded, model.TaskStatusFailed, model.TaskStatusCancelled} {
		task.Status, task.ProviderProgress = status, &percent
		if publicProviderProgress(task) != nil {
			t.Fatalf("terminal/queued progress leaked for %s", status)
		}
	}
	task.Status, task.MediaStage = model.TaskStatusRunning, "saving"
	if publicProviderProgress(task) != nil {
		t.Fatal("saving progress leaked")
	}
}

func TestTaskUsesUpstreamReportedProgress(t *testing.T) {
	for _, taskType := range []string{"canvas_image", "canvas_video", "video_shot", model.TaskTypeCanvasModel3D} {
		if !taskUsesUpstreamReportedProgress(taskType) {
			t.Fatalf("task type %q should use upstream progress", taskType)
		}
	}
	for _, taskType := range []string{"canvas_text", "canvas_audio", "text_generation"} {
		if taskUsesUpstreamReportedProgress(taskType) {
			t.Fatalf("task type %q should keep internal progress", taskType)
		}
	}
}
