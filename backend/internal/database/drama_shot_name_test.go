package database

import (
	"testing"

	"yingce/backend/internal/model"
)

func TestDramaShotNameMigrationPreservesExistingShot(t *testing.T) {
	db := schemaBranchFixture(t, "local", 120)
	shot := model.DramaShot{ID: "existing-shot", ProjectID: "existing-project", EpisodeID: "existing-episode", Position: 2, Camera: "固定机位", VideoPrompt: "保留原运镜"}
	if err := db.Create(&shot).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Migrator().DropColumn(&model.DramaShot{}, "name"); err != nil {
		t.Fatal(err)
	}
	if err := MigrateSchema(db); err != nil {
		t.Fatal(err)
	}
	var got model.DramaShot
	if err := db.First(&got, "id = ?", shot.ID).Error; err != nil || got.Name != "" || got.Position != shot.Position || got.VideoPrompt != shot.VideoPrompt || got.Camera != shot.Camera {
		t.Fatalf("existing shot changed on migration: %+v, %v", got, err)
	}
	if err := RequireSchemaVersion(db); err != nil {
		t.Fatal(err)
	}
}
