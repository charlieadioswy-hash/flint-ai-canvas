package database

import (
	"reflect"
	"testing"
	"time"

	"yingce/backend/internal/model"
)

func TestChannelWebsiteMigrationPreservesChannelsAndSeparatesEndpoints(t *testing.T) {
	db, err := Open(Config{Driver: "sqlite", DSN: "file:channel-websites-migration?mode=memory&cache=shared"})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := db.AutoMigrate(&model.ModelChannel{}); err != nil {
		t.Fatal(err)
	}
	stamp := time.Date(2020, 1, 2, 3, 4, 5, 0, time.UTC)
	rows := []model.ModelChannel{
		{ID: "a", Scope: model.ChannelScopeSystem, Name: "A", BaseURL: "https://EXAMPLE.com:443/v1", APIFormat: "openai", APIKey: "fixture-a", UpdatedAt: stamp},
		{ID: "b", Scope: model.ChannelScopeSystem, Name: "B", BaseURL: "https://example.com/v1", APIFormat: "openai", APIKey: "fixture-b", UpdatedAt: stamp},
		{ID: "path", Scope: model.ChannelScopeSystem, Name: "Path", BaseURL: "https://example.com/v1beta", APIFormat: "openai", UpdatedAt: stamp},
		{ID: "format", Scope: model.ChannelScopeSystem, Name: "Format", BaseURL: "https://example.com/v1", APIFormat: "gemini", UpdatedAt: stamp},
		{ID: "private", Scope: model.ChannelScopeSystem, Name: "Private", BaseURL: "https://example.com/v1", APIFormat: "openai", HeadersJSON: `[{"name":"X-Token","value":"fixture"}]`, UpdatedAt: stamp},
		{ID: "private2", Scope: model.ChannelScopeSystem, Name: "Private2", BaseURL: "https://example.com/v1", APIFormat: "openai", HeadersJSON: `[{"name":"X-Token","value":"fixture"}]`, UpdatedAt: stamp},
	}
	for i := range rows {
		if err := db.Create(&rows[i]).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Order("id").Find(&rows).Error; err != nil {
		t.Fatal(err)
	}
	if err := migrateChannelWebsites(db); err != nil {
		t.Fatal(err)
	}
	var after []model.ModelChannel
	if err := db.Order("id").Find(&after).Error; err != nil {
		t.Fatal(err)
	}
	byID := map[string]model.ModelChannel{}
	for _, row := range after {
		byID[row.ID] = row
	}
	if byID["a"].WebsiteID == "" || byID["a"].WebsiteID != byID["b"].WebsiteID {
		t.Fatal("equivalent endpoints not grouped")
	}
	for _, id := range []string{"path", "format", "private", "private2"} {
		if byID[id].WebsiteID == byID["a"].WebsiteID {
			t.Fatalf("unsafe grouping: %s", id)
		}
	}
	if byID["private"].WebsiteID == byID["private2"].WebsiteID {
		t.Fatal("unknown credential header grouped")
	}
	for _, before := range rows {
		current := byID[before.ID]
		current.WebsiteID = ""
		if !reflect.DeepEqual(before, current) {
			t.Fatalf("channel business data changed for %s", before.ID)
		}
	}
	var count int64
	db.Model(&model.ChannelWebsite{}).Count(&count)
	if err := migrateChannelWebsites(db); err != nil {
		t.Fatal(err)
	}
	var again int64
	db.Model(&model.ChannelWebsite{}).Count(&again)
	if count != again {
		t.Fatal("migration is not idempotent")
	}
}

func TestChannelWebsiteMigrationUpgradesPreviousVersion(t *testing.T) {
	db, err := Open(Config{Driver: "sqlite", DSN: "file:channel-websites-v105?mode=memory&cache=shared"})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := db.AutoMigrate(&schemaMigration{}, &model.ModelChannel{}); err != nil {
		t.Fatal(err)
	}
	if err := db.Migrator().DropColumn(&model.ModelChannel{}, "WebsiteID"); err != nil {
		t.Fatal(err)
	}
	// This upgrade fixture records the pre-v106 plan. Keep its existing drama
	// table slice on the old schema so later ALTER migrations run for real.
	for _, statement := range []string{
		"CREATE TABLE drama_casts (id text PRIMARY KEY, project_id text, kind text, name text, description text, appearance text, image_resource_id text)",
		"INSERT INTO drama_casts (id, project_id, kind, name, description, appearance, image_resource_id) VALUES ('legacy-cast', 'legacy-project', 'character', '旧人物', '原文人物说明', '白衬衫', 'legacy-image')",
	} {
		if err := db.Exec(statement).Error; err != nil {
			t.Fatal(err)
		}
	}
	for _, column := range []string{"image_options_json", "definition_json", "library_asset_id", "library_version_id"} {
		if db.Migrator().HasColumn("drama_casts", column) {
			t.Fatalf("pre-v106 fixture unexpectedly contains later column %s", column)
		}
	}
	stamp := time.Date(2024, 1, 2, 3, 4, 5, 0, time.UTC)
	row := model.ModelChannel{ID: "legacy-channel", Scope: model.ChannelScopeSystem, Name: "Legacy", BaseURL: "https://example.com/v1", APIFormat: "openai", APIKey: "synthetic-key", UpdatedAt: stamp}
	if err := db.Omit("WebsiteID").Create(&row).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.First(&row, "id = ?", row.ID).Error; err != nil {
		t.Fatal(err)
	}
	for _, migration := range schemaMigrations {
		if migration.version >= 106 {
			continue
		}
		if err := db.Create(&schemaMigration{Version: migration.version, Name: migration.name, Checksum: migration.checksum, AppliedAt: stamp}).Error; err != nil {
			t.Fatal(err)
		}
	}
	for run := 0; run < 2; run++ {
		if err := MigrateSchema(db); err != nil {
			t.Fatal(err)
		}
		if err := RequireSchemaVersion(db); err != nil {
			t.Fatal(err)
		}
	}
	var after model.ModelChannel
	if err := db.First(&after, "id = ?", row.ID).Error; err != nil {
		t.Fatal(err)
	}
	if after.WebsiteID == "" {
		t.Fatal("website migration did not assign a website")
	}
	after.WebsiteID = ""
	if !reflect.DeepEqual(row, after) {
		t.Fatal("website migration altered existing channel data")
	}
	var sites int64
	if err := db.Model(&model.ChannelWebsite{}).Count(&sites).Error; err != nil || sites != 1 {
		t.Fatalf("website count=%d err=%v", sites, err)
	}
	var cast model.DramaCast
	if err := db.First(&cast, "id = ?", "legacy-cast").Error; err != nil {
		t.Fatal(err)
	}
	if cast.ProjectID != "legacy-project" || cast.Kind != "character" || cast.Name != "旧人物" || cast.Description != "原文人物说明" || cast.Appearance != "白衬衫" || cast.ImageResourceID != "legacy-image" {
		t.Fatalf("later migrations altered existing drama data: %+v", cast)
	}
	for _, column := range []string{"image_options_json", "definition_json", "library_asset_id", "library_version_id"} {
		if !db.Migrator().HasColumn("drama_casts", column) {
			t.Fatalf("upgrade did not add later column %s", column)
		}
	}
}
