package database

import (
	"testing"
	"yingce/backend/internal/model"
)

func TestDramaExactVideoRequestsMigrationPreservesExistingAuthorization(t *testing.T) {
	db := schemaBranchFixture(t, "local", 101)
	if err := db.Migrator().DropColumn(&model.DramaEpisode{}, "video_requests_only"); err != nil {
		t.Fatal(err)
	}
	if err := db.Migrator().DropColumn(&model.DramaProduction{}, "media_requests_only"); err != nil {
		t.Fatal(err)
	}
	if err := db.Exec("INSERT INTO drama_productions (project_id, status, assets_released, revision) VALUES ('legacy-project','running',true,7)").Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Exec("INSERT INTO drama_episodes (id, project_id, number, stage, approved, media_released, revision) VALUES ('legacy-episode','legacy-project',1,'video',true,true,7)").Error; err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if err := MigrateSchema(db); err != nil {
			t.Fatal(err)
		}
	}
	var episode model.DramaEpisode
	if err := db.First(&episode, "id = ?", "legacy-episode").Error; err != nil {
		t.Fatal(err)
	}
	if episode.VideoRequestsOnly || !episode.MediaReleased || !episode.Approved || episode.Stage != model.DramaEpisodeVideo || episode.Revision != 7 {
		t.Fatalf("migration changed authorization: %+v", episode)
	}
	var p model.DramaProduction
	if err := db.First(&p, "project_id = ?", "legacy-project").Error; err != nil {
		t.Fatal(err)
	}
	if p.MediaRequestsOnly || !p.AssetsReleased || p.Status != model.DramaStatusRunning || p.Revision != 7 {
		t.Fatalf("migration changed production: %+v", p)
	}
}
