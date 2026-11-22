package app

import (
	"encoding/json"
	"reflect"
	"testing"

	"yingce/backend/internal/model"

	"gorm.io/gorm"
)

func TestDramaGenerationSettingsSaveOnlyMediaWithoutAdvancing(t *testing.T) {
	for _, step := range []string{"", model.DramaGuideConfiguring, model.DramaGuideAssets, model.DramaGuideStory, model.DramaGuideCompleted} {
		t.Run("step-"+step, func(t *testing.T) {
			fixture := newDramaGuideRevisionFixture(t, step)
			drawing := dramaDrawingTestConfiguration(t, fixture.fake)
			for _, row := range []any{
				&model.ModelChannel{ID: "ch", Scope: model.ChannelScopeSystem, Enabled: true, Name: "视频模型测试"},
				&model.ChannelModelPriceTier{ID: "generation-video-price", ChannelModelID: "drama-video", SelectorKey: "{}", SelectorJSON: "{}", BillingMode: "fixed_request", UnitPriceMicrocredits: 2, PriceConfigured: true, Enabled: true},
			} {
				if err := fixture.fake.db.Create(row).Error; err != nil {
					t.Fatal(err)
				}
			}
			if err := fixture.fake.db.Model(&model.ChannelModel{}).Where("id = ?", "drama-video").Updates(map[string]any{"billing_mode": "fixed_request", "price_configured": true}).Error; err != nil {
				t.Fatal(err)
			}
			projectID, revision := fixture.summary.Project.ID, fixture.summary.Production.Revision
			before, _ := fixture.svc.repo.DramaProduction(projectID)
			var req UpdateDramaSettingsRequest
			raw, err := json.Marshal(map[string]any{"expectedRevision": revision, "generation": map[string]any{
				"models":      map[string]any{"image": drawing.Models.Image, "video": fakeDramaModels.Video, "characterImage": drawing.Models.Image, "propImage": drawing.Models.Image, "sceneImage": drawing.Models.Image, "text": map[string]string{"modelKey": "forbidden"}},
				"aspectRatio": "16:9", "videoResolution": "", "videoContinuity": DramaContinuityParallel, "referenceLimit": 1,
				"stylePrompt": "不能修改文字风格", "language": "不能修改语言", "mediaMode": DramaMediaAuto,
				"storyboard": map[string]any{"generationMode": "grid_image", "targetShotCount": 99},
			}})
			if err != nil || json.Unmarshal(raw, &req) != nil {
				t.Fatal("cannot decode generation settings")
			}
			saved, err := fixture.svc.UpdateDramaSettings("usr-drama", projectID, req)
			if err != nil {
				t.Fatal(err)
			}
			expected := applyDramaGenerationSettings(parseDramaSettings(before.SettingsJSON), req.Generation).normalized()
			if !reflect.DeepEqual(saved.Production.Settings, expected) || saved.Production.GuideStep != step || saved.Production.Status != before.Status || saved.Production.Revision != revision+1 {
				t.Fatalf("generation save changed unrelated state: %+v", saved.Production)
			}
			if len(fixture.fake.requests) != 0 {
				t.Fatal("saving generation settings submitted tasks")
			}
			_, err = fixture.svc.UpdateDramaSettings("usr-drama", projectID, req)
			requireGuideConflict(t, err)
		})
	}
}

