package database

import (
	"testing"

	"yingce/backend/internal/model"
)

func TestDramaEpisodeAssetsMigrationPreservesExistingWork(t *testing.T) {
	db := schemaBranchFixture(t, "local", 117)
	if err := db.Create(&model.DramaEpisode{ID: "assets-episode", ProjectID: "assets-project", Number: 1, Title: "已有集", Stage: model.DramaEpisodeDone, Revision: 7, FinalResourceID: "kept-final", SettingsJSON: `{"styleName":"保留风格"}`}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Migrator().DropColumn(&model.DramaEpisode{}, "asset_ids_json"); err != nil {
		t.Fatal(err)
	}
	if err := MigrateSchema(db); err != nil {
		t.Fatal(err)
	}
	var episode model.DramaEpisode
	if err := db.First(&episode, "id = ?", "assets-episode").Error; err != nil {
		t.Fatal(err)
	}
	if episode.AssetIDsJSON != "" || episode.Title != "已有集" || episode.Stage != model.DramaEpisodeDone || episode.Revision != 7 || episode.FinalResourceID != "kept-final" || episode.SettingsJSON != `{"styleName":"保留风格"}` {
		t.Fatalf("adding membership must not change existing production work: %+v", episode)
	}
	if err := db.Model(&episode).UpdateColumn("asset_ids_json", `["kept-asset"]`).Error; err != nil {
		t.Fatal(err)
	}
	if err := MigrateSchema(db); err != nil {
		t.Fatal(err)
	}
	if err := db.First(&episode, "id = ?", episode.ID).Error; err != nil || episode.AssetIDsJSON != `["kept-asset"]` {
		t.Fatalf("repeated migration must retain membership: %+v %v", episode, err)
	}
	if err := RequireSchemaVersion(db); err != nil {
		t.Fatal(err)
	}
}
