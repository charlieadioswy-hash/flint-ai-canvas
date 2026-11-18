package database

import (
	"testing"

	"yingce/backend/internal/model"
)

func TestDramaSegmentReferenceLabelsMigrationPreservesPrompts(t *testing.T) {
	db := schemaBranchFixture(t, "local", 121)
	segment := model.DramaSegment{ID: "existing-segment", EpisodeID: "existing-episode", VideoPrompt: "参考图1开门", VideoPromptOverride: "参考图1推开门"}
	if err := db.Create(&segment).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Migrator().DropColumn(&model.DramaSegment{}, "reference_labels_json"); err != nil {
		t.Fatal(err)
	}
	if err := MigrateSchema(db); err != nil {
		t.Fatal(err)
	}
	var got model.DramaSegment
	if err := db.First(&got, "id = ?", segment.ID).Error; err != nil || got.ReferenceLabelsJSON != "" || got.VideoPrompt != segment.VideoPrompt || got.VideoPromptOverride != segment.VideoPromptOverride {
		t.Fatalf("existing segment prompt changed on migration: %+v, %v", got, err)
	}
}
