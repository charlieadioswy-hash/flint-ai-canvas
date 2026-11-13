package database

import (
	"testing"

	"yingce/backend/internal/model"
)

func TestMigrateDramaCharacterLibrary(t *testing.T) {
	db, err := Open(Config{Driver: "sqlite", DSN: "file:" + t.Name() + "?mode=memory&cache=shared"})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, _ := db.DB()
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := db.Exec("CREATE TABLE drama_casts (id text PRIMARY KEY, description text)").Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Exec("INSERT INTO drama_casts (id, description) VALUES ('hero', '年龄：26岁\n原文完整保留')").Error; err != nil {
		t.Fatal(err)
	}
	found := false
	for _, migration := range schemaMigrations {
		if migration.version == 112 && migration.name == "drama_character_library" {
			found = true
			for i := 0; i < 2; i++ {
				if err := migration.apply(db); err != nil {
					t.Fatal(err)
				}
			}
		}
	}
	if !found {
		t.Fatal("character library migration is not registered")
	}
	var row model.DramaCast
	if err := db.First(&row, "id = 'hero'").Error; err != nil {
		t.Fatal(err)
	}
	if row.Description != "年龄：26岁\n原文完整保留" || row.DefinitionJSON != "" || row.LibraryAssetID != "" || row.LibraryVersionID != "" {
		t.Fatalf("legacy text changed: %+v", row)
	}
}
