package database

import (
	"testing"
	"yingce/backend/internal/model"
)

func TestProviderProgressMigrationFrom61PreservesUnknownHistoricalProgress(t *testing.T) {
	db := schemaBranchFixture(t, "local", 61)
	// Baseline migrations use the current model; recreate the released v61 shape.
	if err := db.Migrator().DropColumn(&model.Task{}, "provider_progress"); err != nil {
		t.Fatal(err)
	}
	if err := db.Exec(`INSERT INTO tasks (id,status,progress) VALUES ('old-task','running',35)`).Error; err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if err := MigrateSchema(db); err != nil {
			t.Fatal(err)
		}
	}
	var task model.Task
	if err := db.First(&task, "id = ?", "old-task").Error; err != nil {
		t.Fatal(err)
	}
	if task.Progress != 35 || task.ProviderProgress != nil {
		t.Fatalf("invented supplier percentage from legacy task: %+v", task)
	}
	status, err := ReadSchemaStatus(db)
	if err != nil || !status.Ready || status.Current != 62 {
		t.Fatalf("schema=%+v err=%v", status, err)
	}
	var record schemaMigration
	if err := db.First(&record, "version = ?", 62).Error; err != nil {
		t.Fatal(err)
	}
	if record.Name != "task_provider_progress" {
		t.Fatalf("migration=%+v", record)
	}
}
