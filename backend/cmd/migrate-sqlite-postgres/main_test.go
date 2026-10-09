package main

import (
	"path/filepath"
	"sync"
	"testing"

	"yingce/backend/internal/database"
	"yingce/backend/internal/model"

	"gorm.io/gorm"
	"gorm.io/gorm/schema"
)

func TestMigrationListCopiesCompleteMergedSchema(t *testing.T) {
	open := func(name string) *gorm.DB {
		db, err := database.Open(database.Config{Driver: "sqlite", DSN: filepath.Join(t.TempDir(), name)})
		if err != nil {
			t.Fatal(err)
		}
		sqlDB, err := db.DB()
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = sqlDB.Close() })
		if err := database.MigrateSchema(db); err != nil {
			t.Fatal(err)
		}
		return db
	}
	source, target := open("source.db"), open("target.db")
	if err := source.Model(&model.SkillCurationSetting{}).Where("id = 1").Updates(map[string]any{"enabled": true, "revision": 7}).Error; err != nil {
		t.Fatal(err)
	}
	// An empty source must also replace target roots seeded by MigrateSchema.
	if err := source.Where("1 = 1").Delete(&model.SkillCurationRoot{}).Error; err != nil {
		t.Fatal(err)
	}
	for _, record := range []any{
		&model.SkillCurationCategory{ID: "category", RootTag: "custom", Name: "Custom", NormalizedName: "custom"},
		&model.SkillCurationAssignment{SkillID: "skill", CategoryID: "category"},
		&model.SkillCurationRootAssignment{SkillID: "skill", RootID: "custom"},
		&model.Model3DProvider{ID: "3d", Name: "3D provider"},
		&model.ImageModerationProvider{ID: "moderation", Name: "Moderation provider"},
	} {
		if err := source.Create(record).Error; err != nil {
			t.Fatal(err)
		}
	}
	tables, err := source.Migrator().GetTables()
	if err != nil {
		t.Fatal(err)
	}
	covered := map[string]bool{"schema_migrations": true, "sqlite_sequence": true}
	for _, migration := range migrations() {
		covered[migration.name] = true
		if _, err := migration.run(source, target, true); err != nil {
			t.Fatalf("copy %s: %v", migration.name, err)
		}
		if _, err := migration.run(source, target, false); err != nil {
			t.Fatalf("verify copied %s: %v", migration.name, err)
		}
	}
	for _, name := range tables {
		if !covered[name] {
			t.Errorf("migrated table %s missing from copy list", name)
		}
	}
}

func TestMigrationListCoversSchemaModels(t *testing.T) {
	want := make(map[string]bool, len(database.Models()))
	cache := &sync.Map{}
	for _, value := range database.Models() {
		parsed, err := schema.Parse(value, cache, schema.NamingStrategy{})
		if err != nil {
			t.Fatal(err)
		}
		want[parsed.Table] = false
	}
	for _, migration := range migrations() {
		if _, exists := want[migration.name]; !exists {
			t.Fatalf("migration list contains unknown table %q", migration.name)
		}
		if want[migration.name] {
			t.Fatalf("migration list contains duplicate table %q", migration.name)
		}
		want[migration.name] = true
	}
	for table, covered := range want {
		if !covered {
			t.Errorf("migration list is missing table %q", table)
		}
	}
}

func TestCanvasHistoryCompositeKeyMigration(t *testing.T) {
	source, err := database.Open(database.Config{Driver: "sqlite", DSN: "file:history-migration-source?mode=memory&cache=shared"})
	if err != nil {
		t.Fatal(err)
	}
	target, err := database.Open(database.Config{Driver: "sqlite", DSN: "file:history-migration-target?mode=memory&cache=shared"})
	if err != nil {
		t.Fatal(err)
	}
	for _, db := range []*gorm.DB{source, target} {
		if err := db.AutoMigrate(&model.Resource{}, &model.CanvasSnapshotResource{}); err != nil {
			t.Fatal(err)
		}
		if err := db.Create(&model.Resource{ID: "resource"}).Error; err != nil {
			t.Fatal(err)
		}
	}
	refs := []model.CanvasSnapshotResource{{SnapshotID: "b", ResourceID: "resource"}, {SnapshotID: "a", ResourceID: "resource"}}
	if err := source.Create(&refs).Error; err != nil {
		t.Fatal(err)
	}
	count, err := migrateTable[model.CanvasSnapshotResource]("canvas_snapshot_resources").run(source, target, true)
	if err != nil || count != 2 {
		t.Fatalf("history refs not copied/verified: %d %v", count, err)
	}
}
