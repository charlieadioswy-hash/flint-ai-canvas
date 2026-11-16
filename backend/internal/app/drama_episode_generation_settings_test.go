package app

import (
	"encoding/json"
	"strings"
	"testing"

	"yingce/backend/internal/model"
)

func TestDramaEpisodeSettingsReachScriptAndPromptTask(t *testing.T) {
	svc, fake, projectID, detail := dramaStudioFixture(t)
	p, _ := svc.repo.DramaProduction(projectID)
	settings := parseDramaSettings(p.SettingsJSON)
	settings.StyleName, settings.StylePrompt = "本集水彩", "本集专属水彩标记"
	settings.Models.ScriptText = DramaModelChoice{ChannelID: "ch", ModelKey: "episode-script"}
	settings.Models.PromptText = DramaModelChoice{ChannelID: "ch", ModelKey: "episode-prompt"}
	settings.TextThinking.Script, settings.TextThinking.Prompt = "high", "low"
	if err := fake.db.Model(&model.DramaEpisode{}).Where("id = ?", detail.Episode.ID).Updates(map[string]any{"settings_json": encodeDramaSettings(settings), "stage": model.DramaEpisodeScript}).Error; err != nil {
		t.Fatal(err)
	}
	project, _ := svc.repo.ProjectForUser("usr-drama", projectID)
	run := &dramaRun{s: svc, project: project, production: p, settings: parseDramaSettings(p.SettingsJSON), meta: parseDramaBibleMeta(p.BibleJSON)}
	if err := run.loadCasts(); err != nil {
		t.Fatal(err)
	}
	if _, skip, err := run.submitScript(&model.DramaJob{ID: "episode-script", ProjectID: projectID, EpisodeID: detail.Episode.ID, Kind: model.DramaJobScript}); err != nil || skip {
		t.Fatalf("script: skip=%v, %v", skip, err)
	}
	if err := fake.db.Model(&model.DramaSegment{}).Where("id = ?", detail.Segments[0].ID).Update("prompt_status", "").Error; err != nil {
		t.Fatal(err)
	}
	if _, skip, err := run.submitSegmentPrompt(&model.DramaJob{ID: "episode-prompt", ProjectID: projectID, EpisodeID: detail.Episode.ID, ShotID: detail.Segments[0].ID, Kind: model.DramaJobSegmentPrompt}); err != nil || skip {
		t.Fatalf("prompt: skip=%v, %v", skip, err)
	}
	for index, want := range []struct{ model, thinking string }{{"episode-script", "high"}, {"episode-prompt", "low"}} {
		req := fake.requests[len(fake.requests)-2+index]
		options := req.Input["textOptions"].(map[string]any)
		if req.Model != want.model || options["thinkingLevel"] != want.thinking || !strings.Contains(req.Prompt, "本集专属水彩标记") {
			t.Fatalf("episode text settings not applied: %+v", req)
		}
	}
}

