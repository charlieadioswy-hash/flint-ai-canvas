package app

import (
	"slices"
	"testing"

	"gorm.io/gorm"
	"yingce/backend/internal/model"
)

func newShotMediaDefaultsFixture(t *testing.T, mode string) (*Service, *gorm.DB) {
	t.Helper()
	s, db, _ := shotMediaFixture(t)
	if err := db.Where("project_id = ? AND shot_id = ? AND kind = ?", "drama-project", "real-shot", "video").Delete(&model.DramaShotMedia{}).Error; err != nil {
		t.Fatal(err)
	}
	p, err := s.repo.DramaProduction("drama-project")
	if err != nil {
		t.Fatal(err)
	}
	settings := parseDramaSettings(p.SettingsJSON)
	settings.Storyboard.GenerationMode = mode
	if err := db.Model(p).Update("settings_json", encodeDramaSettings(settings)).Error; err != nil {
		t.Fatal(err)
	}
	return s, db
}

func TestDramaShotMediaDefaultsUseSelectedLookAndOwnedReadyReferences(t *testing.T) {
	for _, mode := range []string{"reference_video", "smart_director"} {
		t.Run(mode, func(t *testing.T) {
			s, db := newShotMediaDefaultsFixture(t, mode)
			for _, row := range []any{
				&model.Resource{ID: "prop-image", UserID: "user", Kind: "image", Status: model.ResourceStatusReady, MimeType: "image/png"},
				&model.Resource{ID: "scene-image", UserID: "user", Kind: "image", Status: model.ResourceStatusReady, MimeType: "image/png"},
				&model.Resource{ID: "not-an-image", UserID: "user", Kind: "video", Status: model.ResourceStatusReady, MimeType: "video/mp4"},
				&model.Resource{ID: "unready", UserID: "user", Kind: "image", Status: "pending", MimeType: "image/png"},
				&model.DramaCast{ID: "hero", ProjectID: "drama-project", Kind: "character", ImageStatus: model.DramaMediaReady, ImageResourceID: "ref-one"},
				&model.DramaCast{ID: "chosen-look", ProjectID: "drama-project", Kind: "character", ParentID: "hero", ImageStatus: model.DramaMediaReady, ImageResourceID: "ref-two"},
				&model.DramaCast{ID: "foreign", ProjectID: "drama-project", Kind: "character", ImageStatus: model.DramaMediaReady, ImageResourceID: "private"},
				&model.DramaCast{ID: "wrong-kind", ProjectID: "drama-project", Kind: "character", ImageStatus: model.DramaMediaReady, ImageResourceID: "not-an-image"},
				&model.DramaCast{ID: "pending", ProjectID: "drama-project", Kind: "character", ImageStatus: model.DramaMediaReady, ImageResourceID: "unready"},
				&model.DramaCast{ID: "deleted", ProjectID: "drama-project", Kind: "character", ImageStatus: model.DramaMediaReady, ImageResourceID: "missing"},
				&model.DramaCast{ID: "duplicate-prop", ProjectID: "drama-project", Kind: "prop", ImageStatus: model.DramaMediaReady, ImageResourceID: "ref-two"},
				&model.DramaCast{ID: "prop", ProjectID: "drama-project", Kind: "prop", ImageStatus: model.DramaMediaReady, ImageResourceID: "prop-image"},
				&model.DramaCast{ID: "scene", ProjectID: "drama-project", Kind: "scene", ImageStatus: model.DramaMediaReady, ImageResourceID: "scene-image"},
			} {
				if err := db.Create(row).Error; err != nil {
					t.Fatal(err)
				}
			}
			if err := db.Model(&model.DramaShot{}).Where("id = ?", "real-shot").Updates(map[string]any{"cast_ids_json": encodeStringList([]string{"hero", "foreign", "wrong-kind", "pending", "deleted"}), "look_cast_ids_json": `["chosen-look"]`, "prop_ids_json": `["duplicate-prop","prop"]`, "scene_cast_id": "scene"}).Error; err != nil {
				t.Fatal(err)
			}
			view, err := s.DramaShotMedia("user", "drama-project", "real-shot", "video")
			if err != nil || view.ID != "" || view.Config.Operation != "reference_to_video" || !slices.Equal(view.Config.ReferenceResourceIDs, []string{"ref-two", "prop-image", "scene-image"}) || view.Config.FirstFrameResourceID != "" {
				t.Fatalf("mode defaults = %+v, %v", view, err)
			}
			if _, err := s.normalizeDramaShotMediaConfig(s.repo, "user", "drama-project", "video", view.Config); err != nil {
				t.Fatalf("default references must be saveable: %v", err)
			}
			p, _ := s.repo.DramaProduction("drama-project")
			settings := parseDramaSettings(p.SettingsJSON)
			settings.ReferenceLimit = 2
			if err := db.Model(p).Update("settings_json", encodeDramaSettings(settings)).Error; err != nil {
				t.Fatal(err)
			}
			view, err = s.DramaShotMedia("user", "drama-project", "real-shot", "video")
			if err != nil || !slices.Equal(view.Config.ReferenceResourceIDs, []string{"ref-two", "prop-image"}) {
				t.Fatalf("project limit = %+v, %v", view.Config, err)
			}
			capability := DefaultModelCapabilityConfigForModel(string(model.ChannelInterfaceVolcengineArkVideo), "seedance-test")
			capability.Video.References.MaxImages = 1
			if err := db.Model(&model.ChannelModel{}).Where("id = ?", "video-cm").Update("capability_config_json", mustEncodeModelCapabilityConfig(t, capability)).Error; err != nil {
				t.Fatal(err)
			}
			view, err = s.DramaShotMedia("user", "drama-project", "real-shot", "video")
			if err != nil || !slices.Equal(view.Config.ReferenceResourceIDs, []string{"ref-two"}) {
				t.Fatalf("model limit = %+v, %v", view.Config, err)
			}
		})
	}
}

