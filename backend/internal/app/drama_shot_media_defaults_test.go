package app

import (
	"encoding/json"
	"slices"
	"strings"
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
				&model.DramaCast{ID: "prop", ProjectID: "drama-project", Kind: "prop", ImageStatus: model.DramaMediaRunning, ImageResourceID: "prop-image"},
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

func TestDramaShotMediaDefaultsUseEpisodeVideoResolution(t *testing.T) {
	for _, tc := range []struct{ name, configured, want string }{
		{"supported alias", "1080P", "1080p"},
		{"unsupported", "768p", "768p"},
		{"model default", "", "720p"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, db := newShotMediaDefaultsFixture(t, "reference_video")
			p, err := s.repo.DramaProduction("drama-project")
			if err != nil {
				t.Fatal(err)
			}
			settings := parseDramaSettings(p.SettingsJSON)
			settings.VideoResolution = "480p"
			if err := db.Model(p).Update("settings_json", encodeDramaSettings(settings)).Error; err != nil {
				t.Fatal(err)
			}
			settings.VideoResolution = tc.configured
			if err := db.Model(&model.DramaEpisode{}).Where("id = ?", "episode").Update("settings_json", encodeDramaSettings(settings)).Error; err != nil {
				t.Fatal(err)
			}
			view, err := s.DramaShotMedia("user", "drama-project", "real-shot", "video")
			if err != nil || view.ID != "" || view.Config.Resolution != tc.want {
				t.Fatalf("first view resolution = %q, want %q: %+v, %v", view.Config.Resolution, tc.want, view, err)
			}
		})
	}
}

func TestDramaShotMediaDefaultsRecoverLegacyScreenSettings(t *testing.T) {
	s, db, saved := shotMediaFixture(t)
	p, err := s.repo.DramaProduction(saved.ProjectID)
	if err != nil {
		t.Fatal(err)
	}
	settings := parseDramaSettings(p.SettingsJSON)
	settings.AspectRatio = "16:9"
	settings.VideoResolution = "1080p"
	if err := db.Model(&model.DramaEpisode{}).Where("id = ?", saved.EpisodeID).Update("settings_json", encodeDramaSettings(settings)).Error; err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ ratio, resolution, wantRatio, wantResolution string }{
		{"", "", "16:9", "1080p"},
		{"auto", "auto", "16:9", "1080p"},
		{"9:16", "auto", "9:16", "1080p"},
		{"auto", "720p", "16:9", "720p"},
		{"9:16", "720p", "9:16", "720p"},
	} {
		config := saved.Config
		config.AspectRatio, config.Resolution = tc.ratio, tc.resolution
		legacy, err := json.Marshal(config)
		if err != nil {
			t.Fatal(err)
		}
		if err := db.Model(&model.DramaShotMedia{}).Where("id = ?", saved.ID).UpdateColumn("config_json", string(legacy)).Error; err != nil {
			t.Fatal(err)
		}
		view, err := s.DramaShotMedia("user", saved.ProjectID, saved.ShotID, "video")
		if err != nil || view.Revision != saved.Revision || view.Config.AspectRatio != tc.wantRatio || view.Config.Resolution != tc.wantResolution || view.Config.FirstFrameResourceID != "ref-one" || view.Config.LastFrameResourceID != "ref-two" {
			t.Fatalf("wrong legacy settings for %+v, frames should stay intact: %+v, %v", tc, view.Config, err)
		}
	}
}

func TestDramaShotVideoRejectsMissingOrIncompatibleScreenSettings(t *testing.T) {
	s, _, saved := shotMediaFixture(t)
	for _, tc := range []struct{ ratio, resolution, reason string }{
		{"9:16", "", "请选择镜头视频分辨率"},
		{"9:16", "auto", "请选择镜头视频分辨率"},
		{"auto", "720p", "请选择镜头视频画幅"},
		{"9:16", "768p", "请选择可用分辨率"},
		{"2:1", "720p", "请选择可用画幅"},
	} {
		draft := saved.Config
		draft.AspectRatio, draft.Resolution = tc.ratio, tc.resolution
		request := DramaShotMediaSaveRequest{ExpectedRevision: &saved.Revision, Config: draft}
		if _, err := s.SaveDramaShotMedia("user", saved.ProjectID, saved.ShotID, "video", request); !isAppErrorStatus(err, 400) || !strings.Contains(err.Error(), tc.reason) {
			t.Fatalf("invalid settings were saved or reported incorrectly for %+v: %v", tc, err)
		}
		quote, err := s.QuoteDramaShotMedia("user", saved.ProjectID, saved.ShotID, "video", request)
		if err != nil || quote.Ready || quote.Priced || !strings.Contains(quote.Reason, tc.reason) {
			t.Fatalf("invalid settings were admitted or reported incorrectly for %+v: %+v, %v", tc, quote, err)
		}
	}
}

