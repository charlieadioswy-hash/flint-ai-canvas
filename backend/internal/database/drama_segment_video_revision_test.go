package database

import (
	"testing"

	"yingce/backend/internal/model"
)

func TestMigrateDramaSegmentVideoRevisionPreservesDrafts(t *testing.T) {
	db, err := Open(Config{Driver: "sqlite", DSN: "file:" + t.Name() + "?mode=memory&cache=shared"})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Exec("CREATE TABLE drama_segments (id text PRIMARY KEY, revision integer, video_prompt text, video_prompt_override text, prompt_status text, video_resource_id text)").Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Exec("INSERT INTO drama_segments VALUES ('segment', 7, '原段稿', '手写稿', 'ready', 'paid-video')").Error; err != nil {
		t.Fatal(err)
	}
	for _, migration := range schemaMigrations {
		if migration.version == 119 {
			for i := 0; i < 2; i++ {
				if err := migration.apply(db); err != nil {
					t.Fatal(err)
				}
			}
		}
	}
	var segment model.DramaSegment
	if err := db.First(&segment).Error; err != nil {
		t.Fatal(err)
	}
	if segment.Revision != 7 || segment.VideoRevision != 0 || segment.VideoPrompt != "原段稿" || segment.VideoPromptOverride != "手写稿" || segment.PromptStatus != "ready" || segment.VideoResourceID != "paid-video" {
		t.Fatalf("migration changed existing work: %+v", segment)
	}
}
