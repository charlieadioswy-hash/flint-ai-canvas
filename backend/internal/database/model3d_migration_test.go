package database

import (
	"testing"

	"infinite-canvas/backend/internal/model"
)

func TestModel3DMigration45UpgradesAndPreservesExistingTasks(t *testing.T) {
	db, err := Open(Config{Driver: "sqlite", DSN: "file:model3d-migration-45?mode=memory&cache=shared"})
	if err != nil {
		t.Fatal(err)
	}
	if err := MigrateSchema(db); err != nil {
		t.Fatal(err)
	}
	for _, table := range []any{&model.Model3DProvider{}, &model.Model3DConfig{}, &model.Model3DPolicy{}, &model.Model3DSubmission{}, &model.Model3DDailyUsage{}} {
		if !db.Migrator().HasTable(table) {
			t.Fatalf("missing table %T", table)
		}
		if err := db.Migrator().DropTable(table); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Where("version = ?", 45).Delete(&schemaMigration{}).Error; err != nil {
		t.Fatal(err)
	}
	task := &model.Task{ID: "existing-task", UserID: "existing-user", Type: "canvas_image", Status: model.TaskStatusSucceeded, ResultJSON: `{"url":"/api/resources/existing/file"}`}
	if err := db.Create(task).Error; err != nil {
		t.Fatal(err)
	}
	if err := MigrateSchema(db); err != nil {
		t.Fatal(err)
	}
	var preserved model.Task
	if err := db.First(&preserved, "id = ?", task.ID).Error; err != nil || preserved.ResultJSON != task.ResultJSON {
		t.Fatalf("existing task modified: %v %+v", err, preserved)
	}
	if !db.Migrator().HasIndex(&model.Model3DSubmission{}, "idx_model3d_request") {
		t.Fatal("durable request identity not unique")
	}
	status, err := ReadSchemaStatus(db)
	if err != nil || !status.Ready || status.Current != CurrentSchemaVersion {
		t.Fatalf("migration status: %v %+v", err, status)
	}
}
