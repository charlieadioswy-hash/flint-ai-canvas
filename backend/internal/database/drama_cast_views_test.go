package database

import (
	"testing"

	"yingce/backend/internal/model"
)

func TestMigrateDramaCastViewsPreservesIndependentSlots(t *testing.T) {
	db, err := Open(Config{Driver: "sqlite", DSN: "file:" + t.Name() + "?mode=memory&cache=shared"})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, _ := db.DB()
	t.Cleanup(func() { _ = sqlDB.Close() })
	found := false
	for _, migration := range schemaMigrations {
		if migration.version != 113 || migration.name != "drama_cast_views" {
			continue
		}
		found = true
		if err := migration.apply(db); err != nil {
			t.Fatal(err)
		}
		row := model.DramaCastView{ID: "front", ProjectID: "project", CastID: "hero", Revision: 4, ConfigJSON: `{"name":"正面","direction":"front"}`, ResourceID: "paid-image", CurrentTakeID: "paid-take", Status: "ready"}
		if err := db.Create(&row).Error; err != nil {
			t.Fatal(err)
		}
		if err := migration.apply(db); err != nil {
			t.Fatal(err)
		}
		var current model.DramaCastView
		if err := db.First(&current, "id = ?", row.ID).Error; err != nil {
			t.Fatal(err)
		}
		if current.Revision != 4 || current.ResourceID != row.ResourceID || current.CurrentTakeID != row.CurrentTakeID || current.ConfigJSON != row.ConfigJSON {
			t.Fatalf("migration changed paid view: %+v", current)
		}
	}
	if !found {
		t.Fatal("cast view migration is not registered as 113")
	}
}
