package database

import (
	"encoding/json"
	"testing"

	"yingce/backend/internal/model"
)

func TestDramaEpisodeSettingsMigrationSnapshotsWithoutChangingExistingWork(t *testing.T) {
	db := schemaBranchFixture(t, "local", 116)
	const defaults = `{"styleName":"原默认","stylePrompt":"全剧风格","aspectRatio":"16:9","models":{"video":{"channelId":"v","modelKey":"kept"}},"storyboard":{"targetShotCount":8}}`
	if err := db.Create(&model.DramaProduction{ProjectID: "settings-project", SettingsJSON: defaults, Revision: 9}).Error; err != nil {
		t.Fatal(err)
	}
	for i, id := range []string{"initial", "independent"} {
		episode := model.DramaEpisode{ID: id, ProjectID: "settings-project", Number: i + 1, Revision: 7, Title: "已有集", Stage: model.DramaEpisodeDone, FinalResourceID: "kept-final"}
		if id == "independent" {
			episode.StyleMode, episode.StyleName, episode.StylePrompt = "independent", "本集水彩", "保留独立说明"
		}
		if err := db.Create(&episode).Error; err != nil {
			t.Fatal(err)
		}
	}
	for _, field := range []struct {
		row  any
		name string
	}{{&model.DramaProduction{}, "initial_settings_json"}, {&model.DramaEpisode{}, "settings_json"}, {&model.DramaCast{}, "image_episode_id"}} {
		if err := db.Migrator().DropColumn(field.row, field.name); err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 2; i++ {
		if err := MigrateSchema(db); err != nil {
			t.Fatal(err)
		}
	}
	var p model.DramaProduction
	if err := db.First(&p, "project_id = ?", "settings-project").Error; err != nil || p.InitialSettingsJSON != defaults || p.SettingsJSON != defaults || p.Revision != 9 {
		t.Fatalf("initial defaults were not captured without changing production: %+v %v", p, err)
	}
	var episodes []model.DramaEpisode
	if err := db.Order("number").Find(&episodes, "project_id = ?", p.ProjectID).Error; err != nil || len(episodes) != 2 {
		t.Fatalf("episodes: %+v %v", episodes, err)
	}
	for _, episode := range episodes {
		var settings struct {
			StyleName   string `json:"styleName"`
			StylePrompt string `json:"stylePrompt"`
			AspectRatio string `json:"aspectRatio"`
		}
		if err := json.Unmarshal([]byte(episode.SettingsJSON), &settings); err != nil {
			t.Fatal(err)
		}
		if settings.AspectRatio != "16:9" || episode.Revision != 7 || episode.FinalResourceID != "kept-final" || episode.Stage != model.DramaEpisodeDone || episode.FinalStale {
			t.Fatalf("migration changed existing production work: %+v %+v", episode, settings)
		}
		if episode.ID == "initial" && (settings.StyleName != "原默认" || settings.StylePrompt != "全剧风格") || episode.ID == "independent" && (settings.StyleName != "本集水彩" || settings.StylePrompt != "保留独立说明") {
			t.Fatalf("migration lost the current episode style: %+v", settings)
		}
	}
}