func TestDramaGenerationSettingsAssetsMergeKeepsEpisodeEdits(t *testing.T) {
	svc, _ := newDramaTestService(t)
	draft := createGuidedDrama(t, svc, DramaChapterInput{Text: "少年走进院子。"}, DramaChapterInput{Text: "老师迎接少年。"})
	assets := confirmGuide(t, svc, draft)
	runDramaTicks(t, svc, draft.Project.ID, 8)
	assets = guideSummary(t, svc, draft.Project.ID)
	local, _ := svc.DramaEpisodeStyle("usr-drama", draft.Project.ID, assets.Episodes[0].ID)
	local.Settings.ReferenceLimit = 2
	local.Settings.Assets.ScenePrompt = "本集专用场景布局"
	local.Settings.StylePrompt = "本集自己的画风"
	edited, err := svc.UpdateDramaEpisodeStyle("usr-drama", draft.Project.ID, local.EpisodeID, UpdateDramaEpisodeStyleRequest{ExpectedRevision: &local.Revision, ExpectedEpisodeRevision: &local.EpisodeRevision, Settings: &local.Settings})
	if err != nil {
		t.Fatal(err)
	}
	changedAssets := assets.Production.Settings.Assets
	changedAssets.ScenePrompt = "全剧场景新配置"
	limit := 1
	continuity := DramaContinuityParallel
	saved, err := svc.UpdateDramaSettings("usr-drama", draft.Project.ID, UpdateDramaSettingsRequest{ExpectedRevision: &edited.Revision, Generation: &DramaGenerationSettings{Assets: &changedAssets, ReferenceLimit: &limit, VideoContinuity: &continuity}})
	if err != nil {
		t.Fatal(err)
	}
	if saved.Production.GuideStep != model.DramaGuideAssets {
		t.Fatal("automatic generation save advanced the guide")
	}
	current, _ := svc.DramaEpisodeStyle("usr-drama", draft.Project.ID, local.EpisodeID)
	other, _ := svc.DramaEpisodeStyle("usr-drama", draft.Project.ID, assets.Episodes[1].ID)
	p, _ := svc.repo.DramaProduction(draft.Project.ID)
	initial := parseDramaSettings(p.InitialSettingsJSON)
	if current.Settings.Assets.ScenePrompt != local.Settings.Assets.ScenePrompt || current.Settings.StylePrompt != local.Settings.StylePrompt || current.Settings.ReferenceLimit != 2 || current.Settings.VideoContinuity != continuity {
		t.Fatal("generation save overwrote independent episode edits or missed unchanged defaults")
	}
	if other.Settings.Assets.ScenePrompt != changedAssets.ScenePrompt || other.Settings.ReferenceLimit != limit || initial.Assets.ScenePrompt != changedAssets.ScenePrompt || initial.ReferenceLimit != limit {
		t.Fatal("generation save did not update untouched episode initial values")
	}
}

func TestDramaGenerationSettingsRequiresVersionAndRejectsMixedWrites(t *testing.T) {
	fixture := newDramaGuideRevisionFixture(t, model.DramaGuideAssets)
	projectID, revision := fixture.summary.Project.ID, fixture.summary.Production.Revision
	before, _ := fixture.svc.repo.DramaProduction(projectID)
	limit, budget := 1, int64(20)
	for _, req := range []UpdateDramaSettingsRequest{
		{Generation: &DramaGenerationSettings{ReferenceLimit: &limit}},
		{ExpectedRevision: &revision, Generation: &DramaGenerationSettings{ReferenceLimit: &limit}, Settings: &fixture.summary.Production.Settings},
		{ExpectedRevision: &revision, Generation: &DramaGenerationSettings{ReferenceLimit: &limit}, BudgetMicrocredits: &budget},
	} {
		if _, err := fixture.svc.UpdateDramaSettings("usr-drama", projectID, req); !isAppErrorStatus(err, 400) {
			t.Fatalf("invalid generation contract accepted: %v", err)
		}
	}
	if _, err := fixture.svc.UpdateDramaSettings("other-user", projectID, UpdateDramaSettingsRequest{ExpectedRevision: &revision, Generation: &DramaGenerationSettings{ReferenceLimit: &limit}}); err == nil {
		t.Fatal("foreign generation settings accepted")
	}
	after, _ := fixture.svc.repo.DramaProduction(projectID)
	if !reflect.DeepEqual(before, after) {
		t.Fatal("rejected generation settings changed production")
	}
}

func TestDramaGenerationSettingsChecksCapabilityBeforeSaving(t *testing.T) {
	for _, kind := range []string{"ratio", "continuity", "model", "image-override"} {
		t.Run(kind, func(t *testing.T) {
			fixture := newDramaGuideRevisionFixture(t, model.DramaGuideAssets)
			projectID, revision := fixture.summary.Project.ID, fixture.summary.Production.Revision
			before, _ := fixture.svc.repo.DramaProduction(projectID)
			invalid := "unsupported"
			patch := &DramaGenerationSettings{}
			switch kind {
			case "ratio":
				patch.AspectRatio = &invalid
			case "continuity":
				patch.VideoContinuity = &invalid
			case "model":
				patch.Models = &DramaGenerationModels{Video: &DramaModelChoice{ChannelID: "unknown", ModelKey: "video"}}
			case "image-override":
				patch.Models = &DramaGenerationModels{CharacterImage: &fakeDramaModels.Video}
			}
			if _, err := fixture.svc.UpdateDramaSettings("usr-drama", projectID, UpdateDramaSettingsRequest{ExpectedRevision: &revision, Generation: patch}); err == nil {
				t.Fatal("invalid generation capability accepted")
			}
			after, _ := fixture.svc.repo.DramaProduction(projectID)
			if !reflect.DeepEqual(before, after) {
				t.Fatal("invalid generation setting mutated production")
			}
		})
	}
}

