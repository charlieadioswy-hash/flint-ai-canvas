package database

import (
	"reflect"
	"testing"

	"yingce/backend/internal/model"
)

func TestNovemberMergePreservesReleased102AndExactMediaScope(t *testing.T) {
	db := schemaBranchFixture(t, "local", 102)
	var released []schemaMigration
	if err := db.Order("version").Find(&released).Error; err != nil {
		t.Fatal(err)
	}
	if len(released) != 102 || released[101].Name != "drama_exact_media_requests" {
		t.Fatal("fixture must preserve the released exact media request migration")
	}
	production := model.DramaProduction{ProjectID: "kept", UserID: "owner", MediaRequestsOnly: true, GuideStep: model.DramaGuideCompleted, Revision: 7}
	episode := model.DramaEpisode{ID: "episode", ProjectID: production.ProjectID, VideoRequestsOnly: true, Revision: 3}
	if err := db.Create(&production).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&episode).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.First(&production, "project_id = ?", production.ProjectID).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.First(&episode, "id = ?", episode.ID).Error; err != nil {
		t.Fatal(err)
	}
	for _, entity := range []any{&model.ChannelWebsite{}, &model.SiteTrafficEvent{}} {
		if err := db.Migrator().DropTable(entity); err != nil {
			t.Fatal(err)
		}
	}
	for range 2 {
		if err := MigrateSchema(db); err != nil {
			t.Fatal(err)
		}
		if err := RequireSchemaVersion(db); err != nil {
			t.Fatal(err)
		}
		var after []schemaMigration
		if err := db.Where("version <= ?", 102).Order("version").Find(&after).Error; err != nil || !reflect.DeepEqual(released, after) {
			t.Fatalf("released migration records changed: %v", err)
		}
		var currentProduction model.DramaProduction
		var currentEpisode model.DramaEpisode
		if err := db.First(&currentProduction, "project_id = ?", production.ProjectID).Error; err != nil {
			t.Fatal(err)
		}
		if err := db.First(&currentEpisode, "id = ?", episode.ID).Error; err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(production, currentProduction) || !reflect.DeepEqual(episode, currentEpisode) {
			t.Fatal("upstream migrations changed exact media permissions or guide state")
		}
		for _, entity := range []any{&model.ChannelWebsite{}, &model.SiteTrafficEvent{}} {
			if !db.Migrator().HasTable(entity) {
				t.Fatalf("missing upstream structure %T", entity)
			}
		}
	}
}
