package app

import (
	"encoding/json"
	"strings"
	"testing"

	"gorm.io/gorm"
	"yingce/backend/internal/model"
)

func episodeCastViewFixture(t *testing.T) (*Service, *gorm.DB, DramaCastViewResult, DramaSettings) {
	t.Helper()
	s, db, view := castViewsFixture(t)
	p, _ := s.repo.DramaProduction("view-project")
	settings := parseDramaSettings(p.SettingsJSON)
	settings.StyleName, settings.StylePrompt = "本集水彩", "本集专属水彩标记"
	settings.Assets.Mode, settings.Assets.CharacterPrompt = "dual_closeup_front_back_no_head", ""
	settings.Assets.CharacterRatio = "9:16"
	settings.Models.Image = DramaModelChoice{ChannelID: "channel", ModelKey: "episode-image"}
	var channelModel model.ChannelModel
	if err := db.First(&channelModel, "id = ?", "view-cm").Error; err != nil {
		t.Fatal(err)
	}
	channelModel.ID, channelModel.ModelKey = "episode-view-cm", "episode-image"
	for _, row := range []any{
		&channelModel,
		&model.ChannelModelPriceTier{ID: "episode-view-price", ChannelModelID: channelModel.ID, SelectorKey: "{}", SelectorJSON: "{}", BillingMode: "fixed_request", UnitPriceMicrocredits: 3, PriceConfigured: true, Enabled: true},
		&model.DramaEpisode{ID: "view-episode", ProjectID: "view-project", Number: 1, Stage: model.DramaEpisodeScript, SettingsJSON: encodeDramaSettings(settings)},
		&model.DramaEpisode{ID: "other-view-episode", ProjectID: "view-project", Number: 2, Stage: model.DramaEpisodeScript, SettingsJSON: encodeDramaSettings(settings)},
		&model.DramaEpisode{ID: "foreign-view-episode", ProjectID: "foreign-project", Number: 1, SettingsJSON: encodeDramaSettings(settings)},
	} {
		if err := db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	return s, db, view, settings
}

func TestDramaEpisodeCastPromptPreviewUsesCurrentSettingsWithoutSaving(t *testing.T) {
	s, db, _, _ := episodeCastViewFixture(t)
	prompt, err := s.PreviewDramaCastImagePrompt("user", "view-project", "view-cast", DramaCastImagePromptRequest{EpisodeID: "view-episode"})
	if err != nil || !strings.Contains(prompt, "本集专属水彩标记") || !strings.Contains(prompt, "9:16") {
		t.Fatalf("episode preview %q: %v", prompt, err)
	}
	style := "主体独立画风"
	prompt, err = s.PreviewDramaCastImagePrompt("user", "view-project", "view-cast", DramaCastImagePromptRequest{EpisodeID: "view-episode", ImageStylePrompt: &style})
	if err != nil || !strings.Contains(prompt, style) || strings.Contains(prompt, "本集专属水彩标记") {
		t.Fatalf("explicit cast style lost: %q, %v", prompt, err)
	}
	if _, err := s.PreviewDramaCastImagePrompt("user", "view-project", "view-cast", DramaCastImagePromptRequest{EpisodeID: "foreign-view-episode"}); !isAppErrorStatus(err, 404) {
		t.Fatalf("foreign episode accepted: %v", err)
	}
	cast, _ := s.repo.DramaCast("view-project", "view-cast")
	var tasks int64
	db.Model(&model.Task{}).Count(&tasks)
	if cast.ImagePrompt != "" || cast.ImageStylePrompt != "" || tasks != 0 {
		t.Fatal("preview changed saved data or generated media")
	}
}

func TestDramaEpisodeCastViewSaveQuoteAndTaskShareContext(t *testing.T) {
	s, db, view, settings := episodeCastViewFixture(t)
	p, _ := s.repo.DramaProduction("view-project")
	cast, _ := s.repo.DramaCast("view-project", "view-cast")
	view.Config.ImageOptions.Ratio = ""
	foreign := DramaCastViewSaveRequest{EpisodeID: "foreign-view-episode", ExpectedRevision: &p.Revision, ExpectedCastRevision: &cast.Revision, ViewRevision: &view.Revision, Config: view.Config}
	if _, err := s.SaveDramaCastView("user", "view-project", "view-cast", view.ID, foreign); !isAppErrorStatus(err, 404) {
		t.Fatalf("foreign episode save accepted: %v", err)
	}
	defaults := parseDramaSettings(p.SettingsJSON)
	defaults.Models.Image = DramaModelChoice{ChannelID: "missing", ModelKey: "unavailable"}
	if err := db.Model(p).Update("settings_json", encodeDramaSettings(defaults)).Error; err != nil {
		t.Fatal(err)
	}
	view, err := s.SaveDramaCastView("user", "view-project", "view-cast", view.ID, DramaCastViewSaveRequest{EpisodeID: "view-episode", ExpectedRevision: &p.Revision, ExpectedCastRevision: &cast.Revision, ViewRevision: &view.Revision, Config: view.Config})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.PreflightDramaCastView("user", "view-project", "view-cast", view.ID, DramaCastViewActionRequest{EpisodeID: "foreign-view-episode"}); !isAppErrorStatus(err, 404) {
		t.Fatalf("foreign episode accepted: %v", err)
	}
	preview, err := s.PreflightDramaCastView("user", "view-project", "view-cast", view.ID, DramaCastViewActionRequest{EpisodeID: "view-episode"})
	if err != nil || !preview.Ready || preview.AmountMicrocredits != 3 {
		t.Fatalf("episode quote: %+v, %v", preview, err)
	}
	req := DramaCastViewActionRequest{EpisodeID: "view-episode", ExpectedRevision: &preview.Revision, ViewRevision: &preview.ViewRevision, ConfirmationToken: preview.ConfirmationToken, ClientOperationID: "episode-view"}
	wrong := req
	wrong.EpisodeID = "other-view-episode"
	if _, err := s.ExecuteDramaCastView("user", "view-project", "view-cast", view.ID, wrong); !isAppErrorStatus(err, 409) {
		t.Fatalf("confirmation crossed episodes: %v", err)
	}
	changed := settings
	changed.StylePrompt = "确认后改动本集画风"
	if err := db.Model(&model.DramaEpisode{}).Where("id = ?", "view-episode").Update("settings_json", encodeDramaSettings(changed)).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := s.ExecuteDramaCastView("user", "view-project", "view-cast", view.ID, req); !isAppErrorStatus(err, 409) {
		t.Fatalf("changed episode configuration accepted old confirmation: %v", err)
	}
	if err := db.Model(&model.DramaEpisode{}).Where("id = ?", "view-episode").Update("settings_json", encodeDramaSettings(settings)).Error; err != nil {
		t.Fatal(err)
	}
	task, err := s.ExecuteDramaCastView("user", "view-project", "view-cast", view.ID, req)
	if err != nil {
		t.Fatal(err)
	}
	var input struct {
		Config struct {
			Model string `json:"model"`
			Size  string `json:"size"`
		} `json:"config"`
		Metadata struct {
			EpisodeID string `json:"dramaEpisodeId"`
		} `json:"metadata"`
	}
	stored, _ := s.repo.Task(task.ID)
	if err := json.Unmarshal([]byte(stored.InputJSON), &input); err != nil {
		t.Fatal(err)
	}
	if input.Config.Model != "episode-image" || input.Config.Size != "9:16" || input.Metadata.EpisodeID != "view-episode" || !strings.Contains(task.Prompt, "本集专属水彩标记") {
		t.Fatalf("context lost at submission: %+v, %s", input, task.Prompt)
	}
	completeCastView(t, s, db, task.ID, "episode-view-result")
	latest, err := s.DramaCastView("user", "view-project", "view-cast", view.ID)
	if err != nil || latest.ResourceID != "episode-view-result" || latest.Status != "ready" || !latest.Takes[0].Current {
		t.Fatalf("scoped result not adopted: %+v, %v", latest, err)
	}
}

func TestDramaEpisodeCastViewExplicitOptionsOverrideContext(t *testing.T) {
	s, _, view, _ := episodeCastViewFixture(t)
	cast, _ := s.repo.DramaCast("view-project", "view-cast")
	opts := DramaCastImageOptions{Model: DramaModelChoice{ChannelID: "channel", ModelKey: "grok-image"}, Ratio: "9:16"}
	raw, _ := json.Marshal(opts)
	if err := s.repo.UpdateDramaCastFields(cast.ID, map[string]any{"image_options_json": string(raw)}); err != nil {
		t.Fatal(err)
	}
	plan, err := s.prepareDramaCastView(s.repo, "user", "view-project", "view-cast", view.ID, DramaCastViewActionRequest{EpisodeID: "view-episode"})
	if err != nil || !plan.view.Ready || plan.view.AmountMicrocredits != 2 {
		t.Fatalf("cast override: %+v, %v", plan.view, err)
	}
	config := plan.request.Input["config"].(map[string]any)
	if config["model"] != "grok-image" || config["size"] != "1:1" {
		t.Fatalf("view ratio/cast model overrides lost: %+v", config)
	}
}

func TestDramaEpisodeCastViewPreservesLateResultAfterContextChange(t *testing.T) {
	for _, mode := range []string{"edit", "delete"} {
		t.Run(mode, func(t *testing.T) {
			s, db, view, settings := episodeCastViewFixture(t)
			preview, err := s.PreflightDramaCastView("user", "view-project", "view-cast", view.ID, DramaCastViewActionRequest{EpisodeID: "view-episode"})
			if err != nil || !preview.Ready {
				t.Fatalf("preflight %+v %v", preview, err)
			}
			req := DramaCastViewActionRequest{EpisodeID: "view-episode", ExpectedRevision: &preview.Revision, ViewRevision: &preview.ViewRevision, ConfirmationToken: preview.ConfirmationToken, ClientOperationID: "late-view"}
			task, err := s.ExecuteDramaCastView("user", "view-project", "view-cast", view.ID, req)
			if err != nil {
				t.Fatal(err)
			}
			if mode == "edit" {
				settings.StylePrompt = "更新后的本集画风"
				err = db.Model(&model.DramaEpisode{}).Where("id = ?", "view-episode").Update("settings_json", encodeDramaSettings(settings)).Error
			} else {
				err = db.Delete(&model.DramaEpisode{}, "id = ?", "view-episode").Error
			}
			if err != nil {
				t.Fatal(err)
			}
			completeCastView(t, s, db, task.ID, "late-episode-view")
			latest, err := s.DramaCastView("user", "view-project", "view-cast", view.ID)
			if err != nil || latest.ResourceID != "" || len(latest.Takes) != 1 || latest.Takes[0].ResourceID != "late-episode-view" || latest.Takes[0].Current {
				t.Fatalf("late context result lost or adopted: %+v, %v", latest, err)
			}
		})
	}
}