func TestDramaEpisodeVideoPreflightAndSubmissionUseSameSettings(t *testing.T) {
	svc, fake, projectID, detail := dramaStudioFixture(t)
	p, _ := svc.repo.DramaProduction(projectID)
	settings := parseDramaSettings(p.SettingsJSON)
	settings.AspectRatio, settings.VideoResolution, settings.VideoContinuity = "16:9", "1080p", DramaContinuityParallel
	settings.Models.Video = DramaModelChoice{ChannelID: "ch", ModelKey: "episode-video"}
	capability := dramaVideoFixture()
	capability.Duration.Values, capability.Duration.Default = []int{10}, 10
	capability.Resolutions, capability.DefaultResolution = []string{"1080p"}, "1080p"
	raw, _ := json.Marshal(&ModelCapabilityConfig{Version: 1, Video: &capability})
	if err := fake.db.Create(&model.ChannelModel{ID: "episode-video", ChannelID: "ch", ModelKey: "episode-video", Capability: "video", Protocol: model.ChannelInterfaceVolcengineArkVideo, Enabled: true, CapabilityConfigJSON: string(raw)}).Error; err != nil {
		t.Fatal(err)
	}
	if err := fake.db.Model(&model.DramaEpisode{}).Where("id = ?", detail.Episode.ID).Update("settings_json", encodeDramaSettings(settings)).Error; err != nil {
		t.Fatal(err)
	}
	if err := fake.db.Model(&model.DramaSegment{}).Where("id = ?", detail.Segments[1].ID).Update("prompt_seconds", 0).Error; err != nil {
		t.Fatal(err)
	}
	request := DramaStudioActionRequest{Action: "segment_video", TargetID: detail.Segments[1].ID, EpisodeID: detail.Episode.ID}
	view, err := svc.PreflightDramaStudioAction("usr-drama", projectID, request)
	if err != nil || !view.Ready || view.Request == nil || view.Request.Seconds != 10 || view.Request.FirstFramePending {
		t.Fatalf("episode preflight: %+v, %v", view, err)
	}
	settings.AspectRatio = "9:16"
	if err := fake.db.Model(&model.DramaEpisode{}).Where("id = ?", detail.Episode.ID).Update("settings_json", encodeDramaSettings(settings)).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ExecuteDramaStudioAction("usr-drama", projectID, confirmedDramaStudioRequest(view)); err == nil {
		t.Fatal("changed episode settings accepted old confirmation")
	}
	settings.AspectRatio = "16:9"
	if err := fake.db.Model(&model.DramaEpisode{}).Where("id = ?", detail.Episode.ID).Update("settings_json", encodeDramaSettings(settings)).Error; err != nil {
		t.Fatal(err)
	}
	view, err = svc.PreflightDramaStudioAction("usr-drama", projectID, request)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ExecuteDramaStudioAction("usr-drama", projectID, confirmedDramaStudioRequest(view)); err != nil {
		t.Fatal(err)
	}
	runDramaTicks(t, svc, projectID, 8)
	requests := dramaVideoRequests(fake)
	if len(requests) != 1 {
		t.Fatalf("expected one scoped video, got %+v", requests)
	}
	config := requests[0].Input["config"].(map[string]any)
	if requests[0].Model != "episode-video" || config["size"] != "16:9" || config["vquality"] != "1080p" || config["videoSeconds"] != "10" {
		t.Fatalf("episode video settings not submitted: %+v", requests[0])
	}
}

func TestDramaEpisodeShotDefaultsPreserveSavedConfig(t *testing.T) {
	svc, db := newShotMediaDefaultsFixture(t, "reference_video")
	p, _ := svc.repo.DramaProduction("drama-project")
	settings := parseDramaSettings(p.SettingsJSON)
	settings.AspectRatio, settings.VideoResolution = "16:9", "1080p"
	settings.Storyboard.GenerationMode = "storyboard"
	settings.Models.Image = DramaModelChoice{ChannelID: "episode", ModelKey: "image"}
	if err := db.Model(&model.DramaEpisode{}).Where("id = ?", "episode").Update("settings_json", encodeDramaSettings(settings)).Error; err != nil {
		t.Fatal(err)
	}
	video, err := svc.DramaShotMedia("user", "drama-project", "real-shot", "video")
	if err != nil || video.Config.AspectRatio != "16:9" || video.Config.Resolution != "1080p" || video.Config.Operation != "image_to_video" {
		t.Fatalf("episode video defaults: %+v, %v", video.Config, err)
	}
	image, err := svc.DramaShotMedia("user", "drama-project", "real-shot", "image")
	if err != nil || image.Config.Model.ModelKey != "image" || image.Config.Model.ChannelID != "episode" || image.Config.AspectRatio != "16:9" {
		t.Fatalf("episode image defaults: %+v, %v", image.Config, err)
	}
	saved, _ := json.Marshal(video.Config)
	if err := db.Create(&model.DramaShotMedia{ID: "episode-video-slot", ProjectID: "drama-project", EpisodeID: "episode", ShotID: "real-shot", Kind: "video", ConfigJSON: string(saved)}).Error; err != nil {
		t.Fatal(err)
	}
	settings.AspectRatio, settings.Storyboard.GenerationMode = "9:16", "reference_video"
	if err := db.Model(&model.DramaEpisode{}).Where("id = ?", "episode").Update("settings_json", encodeDramaSettings(settings)).Error; err != nil {
		t.Fatal(err)
	}
	after, err := svc.DramaShotMedia("user", "drama-project", "real-shot", "video")
	if err != nil || dramaShotMediaDigest(after.Config) != dramaShotMediaDigest(video.Config) {
		t.Fatalf("saved shot config changed with episode: %+v, %v", after.Config, err)
	}
}

