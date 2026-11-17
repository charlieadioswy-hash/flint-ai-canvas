package app

import (
	"testing"

	"yingce/backend/internal/model"
	"yingce/backend/internal/production"
)

func TestDramaWorkflowModeConfirmsAssetsAtomically(t *testing.T) {
	for _, mode := range []string{"reference_video", "grid_image", "smart_director", "storyboard"} {
		t.Run(mode, func(t *testing.T) {
			svc, fake := newDramaTestService(t)
			draft := createGuidedDrama(t, svc, DramaChapterInput{Title: "第一集", Text: "少年走入院子，推开木门。"})
			assets := confirmGuide(t, svc, draft)
			runDramaTicks(t, svc, draft.Project.ID, 8)
			assets = guideSummary(t, svc, draft.Project.ID)
			settings := assets.Production.Settings
			settings.Storyboard.GenerationMode, settings.Storyboard.TargetShotCount = mode, 8
			settings.Storyboard.ShotCountMode = production.ShotCountFixed
			if mode == "smart_director" {
				settings.Storyboard.DirectorTemplate = "smart_drama"
			}
			if mode == "storyboard" {
				settings.Storyboard.DirectorTemplate = "storyboard_detail"
			}
			originalStyle, originalLanguage := settings.StylePrompt, settings.Language
			settings.StylePrompt, settings.Language = "不应跨页面覆盖风格", "不应覆盖语言"
			next, err := svc.ConfirmDramaGuide("usr-drama", draft.Project.ID, ConfirmDramaGuideRequest{ExpectedStep: model.DramaGuideAssets, ExpectedRevision: assets.Production.Revision, Settings: &settings})
			if err != nil {
				t.Fatal(err)
			}
			if next.Production.GuideStep != model.DramaGuideStory || next.Production.Revision != assets.Production.Revision+1 || next.Production.Settings.Storyboard.GenerationMode != mode || next.Production.Settings.Storyboard.ShotCountMode != production.ShotCountFixed || next.Production.Settings.Storyboard.TargetShotCount != 8 {
				t.Fatalf("mode and transition must save together: %+v", next.Production)
			}
			episode, err := svc.repo.DramaEpisode(draft.Project.ID, next.Episodes[0].ID)
			if err != nil || !parseDramaSettings(episode.SettingsJSON).Storyboard.HasFixedShotCount() {
				t.Fatalf("shot count mode did not reach the episode: %v", err)
			}
			if next.Production.Settings.StylePrompt != originalStyle || next.Production.Settings.Language != originalLanguage {
				t.Fatal("mode dialog overwrote unrelated settings")
			}
			_, err = svc.ConfirmDramaGuide("usr-drama", draft.Project.ID, ConfirmDramaGuideRequest{ExpectedStep: model.DramaGuideAssets, ExpectedRevision: assets.Production.Revision, Settings: &settings})
			requireGuideConflict(t, err)
			if fake.byKind["image"]+fake.byKind["video"] != 0 {
				t.Fatal("mode selection generated paid media")
			}
		})
	}
}

func TestDramaWorkflowModeRejectsInvalidBeforeAdvancing(t *testing.T) {
	svc, _ := newDramaTestService(t)
	draft := createGuidedDrama(t, svc, DramaChapterInput{Title: "第一集", Text: "少年出发。"})
	assets := confirmGuide(t, svc, draft)
	runDramaTicks(t, svc, draft.Project.ID, 8)
	assets = guideSummary(t, svc, draft.Project.ID)
	settings := assets.Production.Settings
	settings.Storyboard.GenerationMode = "invented"
	_, err := svc.ConfirmDramaGuide("usr-drama", draft.Project.ID, ConfirmDramaGuideRequest{ExpectedStep: model.DramaGuideAssets, ExpectedRevision: assets.Production.Revision, Settings: &settings})
	if err == nil {
		t.Fatal("invalid mode accepted")
	}
	after := guideSummary(t, svc, draft.Project.ID)
	if after.Production.Revision != assets.Production.Revision || after.Production.GuideStep != model.DramaGuideAssets {
		t.Fatal("invalid configuration advanced the workflow")
	}
	settings.Storyboard.GenerationMode = "reference_video"
	_, err = svc.ConfirmDramaGuide("other-user", draft.Project.ID, ConfirmDramaGuideRequest{ExpectedStep: model.DramaGuideAssets, ExpectedRevision: assets.Production.Revision, Settings: &settings})
	if err == nil {
		t.Fatal("another user changed the workflow")
	}
	for _, value := range []string{"", "comic", "live_action", "narration"} {
		if (DramaSettings{DramaType: value}).validateDramaType() != nil {
			t.Fatalf("valid drama type rejected: %q", value)
		}
	}
	if (DramaSettings{DramaType: "invented"}).validateDramaType() == nil {
		t.Fatal("invalid drama type accepted")
	}
}
