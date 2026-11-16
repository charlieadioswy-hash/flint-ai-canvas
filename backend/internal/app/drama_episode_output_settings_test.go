package app

import (
	"encoding/json"
	"testing"

	"yingce/backend/internal/model"
)

func TestDramaEpisodeSettingsReachRenderAndExport(t *testing.T) {
	t.Run("render", func(t *testing.T) {
		svc, fake, projectID, episode := readyDramaEpisodeForRender(t)
		p, _ := svc.repo.DramaProduction(projectID)
		settings := parseDramaSettings(p.SettingsJSON)
		settings.AspectRatio = "16:9"
		if err := fake.db.Model(&model.DramaEpisode{}).Where("id = ?", episode.ID).Update("settings_json", encodeDramaSettings(settings)).Error; err != nil {
			t.Fatal(err)
		}
		if _, err := svc.RenderDramaEpisode("usr-drama", projectID, episode.ID, RenderDramaEpisodeRequest{ExpectedRevision: &episode.Revision}); err != nil {
			t.Fatal(err)
		}
		runDramaTicks(t, svc, projectID, 8)
		if len(fake.renders) != 1 || fake.renders[0].Width*9 != fake.renders[0].Height*16 {
			t.Fatalf("render did not use episode ratio: %+v", fake.renders)
		}
	})
	t.Run("jianying and manifest", func(t *testing.T) {
		svc, db := jianyingExportFixture(t)
		if err := db.AutoMigrate(&model.DramaCast{}, &model.DramaTake{}, &model.DramaShotMedia{}); err != nil {
			t.Fatal(err)
		}
		p, _ := svc.repo.DramaProduction("project")
		settings := parseDramaSettings(p.SettingsJSON)
		settings.AspectRatio = "16:9"
		if err := db.Model(&model.DramaEpisode{}).Where("id = ?", "episode").Update("settings_json", encodeDramaSettings(settings)).Error; err != nil {
			t.Fatal(err)
		}
		plan, err := svc.planDramaJianyingDraft("owner", "project", "episode", DramaJianyingDraftRequest{DraftRoot: "C:/Drafts"})
		if err != nil || plan.Width*9 != plan.Height*16 {
			t.Fatalf("draft did not use episode ratio: %+v %v", plan, err)
		}
		archive, err := svc.PrepareDramaAssetPackage("owner", "project", DramaAssetPackageRequest{EpisodeIDs: []string{"episode"}, Prompts: true})
		if err != nil {
			t.Fatal(err)
		}
		var manifest dramaAssetManifest
		if err := json.Unmarshal(archive.entries[0].data, &manifest); err != nil {
			t.Fatal(err)
		}
		if len(manifest.Episodes) != 1 || manifest.Episodes[0].AspectRatio != "16:9" || manifest.Drama.AspectRatio != "9:16" {
			t.Fatalf("package lost episode ratio or overwrote defaults: %+v", manifest)
		}
	})
}

func TestDramaEpisodeCastOptionsSaveValidatesCurrentEpisodeDefaults(t *testing.T) {
	for _, workspace := range []bool{false, true} {
		name := "image-options"
		if workspace {
			name = "workspace"
		}
		t.Run(name, func(t *testing.T) {
			svc, fake, projectID, detail := dramaStudioFixture(t)
			seedDramaStudioBatchImagePrice(t, fake)
			p, _ := svc.repo.DramaProduction(projectID)
			defaults := parseDramaSettings(p.SettingsJSON)
			defaults.Assets.Resolution = "4k"
			if err := svc.repo.UpdateDramaProduction(projectID, map[string]any{"settings_json": encodeDramaSettings(defaults)}); err != nil {
				t.Fatal(err)
			}
			own := defaults
			own.Assets.Resolution = "1k"
			if err := fake.db.Model(&model.DramaEpisode{}).Where("id = ?", detail.Episode.ID).Update("settings_json", encodeDramaSettings(own)).Error; err != nil {
				t.Fatal(err)
			}
			casts, _ := svc.repo.DramaCasts(projectID)
			cast := casts[0]
			p, _ = svc.repo.DramaProduction(projectID)
			save := func(episodeID string) error {
				if workspace {
					_, err := svc.UpdateDramaCast("usr-drama", projectID, cast.ID, UpdateDramaCastRequest{EpisodeID: episodeID, ExpectedRevision: &p.Revision, ExpectedCastRevision: &cast.Revision, ImageOptions: &DramaCastImageOptions{}})
					return err
				}
				_, err := svc.UpdateDramaCastImageOptions("usr-drama", projectID, cast.ID, UpdateDramaCastImageOptionsRequest{EpisodeID: episodeID, ExpectedRevision: &p.Revision, ExpectedCastRevision: &cast.Revision})
				return err
			}
			if err := save(""); err == nil {
				t.Fatal("fixture must reject unsupported production resolution")
			}
			if err := save("foreign-episode"); err == nil {
				t.Fatal("foreign episode context accepted")
			}
			if err := save(detail.Episode.ID); err != nil {
				t.Fatalf("valid episode configuration rejected: %v", err)
			}
			if fake.byKind["image"] != 0 {
				t.Fatal("saving started image generation")
			}
		})
	}
}
