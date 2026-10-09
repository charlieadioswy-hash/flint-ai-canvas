package database

import (
	"testing"

	"infinite-canvas/backend/internal/model"
)

func TestChannelModelProviderDefaultsMigrationPreservesExistingModel(t *testing.T) {
	db, err := Open(Config{Driver: "sqlite", DSN: ":memory:"})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Exec(`CREATE TABLE channel_models (id TEXT PRIMARY KEY, model_key TEXT, unit_price_microcredits INTEGER)`).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Exec(`INSERT INTO channel_models VALUES ('existing', 'image-model', 300000)`).Error; err != nil {
		t.Fatal(err)
	}
	for attempt := 0; attempt < 2; attempt++ {
		if err := migrateChannelModelProviderDefaults(db); err != nil {
			t.Fatal(err)
		}
	}
	if !db.Migrator().HasColumn(&model.ChannelModel{}, "ProviderDefaults") {
		t.Fatal("provider defaults column missing")
	}
	var row struct {
		ModelKey              string
		UnitPriceMicrocredits int64
		ProviderDefaults      *string
	}
	if err := db.Table("channel_models").Where("id = ?", "existing").First(&row).Error; err != nil {
		t.Fatal(err)
	}
	if row.ModelKey != "image-model" || row.UnitPriceMicrocredits != 300000 || row.ProviderDefaults != nil {
		t.Fatalf("migration changed existing model: %#v", row)
	}
}