func TestDramaGenerationSettingsBlocksQueuedAndRunningTasks(t *testing.T) {
	for _, kind := range []string{"job", "segment", "cast", "shot", "storyboard", "cast-view"} {
		for _, status := range []string{model.DramaMediaQueued, model.DramaMediaRunning} {
			t.Run(kind+"/"+status, func(t *testing.T) {
				fixture := newDramaGuideRevisionFixture(t, model.DramaGuideAssets)
				projectID, revision := fixture.summary.Project.ID, fixture.summary.Production.Revision
				before, _ := fixture.svc.repo.DramaProduction(projectID)
				var err error
				switch kind {
				case "job":
					err = fixture.fake.db.Create(&model.DramaJob{ID: "busy-job", ProjectID: projectID, Kind: model.DramaJobBible, Status: status}).Error
				case "segment":
					err = fixture.fake.db.Model(&model.DramaSegment{}).Where("id = ?", fixture.segment.ID).Update("video_status", status).Error
				case "cast":
					err = fixture.fake.db.Model(&model.DramaCast{}).Where("id = ?", fixture.cast.ID).Update("image_status", status).Error
				case "shot":
					err = fixture.fake.db.Create(&model.DramaShotMedia{ID: "busy-shot", ProjectID: projectID, Status: status}).Error
				case "storyboard":
					task := model.Task{ID: "busy-board-task", ProjectID: projectID, UserID: "usr-drama", Type: "canvas_image", Status: model.TaskStatus(status)}
					if err := fixture.fake.db.Create(&task).Error; err != nil {
						t.Fatal(err)
					}
					err = fixture.fake.db.Create(&model.DramaStoryboardBoard{ID: "busy-storyboard", ProjectID: projectID, TaskID: task.ID, Status: status}).Error
				case "cast-view":
					err = fixture.fake.db.Create(&model.DramaCastView{ID: "busy-view", ProjectID: projectID, CastID: fixture.cast.ID, Status: status}).Error
				}
				if err != nil {
					t.Fatal(err)
				}
				limit := 1
				_, err = fixture.svc.UpdateDramaSettings("usr-drama", projectID, UpdateDramaSettingsRequest{ExpectedRevision: &revision, Generation: &DramaGenerationSettings{ReferenceLimit: &limit}})
				requireGuideConflict(t, err)
				after, _ := fixture.svc.repo.DramaProduction(projectID)
				if !reflect.DeepEqual(before, after) {
					t.Fatal("busy generation save changed production")
				}
			})
		}
	}
}

func TestDramaGenerationSettingsRechecksRevisionInsideTransaction(t *testing.T) {
	fixture := newDramaGuideRevisionFixture(t, model.DramaGuideAssets)
	projectID, revision := fixture.summary.Project.ID, fixture.summary.Production.Revision
	remote := fixture.summary.Production.Settings
	remote.Language = "另一页面的修改"
	changed := false
	if err := fixture.fake.db.Callback().Query().After("gorm:query").Register("test:generation-settings-race", func(tx *gorm.DB) {
		if changed || tx.Statement.Table != "drama_productions" {
			return
		}
		changed = true
		if err := fixture.svc.repo.UpdateDramaProduction(projectID, map[string]any{"settings_json": encodeDramaSettings(remote)}); err != nil {
			t.Fatal(err)
		}
	}); err != nil {
		t.Fatal(err)
	}
	limit := 1
	_, err := fixture.svc.UpdateDramaSettings("usr-drama", projectID, UpdateDramaSettingsRequest{ExpectedRevision: &revision, Generation: &DramaGenerationSettings{ReferenceLimit: &limit}})
	requireGuideConflict(t, err)
	stored, _ := fixture.svc.repo.DramaProduction(projectID)
	if parseDramaSettings(stored.SettingsJSON).Language != remote.Language || stored.Revision != revision+1 {
		t.Fatal("generation autosave overwrote a concurrent settings change")
	}
}
