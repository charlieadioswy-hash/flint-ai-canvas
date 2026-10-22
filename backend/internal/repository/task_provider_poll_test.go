package repository

import (
	"errors"
	"testing"
	"time"

	"yingce/backend/internal/model"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func TestDeferredProviderPollKeepsOriginalTaskIdentityWithoutImmediateReclaim(t *testing.T) {
	db, err := gorm.Open(sqlite.Open("file:provider-poll-defer?mode=memory&cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.Task{}); err != nil {
		t.Fatal(err)
	}
	task := model.Task{
		ID: "task-1", UserID: "user-1", Type: "canvas_video", Status: model.TaskStatusRunning,
		LeaseOwner: "worker-1", LeaseExpiresAt: ptrTime(time.Now().Add(time.Minute)), ProviderRequestID: "provider-task-1",
	}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	repo := New(db)
	if err := repo.DeferRunningTaskForProviderPoll(task.ID, task.LeaseOwner, "后台仍在生成", time.Minute); err != nil {
		t.Fatal(err)
	}
	claimed, err := repo.ClaimNextTask("worker-2", 45*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if claimed != nil {
		t.Fatalf("task reclaimed before next poll: %#v", claimed)
	}
	if err := db.Model(&model.Task{}).Where("id = ?", task.ID).Update("next_poll_at", time.Now().Add(-time.Second)).Error; err != nil {
		t.Fatal(err)
	}
	claimed, err = repo.ClaimNextTask("worker-2", 45*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if claimed == nil || claimed.ID != task.ID || claimed.ProviderRequestID != task.ProviderRequestID {
		t.Fatalf("reclaimed task = %#v", claimed)
	}
}

func TestUpdateTaskProviderProgressIsMonotonic(t *testing.T) {
	db, err := gorm.Open(sqlite.Open("file:provider-progress?mode=memory&cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.Task{}); err != nil {
		t.Fatal(err)
	}
	task := model.Task{ID: "task-progress", UserID: "user-1", Type: "canvas_video", Status: model.TaskStatusRunning, Stage: "正在连接上游", Progress: 35, LeaseOwner: "worker", LeaseExpiresAt: ptrTime(time.Now().Add(time.Minute))}
	if err := db.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	repo := New(db)
	for _, progress := range []int{0, 12, 48, 31, 76} {
		if err := repo.UpdateTaskProviderProgress(task.ID, task.LeaseOwner, "上游生成中", &progress); err != nil {
			t.Fatal(err)
		}
		if progress == 0 {
			var zero model.Task
			if err := db.First(&zero, "id = ?", task.ID).Error; err != nil {
				t.Fatal(err)
			}
			if zero.ProviderProgress == nil || *zero.ProviderProgress != 0 {
				t.Fatal("genuine zero was lost")
			}
		}
	}
	var stored model.Task
	if err := db.First(&stored, "id = ?", task.ID).Error; err != nil {
		t.Fatal(err)
	}
	if stored.ProviderProgress == nil || *stored.ProviderProgress != 76 || stored.Progress != 35 || stored.Stage != "上游生成中" {
		t.Fatalf("stored task = %+v", stored)
	}
	if err := repo.UpdateTaskProviderProgress(task.ID, "stale-worker", "stale", nil); !errors.Is(err, ErrTaskStateConflict) {
		t.Fatalf("stale lease accepted: %v", err)
	}
	if err := repo.UpdateTaskProviderProgress(task.ID, task.LeaseOwner, "上游生成中", nil); err != nil {
		t.Fatal(err)
	}
	stored = model.Task{}
	if err := db.First(&stored, "id = ?", task.ID).Error; err != nil {
		t.Fatal(err)
	}
	if stored.ProviderProgress != nil {
		t.Fatal("missing observation retained old percentage")
	}
	if err := db.Model(&model.Task{}).Where("id = ?", task.ID).Update("lease_expires_at", time.Now().Add(-time.Second)).Error; err != nil {
		t.Fatal(err)
	}
	if err := repo.UpdateTaskProviderProgress(task.ID, task.LeaseOwner, "expired", nil); !errors.Is(err, ErrTaskStateConflict) {
		t.Fatalf("expired lease accepted: %v", err)
	}
	if err := db.Model(&model.Task{}).Where("id = ?", task.ID).Updates(map[string]any{"lease_expires_at": time.Now().Add(time.Minute), "media_stage": "saving"}).Error; err != nil {
		t.Fatal(err)
	}
	if err := repo.UpdateTaskProviderProgress(task.ID, task.LeaseOwner, "overwrite saving", nil); !errors.Is(err, ErrTaskStateConflict) {
		t.Fatalf("saving stage overwritten: %v", err)
	}
}

func ptrTime(value time.Time) *time.Time { return &value }
