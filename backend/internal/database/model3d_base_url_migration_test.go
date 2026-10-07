package database

import (
	"path/filepath"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func TestModel3DBaseURLMigration49BackfillsAndPreservesSnapshots(t *testing.T) {
	db, err := Open(Config{Driver: "sqlite", DSN: filepath.Join(t.TempDir(), "migration.db")})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := MigrateSchema(db); err != nil {
		t.Fatal(err)
	}
	configs := []model.Model3DConfig{
		{ID: "config-v1", ProviderID: "provider", Version: 1, Type: "tripo3d", DefaultModel: "v3.1-20260211", APIKeyEncrypted: "fixture-ciphertext-v1"},
		{ID: "config-v2", ProviderID: "provider", Version: 2, Type: "tripo3d", DefaultModel: "v3.0-20250812", APIKeyEncrypted: "fixture-ciphertext-v2"},
	}
	if err := db.Create(&configs).Error; err != nil {
		t.Fatal(err)
	}
	task := model.Task{ID: "preserved-task", UserID: "owner", Type: model.TaskTypeCanvasModel3D, Status: model.TaskStatusQueued, InputJSON: `{"configId":"config-v1"}`}
	submission := model.Model3DSubmission{TaskID: task.ID, UserID: task.UserID, RequestID: "request", ConfigID: "config-v1", State: "prepared", TokensEncrypted: "fixture-token-ciphertext"}
	policy := model.Model3DPolicy{ID: "policy", ActiveProviderID: "provider", ActiveConfigID: "config-v2", Revision: 4}
	for _, value := range []any{&task, &submission, &policy} {
		if err := db.Create(value).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Migrator().DropColumn(&model.Model3DConfig{}, "BaseURL"); err != nil {
		t.Fatal(err)
	}
	if err := db.Where("version = ?", 49).Delete(&schemaMigration{}).Error; err != nil {
		t.Fatal(err)
	}
	var history []schemaMigration
	if err := db.Order("version").Find(&history).Error; err != nil {
		t.Fatal(err)
	}
	for attempt := 0; attempt < 2; attempt++ {
		if err := MigrateSchema(db); err != nil {
			t.Fatal(err)
		}
		status, err := ReadSchemaStatus(db)
		if err != nil || !status.Ready || status.Current != CurrentSchemaVersion {
			t.Fatalf("migration status: %+v %v", status, err)
		}
	}
	for _, expected := range configs {
		var actual model.Model3DConfig
		if err := db.First(&actual, "id = ?", expected.ID).Error; err != nil || actual.BaseURL != "https://openapi.tripo3d.ai/v3" || actual.Version != expected.Version || actual.APIKeyEncrypted != expected.APIKeyEncrypted || actual.DefaultModel != expected.DefaultModel || !actual.CreatedAt.Equal(expected.CreatedAt) {
			t.Fatalf("config snapshot changed or was not backfilled: %+v %v", actual, err)
		}
	}
	var keptTask model.Task
	var keptSubmission model.Model3DSubmission
	var keptPolicy model.Model3DPolicy
	if err := db.First(&keptTask, "id = ?", task.ID).Error; err != nil || keptTask.InputJSON != task.InputJSON || keptTask.Status != task.Status {
		t.Fatalf("task changed: %+v %v", keptTask, err)
	}
	if err := db.First(&keptSubmission, "task_id = ?", task.ID).Error; err != nil || keptSubmission.ConfigID != submission.ConfigID || keptSubmission.TokensEncrypted != submission.TokensEncrypted || keptSubmission.State != submission.State {
		t.Fatalf("submission changed: %+v %v", keptSubmission, err)
	}
	if err := db.First(&keptPolicy, "id = ?", policy.ID).Error; err != nil || keptPolicy.ActiveConfigID != policy.ActiveConfigID || keptPolicy.Revision != policy.Revision {
		t.Fatalf("active policy changed: %+v %v", keptPolicy, err)
	}
	for _, previous := range history {
		var actual schemaMigration
		if err := db.First(&actual, "version = ?", previous.Version).Error; err != nil || actual.Name != previous.Name || actual.Checksum != previous.Checksum || !actual.AppliedAt.Equal(previous.AppliedAt) {
			t.Fatalf("historical migration changed: %+v %v", actual, err)
		}
	}
	if err := db.Model(&model.Model3DConfig{}).Where("id = ?", "config-v2").UpdateColumn("base_url", "https://openapi.tripo3d.com/v3").Error; err != nil {
		t.Fatal(err)
	}
	if err := migrateModel3DBaseURL(db); err != nil {
		t.Fatal(err)
	}
	var explicit model.Model3DConfig
	if err := db.First(&explicit, "id = ?", "config-v2").Error; err != nil || explicit.BaseURL != "https://openapi.tripo3d.com/v3" {
		t.Fatalf("idempotent backfill overwrote explicit endpoint: %+v %v", explicit, err)
	}
}
