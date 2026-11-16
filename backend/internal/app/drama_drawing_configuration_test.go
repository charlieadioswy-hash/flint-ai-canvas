package app

import (
	"errors"
	"reflect"
	"testing"

	"gorm.io/gorm"
	"yingce/backend/internal/model"
	"yingce/backend/internal/production"
)

func dramaDrawingTestConfiguration(t *testing.T, fake *fakeDramaBackend) DramaDrawingConfiguration {
	t.Helper()
	config := DefaultModelCapabilityConfigForModel(string(model.ChannelInterfaceGrokImage), "grok-image")
	for _, row := range []any{
		&model.ModelChannel{ID: "drawing-channel", Scope: model.ChannelScopeSystem, Enabled: true, Name: "绘图模板测试"},
		&model.ChannelModel{ID: "drawing-image", ChannelID: "drawing-channel", ModelKey: "grok-image", Capability: "image", Protocol: model.ChannelInterfaceGrokImage, CapabilityConfigJSON: mustEncodeModelCapabilityConfig(t, config), BillingMode: "fixed_request", PriceConfigured: true, Enabled: true},
		&model.ChannelModelPriceTier{ID: "drawing-price", ChannelModelID: "drawing-image", SelectorKey: "{}", SelectorJSON: "{}", BillingMode: "fixed_request", UnitPriceMicrocredits: 2, PriceConfigured: true, Enabled: true},
	} {
		if err := fake.db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	choice := DramaModelChoice{ChannelID: "drawing-channel", ModelKey: "grok-image"}
	return DramaDrawingConfiguration{Assets: production.AssetSettings{Mode: production.AssetModeHeadshotFullbody}.Normalized(), Models: DramaDrawingModels{Image: choice, CharacterImage: choice, SceneImage: choice}}
}

func TestDramaStyleDrawingSavesSharedTemplatesWithoutChangingContent(t *testing.T) {
	for _, scope := range []string{"episode-inherit", "project"} {
		t.Run(scope, func(t *testing.T) {
			svc, fake, projectID, detail := dramaStudioFixture(t)
			drawing := dramaDrawingTestConfiguration(t, fake)
			p, _ := svc.repo.DramaProduction(projectID)
			before := parseDramaSettings(p.SettingsJSON)
			before.StyleName, before.StylePrompt = "原全剧风格", "原全剧画风保持不变"
			before.Models.PropImage = drawing.Models.Image
			before.Models.PropImage.Label = "独立道具模型保持不变"
			before.Models.ScriptText.Label = "分镜模型保持不变"
			before.Models.Video.Label = "视频模型保持不变"
			if err := svc.repo.UpdateDramaProduction(projectID, map[string]any{"settings_json": encodeDramaSettings(before), "guide_step": model.DramaGuideStory}); err != nil {
				t.Fatal(err)
			}
			view, _ := svc.DramaEpisodeStyle("usr-drama", projectID, detail.Episode.ID)
			beforeEpisode, _ := svc.repo.DramaEpisode(projectID, detail.Episode.ID)
			beforeShots, _ := svc.repo.DramaShots(detail.Episode.ID)
			beforeSegments, _ := svc.repo.DramaSegments(detail.Episode.ID)
			beforeCasts, _ := svc.repo.DramaCasts(projectID)
			beforeJobs, _ := svc.repo.DramaJobsByStatus(projectID, model.DramaJobQueued, model.DramaJobRunning)
			requests := len(fake.requests)
			if scope == "episode-inherit" {
				saved, err := svc.UpdateDramaEpisodeStyle("usr-drama", projectID, detail.Episode.ID, UpdateDramaEpisodeStyleRequest{ExpectedRevision: &view.Revision, ExpectedEpisodeRevision: &view.EpisodeRevision, Mode: dramaEpisodeStyleInherit, Drawing: &drawing})
				if err != nil || saved.Mode != dramaEpisodeStyleInherit || saved.StylePrompt != view.StylePrompt || !reflect.DeepEqual(saved.Drawing, drawing) {
					t.Fatalf("inherited style drawing save: %+v %v", saved, err)
				}
			} else {
				if _, err := svc.UpdateDramaWorkflowStyle("usr-drama", projectID, UpdateDramaWorkflowStyleRequest{ExpectedRevision: &view.Revision, StyleName: before.StyleName, StylePrompt: before.StylePrompt, Drawing: &drawing}); err != nil {
					t.Fatal(err)
				}
			}
			afterProduction, _ := svc.repo.DramaProduction(projectID)
			expected := before
			expected.Assets = drawing.Assets
			expected.Models.Image, expected.Models.CharacterImage, expected.Models.SceneImage = drawing.Models.Image, drawing.Models.CharacterImage, drawing.Models.SceneImage
			if afterProduction.Revision != view.Revision+1 || afterProduction.GuideStep != model.DramaGuideStory || !reflect.DeepEqual(parseDramaSettings(afterProduction.SettingsJSON), expected) {
				t.Fatalf("drawing save changed unrelated settings: %+v", afterProduction)
			}
			episodes, _ := svc.repo.DramaEpisodes(projectID)
			shared, _ := svc.DramaEpisodeStyle("usr-drama", projectID, episodes[1].ID)
			if !reflect.DeepEqual(shared.Drawing, drawing) {
				t.Fatal("drawing configuration was not shared with other episodes")
			}
			afterEpisode, _ := svc.repo.DramaEpisode(projectID, detail.Episode.ID)
			afterShots, _ := svc.repo.DramaShots(detail.Episode.ID)
			afterSegments, _ := svc.repo.DramaSegments(detail.Episode.ID)
			afterCasts, _ := svc.repo.DramaCasts(projectID)
			afterJobs, _ := svc.repo.DramaJobsByStatus(projectID, model.DramaJobQueued, model.DramaJobRunning)
			afterEpisode.StyleMode, afterEpisode.UpdatedAt = beforeEpisode.StyleMode, beforeEpisode.UpdatedAt
			if !reflect.DeepEqual(beforeEpisode, afterEpisode) || !reflect.DeepEqual(beforeShots, afterShots) || !reflect.DeepEqual(beforeSegments, afterSegments) || !reflect.DeepEqual(beforeCasts, afterCasts) || !reflect.DeepEqual(beforeJobs, afterJobs) || len(fake.requests) != requests {
				t.Fatal("saving drawing configuration rewrote existing content or submitted generation")
			}
		})
	}
}

func TestDramaStyleDrawingInvalidOrStaleSaveKeepsBothScopes(t *testing.T) {
	svc, fake, projectID, detail := dramaStudioFixture(t)
	drawing := dramaDrawingTestConfiguration(t, fake)
	view, _ := svc.DramaEpisodeStyle("usr-drama", projectID, detail.Episode.ID)
	before, _ := svc.repo.DramaProduction(projectID)
	beforeEpisode, _ := svc.repo.DramaEpisode(projectID, detail.Episode.ID)
	for _, kind := range []string{"production-version", "episode-version", "template", "image-model", "active-job"} {
		t.Run(kind, func(t *testing.T) {
			input := drawing
			req := UpdateDramaEpisodeStyleRequest{ExpectedRevision: &view.Revision, ExpectedEpisodeRevision: &view.EpisodeRevision, Mode: dramaEpisodeStyleIndependent, StyleName: "新风格", StylePrompt: "不应部分保存的风格", Drawing: &input}
			switch kind {
			case "production-version":
				wrong := view.Revision + 1
				req.ExpectedRevision = &wrong
			case "episode-version":
				wrong := view.EpisodeRevision + 1
				req.ExpectedEpisodeRevision = &wrong
			case "template":
				input.Assets.CharacterPrompt = "{{不存在的变量}}"
			case "image-model":
				input.Models.Image.ChannelID = "foreign-channel"
			case "active-job":
				if err := svc.repo.CreateDramaJobs([]model.DramaJob{{ID: "drawing-active", ProjectID: projectID, EpisodeID: detail.Episode.ID, Kind: model.DramaJobScript, Status: model.DramaJobRunning}}); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := svc.UpdateDramaEpisodeStyle("usr-drama", projectID, detail.Episode.ID, req); err == nil {
				t.Fatal("invalid or stale drawing save accepted")
			}
			after, _ := svc.repo.DramaProduction(projectID)
			afterEpisode, _ := svc.repo.DramaEpisode(projectID, detail.Episode.ID)
			if !reflect.DeepEqual(before, after) || !reflect.DeepEqual(beforeEpisode, afterEpisode) {
				t.Fatal("failed drawing validation partially wrote episode style or production settings")
			}
		})
	}
}

func TestDramaStyleDrawingLateFailureRollsBackEpisodeAndProduction(t *testing.T) {
	svc, fake, projectID, detail := dramaStudioFixture(t)
	drawing := dramaDrawingTestConfiguration(t, fake)
	view, _ := svc.DramaEpisodeStyle("usr-drama", projectID, detail.Episode.ID)
	before, _ := svc.repo.DramaProduction(projectID)
	beforeEpisode, _ := svc.repo.DramaEpisode(projectID, detail.Episode.ID)
	injected := false
	if err := fake.db.Callback().Update().Before("gorm:update").Register("drawing-production-failure", func(tx *gorm.DB) {
		if fields, ok := tx.Statement.Dest.(map[string]any); tx.Statement.Table == "drama_productions" && ok && fields["settings_json"] != nil {
			injected = true
			tx.AddError(errors.New("injected drawing settings failure"))
		}
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = fake.db.Callback().Update().Remove("drawing-production-failure") })
	if _, err := svc.UpdateDramaEpisodeStyle("usr-drama", projectID, detail.Episode.ID, UpdateDramaEpisodeStyleRequest{ExpectedRevision: &view.Revision, ExpectedEpisodeRevision: &view.EpisodeRevision, Mode: dramaEpisodeStyleIndependent, StyleName: "不应保存", StylePrompt: "事务失败不能留下本集风格", Drawing: &drawing}); err == nil {
		t.Fatal("late production write failure ignored")
	}
	if !injected {
		t.Fatal("test did not reach the final production write")
	}
	after, _ := svc.repo.DramaProduction(projectID)
	afterEpisode, _ := svc.repo.DramaEpisode(projectID, detail.Episode.ID)
	if !reflect.DeepEqual(before, after) || !reflect.DeepEqual(beforeEpisode, afterEpisode) {
		t.Fatal("late write failure partially saved episode style or shared drawing")
	}
}
