package database

import (
	"testing"

	"yingce/backend/internal/model"
)

func TestDramaEpisodeStyleMigrationPreservesExistingWork(t *testing.T) {
	db := schemaBranchFixture(t, "local", 115)
	for _, column := range []string{"style_mode", "style_name", "style_prompt"} {
		if err := db.Migrator().DropColumn(&model.DramaEpisode{}, column); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Exec("INSERT INTO drama_episodes (id, project_id, number, title, stage, final_resource_id, final_stale, revision) VALUES ('style-legacy-episode','style-legacy-project',1,'已有集','done','kept-final',false,7)").Error; err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if err := MigrateSchema(db); err != nil {
			t.Fatal(err)
		}
	}
	var episode model.DramaEpisode
	if err := db.First(&episode, "id = ?", "style-legacy-episode").Error; err != nil {
		t.Fatal(err)
	}
	if episode.StyleMode != "" || episode.StyleName != "" || episode.StylePrompt != "" || episode.Title != "已有集" || episode.Stage != model.DramaEpisodeDone || episode.FinalResourceID != "kept-final" || episode.FinalStale || episode.Revision != 7 {
		t.Fatalf("style migration changed existing work: %+v", episode)
	}
}
