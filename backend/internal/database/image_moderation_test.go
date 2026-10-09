package database

import (
	"testing"

	"yingce/backend/internal/model"
)

func TestImageModerationMigrationCreatesDurableTablesIdempotently(t *testing.T) {
	db, err := Open(Config{Driver: "sqlite", DSN: ":memory:"})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, _ := db.DB()
	t.Cleanup(func() { _ = sqlDB.Close() })
	models := []any{&model.ImageModerationProvider{}, &model.ImageModerationConfig{}, &model.ImageModerationPolicy{}, &model.ImageModerationCheck{}, &model.ImageModerationItem{}, &model.ImageModerationDailyUsage{}}
	for attempt := 0; attempt < 2; attempt++ {
		if err := schemaMigrations[43].apply(db); err != nil {
			t.Fatal(err)
		}
	}
	for _, value := range models {
		if !db.Migrator().HasTable(value) {
			t.Fatalf("missing %T", value)
		}
	}
	provider := model.ImageModerationProvider{ID: "provider", Name: "Existing", Type: "aliyun", Enabled: true}
	if err := db.Create(&provider).Error; err != nil {
		t.Fatal(err)
	}
	if err := schemaMigrations[43].apply(db); err != nil {
		t.Fatal(err)
	}
	var preserved model.ImageModerationProvider
	if err := db.First(&preserved, "id = ?", provider.ID).Error; err != nil {
		t.Fatal(err)
	}
	if preserved.Name != provider.Name || !preserved.Enabled {
		t.Fatal("migration modified configuration")
	}
}