func TestDramaShotMediaDefaultsTranslateFixedScreenResolutionAtSubmission(t *testing.T) {
	s, db := newShotMediaDefaultsFixture(t, "reference_video")
	capability := autoDLProfile(t, false)
	capability.Video.DefaultResolution = "768p横"
	if err := db.Model(&model.ChannelModel{}).Where("id = ?", "video-cm").Updates(map[string]any{
		"protocol": "autodl-comfyui", "provider_model_key": "minimax_h3_zm_u24", "capability_config_json": mustEncodeModelCapabilityConfig(t, capability),
	}).Error; err != nil {
		t.Fatal(err)
	}
	p, err := s.repo.DramaProduction("drama-project")
	if err != nil {
		t.Fatal(err)
	}
	shot, err := s.repo.DramaShot("drama-project", "real-shot")
	if err != nil {
		t.Fatal(err)
	}
	settings := parseDramaSettings(p.SettingsJSON)
	settings.AspectRatio = "9:16"
	for _, tc := range []struct{ configured, option, protocol string }{{"480p", "480p", "480p竖"}, {"", "768p", "768p竖"}, {"1080p", "1080p", ""}} {
		settings.VideoResolution = tc.configured
		if err := db.Model(&model.DramaEpisode{}).Where("id = ?", "episode").Update("settings_json", encodeDramaSettings(settings)).Error; err != nil {
			t.Fatal(err)
		}
		view, err := s.DramaShotMedia("user", shot.ProjectID, shot.ID, "video")
		if err != nil || view.Config.Resolution != tc.option {
			t.Fatalf("editor resolution = %q, want %q: %v", view.Config.Resolution, tc.option, err)
		}
		if tc.protocol == "" {
			if _, err := s.SaveDramaShotMedia("user", shot.ProjectID, shot.ID, "video", DramaShotMediaSaveRequest{ExpectedRevision: &view.Revision, Config: view.Config}); !isAppErrorStatus(err, 400) || !strings.Contains(err.Error(), "1080p") {
				t.Fatalf("unsupported fixed-screen tier should require an explicit correction: %v", err)
			}
			continue
		}
		input, err := s.dramaShotMediaInput(s.repo, "user", *shot, "video", view.Config)
		if err != nil {
			t.Fatal(err)
		}
		config := input["config"].(map[string]any)
		if config["size"] != "" || config["vquality"] != tc.protocol {
			t.Fatalf("protocol config = %+v, want %s and no independent aspect ratio", config, tc.protocol)
		}
	}
}

func TestDramaShotMediaDefaultsKeepSavedEmptyReferenceSelection(t *testing.T) {
	s, db := newShotMediaDefaultsFixture(t, "reference_video")
	if err := db.Create(&model.DramaCast{ID: "hero", ProjectID: "drama-project", Kind: "character", ImageStatus: model.DramaMediaReady, ImageResourceID: "ref-one"}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.DramaShot{}).Where("id = ?", "real-shot").Update("cast_ids_json", `["hero"]`).Error; err != nil {
		t.Fatal(err)
	}
	view, err := s.DramaShotMedia("user", "drama-project", "real-shot", "video")
	if err != nil || !slices.Equal(view.Config.ReferenceResourceIDs, []string{"ref-one"}) {
		t.Fatalf("unexpected initial references: %+v, %v", view.Config, err)
	}
	view.Config.ReferenceResourceIDs = []string{}
	if _, err := s.SaveDramaShotMedia("user", "drama-project", "real-shot", "video", DramaShotMediaSaveRequest{ExpectedRevision: &view.Revision, Config: view.Config}); err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.DramaCast{}).Where("id = ?", "hero").Update("image_resource_id", "ref-two").Error; err != nil {
		t.Fatal(err)
	}
	stored, err := s.DramaShotMedia("user", "drama-project", "real-shot", "video")
	if err != nil || stored.ID == "" || len(stored.Config.ReferenceResourceIDs) != 0 || len(stored.Config.ReferenceSubjects) != 0 {
		t.Fatalf("saved empty references were refilled: %+v, %v", stored.Config, err)
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