func TestDramaCastJobContextDoesNotSplitSharedSlot(t *testing.T) {
	if dramaJobKey(model.DramaJobCastImage, "episode-one", "", "cast") != dramaJobKey(model.DramaJobCastImage, "episode-two", "", "cast") {
		t.Fatal("shared cast slot must deduplicate across episode settings contexts")
	}
}

func TestDramaEpisodeCastQueueRetainsSettingsContext(t *testing.T) {
	for _, batch := range []bool{false, true} {
		name := "single"
		if batch {
			name = "batch"
		}
		t.Run(name, func(t *testing.T) {
			svc, fake, projectID, detail := dramaStudioFixture(t)
			p, _ := svc.repo.DramaProduction(projectID)
			settings := parseDramaSettings(p.SettingsJSON)
			settings.StyleName, settings.StylePrompt = "本集水彩", "本集主体画风标记"
			settings.Assets.CharacterRatio = "16:9"
			if err := fake.db.Model(&model.DramaEpisode{}).Where("id = ?", detail.Episode.ID).Update("settings_json", encodeDramaSettings(settings)).Error; err != nil {
				t.Fatal(err)
			}
			casts, _ := svc.repo.DramaCasts(projectID)
			cast := casts[0]
			if batch {
				request := DramaStudioBatchRequest{Action: "cast_image", TargetIDs: []string{cast.ID}, EpisodeID: detail.Episode.ID}
				view, err := svc.PreflightDramaStudioBatch("usr-drama", projectID, request)
				if err != nil || view.Counts["ready"] != 1 || view.Items[0].EpisodeID != detail.Episode.ID {
					t.Fatalf("batch preflight context: %+v, %v", view, err)
				}
				request.BaseRevision, request.ConfirmationToken = &view.BaseRevision, view.ConfirmationToken
				if _, err := svc.ExecuteDramaStudioBatch("usr-drama", projectID, request); err != nil {
					t.Fatal(err)
				}
			} else {
				request := DramaStudioActionRequest{Action: "cast_image", TargetID: cast.ID, EpisodeID: detail.Episode.ID}
				wrong := request
				wrong.EpisodeID = "foreign-episode"
				if _, err := svc.PreflightDramaStudioAction("usr-drama", projectID, wrong); err == nil {
					t.Fatal("foreign episode settings accepted")
				}
				view, err := svc.PreflightDramaStudioAction("usr-drama", projectID, request)
				if err != nil || !view.Ready || view.EpisodeID != detail.Episode.ID {
					t.Fatalf("single preflight context: %+v, %v", view, err)
				}
				if _, err := svc.ExecuteDramaStudioAction("usr-drama", projectID, confirmedDramaStudioRequest(view)); err != nil {
					t.Fatal(err)
				}
			}
			queued, _ := svc.repo.DramaCast(projectID, cast.ID)
			if queued.ImageEpisodeID != detail.Episode.ID || queued.ImageStatus != model.DramaMediaQueued {
				t.Fatalf("cast queue context lost: %+v", queued)
			}
			runDramaTicks(t, svc, projectID, 5)
			generated := 0
			for _, request := range fake.requests {
				if request.Type == "canvas_image" {
					generated++
					if !strings.Contains(request.Prompt, "本集主体画风标记") || request.Input["metadata"].(map[string]any)["episodeId"] != detail.Episode.ID || request.Input["config"].(map[string]any)["size"] != "16:9" {
						t.Fatalf("worker lost episode settings context: %+v", request)
					}
				}
			}
			if generated != 1 {
				t.Fatalf("scoped cast should generate once, got %d", generated)
			}
		})
	}
}
