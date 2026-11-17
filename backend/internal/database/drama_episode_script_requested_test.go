package database

import (
	"testing"

	"yingce/backend/internal/model"
)

func TestMigrateDramaEpisodeScriptRequestedPreservesQueuedEpisodes(t *testing.T) {
	db, err := Open(Config{Driver: "sqlite", DSN: "file:" + t.Name() + "?mode=memory&cache=shared"})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Exec("CREATE TABLE drama_episodes (id text PRIMARY KEY, stage text, revision integer)").Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Exec("INSERT INTO drama_episodes VALUES ('legacy', 'queued', 7)").Error; err != nil {
		t.Fatal(err)
	}
	for _, migration := range schemaMigrations {
		if migration.version == 120 {
			for range 2 {
				if err := migration.apply(db); err != nil {
					t.Fatal(err)
				}
			}
		}
	}
	var episode model.DramaEpisode
	if err := db.Select("stage", "revision", "script_requested").First(&episode, "id = ?", "legacy").Error; err != nil {
		t.Fatal(err)
	}
	if episode.Stage != model.DramaEpisodeQueued || episode.Revision != 7 || episode.ScriptRequested {
		t.Fatalf("upgrade must keep the old queue state and not infer explicit intent: %+v", episode)
	}
}