func TestDramaShotMediaDefaultsUseCurrentShotImageForStoryboardModes(t *testing.T) {
	for _, mode := range []string{"grid_image", "storyboard"} {
		for _, state := range []string{"adopted", "foreign", "stale-script", "stale-config", "missing", "unconfigured"} {
			t.Run(mode+"/"+state, func(t *testing.T) {
				s, db := newShotMediaDefaultsFixture(t, mode)
				shot, _ := s.repo.DramaShot("drama-project", "real-shot")
				image := model.DramaShotMedia{ID: "image-slot", ProjectID: shot.ProjectID, EpisodeID: shot.EpisodeID, ShotID: shot.ID, Kind: "image", ResourceID: "ref-one", CurrentTakeID: "adopted-take", Status: "ready", ScriptHash: dramaShotScriptHash(*shot)}
				switch state {
				case "foreign":
					image.ResourceID = "private"
				case "missing":
					image.ResourceID = "deleted-resource"
				case "stale-script":
					image.ScriptHash = "old-script"
				case "stale-config":
					image.Status = "stale"
				}
				if state != "unconfigured" {
					if err := db.Create(&image).Error; err != nil {
						t.Fatal(err)
					}
				}
				view, err := s.DramaShotMedia("user", shot.ProjectID, shot.ID, "video")
				if err != nil {
					t.Fatal(err)
				}
				if state == "adopted" {
					if view.Config.Operation != "image_to_video" || view.Config.FirstFrameResourceID != "ref-one" || len(view.Config.ReferenceResourceIDs) != 0 {
						t.Fatalf("adopted image must be first frame: %+v", view.Config)
					}
				} else {
					if view.Config.Operation != "image_to_video" || view.Config.FirstFrameResourceID != "" {
						t.Fatalf("invalid image must not change selected mode: %+v", view.Config)
					}
					assertIncompleteShotMediaDefaultsSaveAndBlock(t, s, db, shot.ProjectID, shot.ID, view.Config)
				}
			})
		}
	}
}

func TestDramaShotMediaDefaultsDoNotReplaceSavedConfigOrSilentlyDropMode(t *testing.T) {
	s, db, saved := shotMediaFixture(t)
	p, _ := s.repo.DramaProduction("drama-project")
	settings := parseDramaSettings(p.SettingsJSON)
	settings.Storyboard.GenerationMode = "reference_video"
	if err := db.Model(p).Update("settings_json", encodeDramaSettings(settings)).Error; err != nil {
		t.Fatal(err)
	}
	view, err := s.DramaShotMedia("user", "drama-project", "real-shot", "video")
	if err != nil || dramaShotMediaDigest(view.Config) != dramaShotMediaDigest(saved.Config) || view.Revision != saved.Revision {
		t.Fatalf("saved config changed: %+v, %v", view, err)
	}
	if err := db.Delete(&model.DramaShotMedia{}, "id = ?", saved.ID).Error; err != nil {
		t.Fatal(err)
	}
	view, err = s.DramaShotMedia("user", "drama-project", "real-shot", "video")
	if err != nil || view.Config.Operation != "reference_to_video" || len(view.Config.ReferenceResourceIDs) != 0 {
		t.Fatalf("missing references must retain selected mode: %+v, %v", view.Config, err)
	}
	assertIncompleteShotMediaDefaultsSaveAndBlock(t, s, db, "drama-project", "real-shot", view.Config)
}

func assertIncompleteShotMediaDefaultsSaveAndBlock(t *testing.T, s *Service, db *gorm.DB, projectID, shotID string, config DramaShotMediaConfig) {
	t.Helper()
	zero := int64(0)
	saved, err := s.SaveDramaShotMedia("user", projectID, shotID, "video", DramaShotMediaSaveRequest{ExpectedRevision: &zero, Config: config})
	if err != nil || saved.Config.Operation != config.Operation || len(dramaShotMediaReferenceIDs(saved.Config)) != 0 {
		t.Fatalf("missing images must preserve a saveable incomplete mode: %+v, %v", saved.Config, err)
	}
	quote, err := s.QuoteDramaShotMedia("user", projectID, shotID, "video", DramaShotMediaSaveRequest{ExpectedRevision: &saved.Revision, Config: saved.Config})
	if err != nil || quote.Ready || quote.Priced || quote.ConfirmationToken != "" || quote.Reason != "所选视频模式需要参考图片或首尾帧" {
		t.Fatalf("missing images must block draft quote: %+v, %v", quote, err)
	}
	preflight, err := s.PreflightDramaShotMedia("user", projectID, shotID, "video", DramaShotMediaActionRequest{ExpectedRevision: &saved.Revision})
	if err != nil || preflight.Ready || preflight.Priced || preflight.ConfirmationToken != "" || preflight.Reason != quote.Reason {
		t.Fatalf("missing images must block saved preflight: %+v, %v", preflight, err)
	}
	for _, entity := range []any{&model.Task{}, &model.BillingOrder{}, &model.DramaTake{}} {
		var count int64
		if err := db.Model(entity).Count(&count).Error; err != nil || count != 0 {
			t.Fatalf("incomplete mode created %T: %d, %v", entity, count, err)
		}
	}
	var wallet model.CreditAccount
	if err := db.First(&wallet, "user_id = ?", "user").Error; err != nil || wallet.AvailableMicrocredits != 10000 || wallet.ReservedMicrocredits != 0 {
		t.Fatalf("incomplete mode charged credits: %+v, %v", wallet, err)
	}
}
