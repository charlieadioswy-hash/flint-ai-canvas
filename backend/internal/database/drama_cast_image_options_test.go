package database

import (
	"testing"

	"yingce/backend/internal/model"
)

func TestDramaCastImageOptionsMigrationPreservesExistingMedia(t *testing.T) {
	db := schemaBranchFixture(t, "local", 103)
	if db.Migrator().HasColumn(&model.DramaCast{}, "ImageOptionsJSON") {
		if err := db.Migrator().DropColumn(&model.DramaCast{}, "ImageOptionsJSON"); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Exec(`INSERT INTO drama_casts (id,project_id,name,appearance,image_prompt,image_resource_id,image_status,revision) VALUES ('asset','project','原角色','原定义','原自定义提示词','kept-image','ready',7)`).Error; err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if err := MigrateSchema(db); err != nil {
			t.Fatal(err)
		}
	}
	var cast model.DramaCast
	if err := db.First(&cast, "id = ?", "asset").Error; err != nil {
		t.Fatal(err)
	}
	if cast.ImageOptionsJSON != "" || cast.ImageResourceID != "kept-image" || cast.Appearance != "原定义" || cast.ImagePrompt != "原自定义提示词" || cast.ImageStatus != "ready" || cast.Revision != 7 {
		t.Fatalf("migration changed existing asset: %+v", cast)
	}
}
