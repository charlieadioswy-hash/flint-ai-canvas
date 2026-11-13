package app

import (
	"encoding/json"
	"strings"
	"testing"

	"yingce/backend/internal/model"
)

func setDramaStudioAssetReferences(t *testing.T, fake *fakeDramaBackend, segmentID string, ids ...string) {
	t.Helper()
	body, err := json.Marshal(ids)
	if err != nil {
		t.Fatal(err)
	}
	if err := fake.db.Model(&model.DramaSegment{}).Where("id = ?", segmentID).Update("reference_cast_ids_json", string(body)).Error; err != nil {
		t.Fatal(err)
	}
}

func TestDramaStudioSegmentAssetsOnlyQueuesMissingReferences(t *testing.T) {
	svc, fake, projectID, detail := dramaStudioFixture(t)
	casts, err := svc.repo.DramaCasts(projectID)
	if err != nil || len(casts) < 4 {
		t.Fatalf("missing fixture assets: %+v %v", casts, err)
	}
	first, second, ready, unrelated := casts[0], casts[1], casts[2], casts[3]
	resourceID := fake.resource("usr-drama", "image", "image/png")
	if err := svc.repo.UpdateDramaCastFields(ready.ID, map[string]any{"image_status": model.DramaMediaReady, "image_resource_id": resourceID}); err != nil {
		t.Fatal(err)
	}
	setDramaStudioAssetReferences(t, fake, detail.Segments[1].ID, first.ID, second.ID, first.ID, ready.ID)
	// 后段没有上一段尾帧且提示词失败，也能先补参考资产，不能失效已有视频。
	if err := fake.db.Model(&model.DramaSegment{}).Where("id = ?", detail.Segments[1].ID).Updates(map[string]any{"prompt_status": model.DramaMediaFailed, "video_status": model.DramaMediaReady, "video_resource_id": "keep-existing-video"}).Error; err != nil {
		t.Fatal(err)
	}
	view, err := svc.PreflightDramaStudioAction("usr-drama", projectID, DramaStudioActionRequest{Action: "segment_assets", TargetID: detail.Segments[1].ID, EpisodeID: detail.Episode.ID})
	if err != nil || !view.Ready || len(view.MissingCasts) != 2 || view.EpisodeID != detail.Episode.ID {
		t.Fatalf("batch preflight = %+v %v", view, err)
	}
	if fake.byKind["image"] != 0 || fake.byKind["video"] != 0 {
		t.Fatal("preflight must not generate media")
	}
	result, err := svc.ExecuteDramaStudioAction("usr-drama", projectID, confirmedDramaStudioRequest(view))
	if err != nil || result["queued"] != 2 {
		t.Fatalf("batch execute = %+v %v", result, err)
	}
	if _, err := svc.ExecuteDramaStudioAction("usr-drama", projectID, confirmedDramaStudioRequest(view)); err == nil {
		t.Fatal("duplicate batch accepted")
	}
	for _, id := range []string{first.ID, second.ID} {
		cast, _ := svc.repo.DramaCast(projectID, id)
		if cast.ImageStatus != model.DramaMediaQueued {
			t.Fatalf("requested asset not queued: %+v", cast)
		}
	}
	savedReady, _ := svc.repo.DramaCast(projectID, ready.ID)
	savedUnrelated, _ := svc.repo.DramaCast(projectID, unrelated.ID)
	segment, _ := svc.repo.DramaSegment(projectID, detail.Segments[1].ID)
	if savedReady.ImageResourceID != resourceID || savedUnrelated.ImageStatus != unrelated.ImageStatus || segment.VideoStatus != model.DramaMediaReady || segment.VideoResourceID != "keep-existing-video" {
		t.Fatalf("batch changed unrelated media: ready=%+v other=%+v segment=%+v", savedReady, savedUnrelated, segment)
	}
	runDramaTicks(t, svc, projectID, 8)
	if fake.byKind["image"] != 2 || fake.byKind["video"] != 0 {
		t.Fatalf("batch expanded generation scope: %+v", fake.byKind)
	}
	p, _ := svc.repo.DramaProduction(projectID)
	episode, _ := svc.repo.DramaEpisode(projectID, detail.Episode.ID)
	if p.AssetsReleased || !p.MediaRequestsOnly || episode.MediaReleased {
		t.Fatalf("batch must not release project or episode: %+v %+v", p, episode)
	}
	view, err = svc.PreflightDramaStudioAction("usr-drama", projectID, DramaStudioActionRequest{Action: "segment_assets", TargetID: detail.Segments[1].ID})
	if err != nil || view.Ready || len(view.MissingCasts) != 0 || !strings.Contains(view.Reason, "齐全") {
		t.Fatalf("completed assets should not be regenerated: %+v %v", view, err)
	}
}

func TestDramaStudioSegmentAssetsCompletedProductionDrainsBatch(t *testing.T) {
	for _, withLook := range []bool{false, true} {
		name := "independent_assets"
		if withLook {
			name = "character_base_then_look"
		}
		t.Run(name, func(t *testing.T) {
			svc, fake, projectID, detail := dramaStudioFixture(t)
			unrelated, err := svc.repo.DramaCasts(projectID)
			if err != nil || len(unrelated) == 0 {
				t.Fatalf("missing fixture assets: %+v %v", unrelated, err)
			}
			requested := []model.DramaCast{
				{ID: "completed-batch-first", ProjectID: projectID, Kind: "character", Name: "甲", Appearance: "黑发青年", Position: 100},
				{ID: "completed-batch-second", ProjectID: projectID, Kind: "character", Name: "乙", Appearance: "白发老者", Position: 101},
				{ID: "completed-batch-third", ProjectID: projectID, Kind: "character", Name: "丙", Appearance: "短发少女", Position: 102},
			}
			references := []string{requested[0].ID, requested[1].ID, requested[2].ID}
			if withLook {
				requested = requested[:2]
				requested[0].ImageStatus = model.DramaMediaFailed
				requested[1].ParentID = requested[0].ID
				requested[1].Name, requested[1].LookName = requested[0].Name, "西装"
				requested[1].Appearance, requested[1].ImageStatus = "黑色西装", model.DramaMediaFailed
				references = []string{requested[1].ID}
			}
			if err := svc.repo.CreateDramaCasts(requested); err != nil {
				t.Fatal(err)
			}
			setDramaStudioAssetReferences(t, fake, detail.Segments[0].ID, references...)
			production, err := svc.repo.DramaProduction(projectID)
			if err != nil {
				t.Fatal(err)
			}
			settings := parseDramaSettings(production.SettingsJSON)
			settings.Concurrency = 1
			raw, err := json.Marshal(settings)
			if err != nil {
				t.Fatal(err)
			}
			if err := fake.db.Model(&model.DramaEpisode{}).Where("project_id = ?", projectID).Updates(map[string]any{"stage": model.DramaEpisodeDone, "final_stale": false}).Error; err != nil {
				t.Fatal(err)
			}
			if err := fake.db.Model(&model.DramaProduction{}).Where("project_id = ?", projectID).Updates(map[string]any{"status": model.DramaStatusCompleted, "stage": model.DramaStageDone, "plan_done": true, "settings_json": string(raw)}).Error; err != nil {
				t.Fatal(err)
			}
			view, err := svc.PreflightDramaStudioAction("usr-drama", projectID, DramaStudioActionRequest{Action: "segment_assets", TargetID: detail.Segments[0].ID, EpisodeID: detail.Episode.ID})
			if err != nil || !view.Ready || len(view.MissingCasts) != len(requested) {
				t.Fatalf("completed production batch preflight = %+v %v", view, err)
			}
			result, err := svc.ExecuteDramaStudioAction("usr-drama", projectID, confirmedDramaStudioRequest(view))
			if err != nil || result["queued"] != len(requested) {
				t.Fatalf("completed production batch execute = %+v %v", result, err)
			}
			runDramaTicks(t, svc, projectID, 1)
			production, err = svc.repo.DramaProduction(projectID)
			if err != nil || production.Status != model.DramaStatusRunning || fake.byKind["image"] != 1 {
				t.Fatalf("batch must keep scheduling after its first submission: production=%+v counts=%+v err=%v", production, fake.byKind, err)
			}
			runDramaTicks(t, svc, projectID, 12)
			for _, cast := range requested {
				saved, err := svc.repo.DramaCast(projectID, cast.ID)
				if err != nil || saved.ImageStatus != model.DramaMediaReady || saved.ImageResourceID == "" {
					t.Fatalf("batch asset did not finish: %+v %v", saved, err)
				}
			}
			if fake.byKind["image"] != len(requested) || fake.byKind["video"] != 0 || fake.byKind["render"] != 0 {
				t.Fatalf("batch must only generate its missing images once: %+v", fake.byKind)
			}
			for _, cast := range unrelated {
				saved, err := svc.repo.DramaCast(projectID, cast.ID)
				if err != nil || saved.ImageStatus != cast.ImageStatus || saved.ImageResourceID != cast.ImageResourceID {
					t.Fatalf("batch changed unrelated asset: before=%+v after=%+v err=%v", cast, saved, err)
				}
			}
			production, err = svc.repo.DramaProduction(projectID)
			if err != nil || production.Status != model.DramaStatusCompleted || production.Stage != model.DramaStageDone || production.AssetsReleased || !production.MediaRequestsOnly {
				t.Fatalf("production must finish after draining only requested assets: %+v %v", production, err)
			}
			episodes, err := svc.repo.DramaEpisodes(projectID)
			if err != nil {
				t.Fatal(err)
			}
			for _, episode := range episodes {
				if episode.Stage != model.DramaEpisodeDone || episode.MediaReleased {
					t.Fatalf("batch reopened finished episode: %+v", episode)
				}
			}
		})
	}
}

func TestDramaStudioSegmentAssetsInactiveAssetsDoNotBlockCompletion(t *testing.T) {
	svc, fake, projectID, _ := dramaStudioFixture(t)
	assets := []model.DramaCast{
		{ID: "inactive-failed", ImageStatus: model.DramaMediaFailed},
		{ID: "inactive-draft", ImageStatus: model.DramaMediaDraft},
		{ID: "inactive-unrequested"},
		{ID: "inactive-locked-queued", ImageStatus: model.DramaMediaQueued, Locked: true},
		{ID: "inactive-locked-running", ImageStatus: model.DramaMediaRunning, Locked: true},
	}
	for i := range assets {
		assets[i].ProjectID, assets[i].Kind = projectID, "character"
		assets[i].Name, assets[i].Appearance = assets[i].ID, "黑发青年"
	}
	if err := svc.repo.CreateDramaCasts(assets); err != nil {
		t.Fatal(err)
	}
	if err := fake.db.Model(&model.DramaEpisode{}).Where("project_id = ?", projectID).Updates(map[string]any{"stage": model.DramaEpisodeDone, "final_stale": false}).Error; err != nil {
		t.Fatal(err)
	}
	if err := fake.db.Model(&model.DramaProduction{}).Where("project_id = ?", projectID).Updates(map[string]any{"status": model.DramaStatusRunning, "stage": model.DramaStageDone, "plan_done": true}).Error; err != nil {
		t.Fatal(err)
	}
	runDramaTicks(t, svc, projectID, 1)
	production, err := svc.repo.DramaProduction(projectID)
	if err != nil || production.Status != model.DramaStatusCompleted || production.Stage != model.DramaStageDone {
		t.Fatalf("inactive assets must not prevent production completion: %+v %v", production, err)
	}
	if fake.byKind["image"] != 0 || fake.byKind["video"] != 0 || fake.byKind["render"] != 0 {
		t.Fatalf("inactive assets must not trigger media generation: %+v", fake.byKind)
	}
	for _, cast := range assets {
		saved, err := svc.repo.DramaCast(projectID, cast.ID)
		if err != nil || saved.ImageStatus != cast.ImageStatus {
			t.Fatalf("completion changed inactive asset: before=%+v after=%+v err=%v", cast, saved, err)
		}
	}
}

func TestDramaStudioSegmentAssetsSkipsQueuedAndActiveJobs(t *testing.T) {
	svc, fake, projectID, detail := dramaStudioFixture(t)
	casts, _ := svc.repo.DramaCasts(projectID)
	if err := svc.repo.UpdateDramaCastFields(casts[2].ID, map[string]any{"appearance": "白发老者"}); err != nil {
		t.Fatal(err)
	}
	setDramaStudioAssetReferences(t, fake, detail.Segments[0].ID, casts[0].ID, casts[1].ID, casts[2].ID)
	if err := svc.repo.UpdateDramaCastFields(casts[0].ID, map[string]any{"image_status": model.DramaMediaQueued}); err != nil {
		t.Fatal(err)
	}
	job := model.DramaJob{ID: "asset-already-requested", ProjectID: projectID, Kind: model.DramaJobCastImage, CastID: casts[1].ID, Status: model.DramaJobRunning}
	if err := svc.repo.CreateDramaJobs([]model.DramaJob{job}); err != nil {
		t.Fatal(err)
	}
	view, err := svc.PreflightDramaStudioAction("usr-drama", projectID, DramaStudioActionRequest{Action: "segment_assets", TargetID: detail.Segments[0].ID})
	if err != nil || !view.Ready || len(view.MissingCasts) != 1 || view.MissingCasts[0].ID != casts[2].ID || len(view.Warnings) != 1 {
		t.Fatalf("existing work must be skipped: %+v %v", view, err)
	}
	result, err := svc.ExecuteDramaStudioAction("usr-drama", projectID, confirmedDramaStudioRequest(view))
	if err != nil || result["queued"] != 1 {
		t.Fatalf("only unrequested asset should queue: %+v %v", result, err)
	}
	stillRunning, _ := svc.repo.DramaJob(projectID, job.ID)
	if stillRunning.Status != model.DramaJobRunning {
		t.Fatalf("existing asset job changed: %+v", stillRunning)
	}
}

func TestDramaStudioSegmentAssetsRejectsNameOnlyDependency(t *testing.T) {
	svc, fake, projectID, detail := dramaStudioFixture(t)
	casts, _ := svc.repo.DramaCasts(projectID)
	cast := casts[0]
	if err := svc.repo.UpdateDramaCastFields(cast.ID, map[string]any{"appearance": "", "description": "", "image_prompt": "", "image_status": model.DramaMediaDraft}); err != nil {
		t.Fatal(err)
	}
	setDramaStudioAssetReferences(t, fake, detail.Segments[0].ID, cast.ID)
	view, err := svc.PreflightDramaStudioAction("usr-drama", projectID, DramaStudioActionRequest{Action: "segment_assets", TargetID: detail.Segments[0].ID})
	if err != nil || view.Ready || !strings.Contains(view.Reason, "只有名称") {
		t.Fatalf("name-only dependency not blocked: %+v %v", view, err)
	}
	if _, err := svc.ExecuteDramaStudioAction("usr-drama", projectID, confirmedDramaStudioRequest(view)); err == nil {
		t.Fatal("name-only dependency queued")
	}
	if fake.byKind["image"] != 0 || fake.byKind["video"] != 0 {
		t.Fatal("preflight executed media")
	}
}

func TestDramaStudioSegmentAssetsIncludesMissingCharacterBase(t *testing.T) {
	for _, lookStatus := range []string{model.DramaMediaFailed, model.DramaMediaQueued} {
		t.Run(lookStatus, func(t *testing.T) {
			svc, fake, projectID, detail := dramaStudioFixture(t)
			casts, _ := svc.repo.DramaCasts(projectID)
			base := casts[0]
			if err := svc.repo.UpdateDramaCastFields(base.ID, map[string]any{"image_status": model.DramaMediaFailed}); err != nil {
				t.Fatal(err)
			}
			look := model.DramaCast{ID: "batch-character-look", ProjectID: projectID, ParentID: base.ID, Kind: "character", Name: base.Name, LookName: "西装", Appearance: "黑色西装", ImageStatus: lookStatus}
			if err := svc.repo.CreateDramaCasts([]model.DramaCast{look}); err != nil {
				t.Fatal(err)
			}
			setDramaStudioAssetReferences(t, fake, detail.Segments[0].ID, look.ID)
			view, err := svc.PreflightDramaStudioAction("usr-drama", projectID, DramaStudioActionRequest{Action: "segment_assets", TargetID: detail.Segments[0].ID})
			want := 2
			if lookStatus == model.DramaMediaQueued {
				want = 1
			}
			if err != nil || !view.Ready || len(view.MissingCasts) != want || view.MissingCasts[0].ID != base.ID {
				t.Fatalf("missing base should join batch before look: %+v %v", view, err)
			}
			if _, err := svc.ExecuteDramaStudioAction("usr-drama", projectID, confirmedDramaStudioRequest(view)); err != nil {
				t.Fatal(err)
			}
			runDramaTicks(t, svc, projectID, 12)
			baseResult, _ := svc.repo.DramaCast(projectID, base.ID)
			lookResult, _ := svc.repo.DramaCast(projectID, look.ID)
			if fake.byKind["image"] != 2 || fake.byKind["video"] != 0 || baseResult.ImageStatus != model.DramaMediaReady || lookResult.ImageStatus != model.DramaMediaReady {
				t.Fatalf("base and look must generate once in order: counts=%+v base=%+v look=%+v", fake.byKind, baseResult, lookResult)
			}
		})
	}
}

func TestDramaStudioSegmentAssetsRejectsStaleRangeAndInvalidTargets(t *testing.T) {
	svc, fake, projectID, detail := dramaStudioFixture(t)
	casts, _ := svc.repo.DramaCasts(projectID)
	setDramaStudioAssetReferences(t, fake, detail.Segments[0].ID, casts[0].ID, casts[1].ID)
	req := DramaStudioActionRequest{Action: "segment_assets", TargetID: detail.Segments[0].ID, EpisodeID: detail.Episode.ID}
	if _, err := svc.PreflightDramaStudioAction("foreign-user", projectID, req); err == nil {
		t.Fatal("foreign user accepted")
	}
	wrong := req
	wrong.EpisodeID = "other-episode"
	if _, err := svc.PreflightDramaStudioAction("usr-drama", projectID, wrong); err == nil {
		t.Fatal("foreign episode accepted")
	}
	view, err := svc.PreflightDramaStudioAction("usr-drama", projectID, req)
	if err != nil || !view.Ready {
		t.Fatalf("preflight = %+v %v", view, err)
	}
	if err := svc.repo.UpdateDramaCastFields(casts[1].ID, map[string]any{"appearance": "修改后的外观"}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ExecuteDramaStudioAction("usr-drama", projectID, confirmedDramaStudioRequest(view)); err == nil {
		t.Fatal("changed asset inputs accepted old confirmation")
	}
	for _, id := range []string{casts[0].ID, casts[1].ID} {
		cast, _ := svc.repo.DramaCast(projectID, id)
		if cast.ImageStatus == model.DramaMediaQueued {
			t.Fatalf("stale batch partially queued: %+v", cast)
		}
	}
	view, err = svc.PreflightDramaStudioAction("usr-drama", projectID, req)
	if err != nil {
		t.Fatal(err)
	}
	setDramaStudioAssetReferences(t, fake, detail.Segments[0].ID, casts[0].ID)
	if _, err := svc.ExecuteDramaStudioAction("usr-drama", projectID, confirmedDramaStudioRequest(view)); err == nil {
		t.Fatal("changed reference range accepted old confirmation")
	}
	if fake.byKind["image"] != 0 || fake.byKind["video"] != 0 {
		t.Fatal("rejected batch generated media")
	}
}

func TestDramaStudioSegmentAssetsQuotesTotalAndChecksBudget(t *testing.T) {
	svc, fake, projectID, detail := dramaStudioFixture(t)
	casts, _ := svc.repo.DramaCasts(projectID)
	var character, prop model.DramaCast
	for _, cast := range casts {
		if cast.Kind == "character" && character.ID == "" {
			character = cast
		}
		if cast.Kind == "prop" && prop.ID == "" {
			prop = cast
		}
	}
	if character.ID == "" || prop.ID == "" {
		t.Fatal("fixture must include both character and prop assets")
	}
	setDramaStudioAssetReferences(t, fake, detail.Segments[0].ID, character.ID, prop.ID)
	p, _ := svc.repo.DramaProduction(projectID)
	settings := parseDramaSettings(p.SettingsJSON)
	settings.Models.PropImage = DramaModelChoice{ChannelID: "ch", ModelKey: "prop-image"}
	settings.Assets.Resolution, settings.Assets.PropResolution = "1k", "2k"
	settingsRaw, _ := json.Marshal(settings)
	if err := fake.db.Model(&model.DramaProduction{}).Where("project_id = ?", projectID).Update("settings_json", string(settingsRaw)).Error; err != nil {
		t.Fatal(err)
	}
	profile := DefaultModelCapabilityConfigForModel(string(model.ChannelInterfaceGeminiImage), "image")
	profile.Image.Resolution = ImageResolutionConfig{Supported: true, Values: []string{"1k", "2k"}, Default: "1k"}
	raw, err := json.Marshal(profile)
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range []any{
		&model.ModelChannel{ID: "ch", Scope: model.ChannelScopeSystem, Enabled: true, APIFormat: "legacy"},
		&model.ChannelModel{ID: "batch-image-model", ChannelID: "ch", ModelKey: "image", Capability: "image", Protocol: model.ChannelInterfaceGeminiImage, Enabled: true, CapabilityConfigJSON: string(raw)},
		&model.ChannelModel{ID: "batch-prop-model", ChannelID: "ch", ModelKey: "prop-image", Capability: "image", Protocol: model.ChannelInterfaceGeminiImage, Enabled: true, CapabilityConfigJSON: string(raw)},
		&model.ChannelModelPriceTier{ID: "batch-image-tier", ChannelModelID: "batch-image-model", SelectorKey: `{"imageResolution":"1k"}`, SelectorJSON: `{"imageResolution":"1k"}`, BillingMode: "fixed_request", UnitPriceMicrocredits: 100, PriceConfigured: true, Enabled: true},
		&model.ChannelModelPriceTier{ID: "batch-prop-tier", ChannelModelID: "batch-prop-model", SelectorKey: `{"imageResolution":"2k"}`, SelectorJSON: `{"imageResolution":"2k"}`, BillingMode: "fixed_request", UnitPriceMicrocredits: 200, PriceConfigured: true, Enabled: true},
		&model.CreditAccount{UserID: "usr-drama", AvailableMicrocredits: 1000},
	} {
		if err := fake.db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	req := DramaStudioActionRequest{Action: "segment_assets", TargetID: detail.Segments[0].ID}
	view, err := svc.PreflightDramaStudioAction("usr-drama", projectID, req)
	if err != nil || !view.Ready || !view.Priced || view.AmountMicrocredits != 300 {
		t.Fatalf("batch should quote character 1k and prop 2k using their own models: %+v %v", view, err)
	}
	if err := fake.db.Model(&model.ChannelModelPriceTier{}).Where("id = ?", "batch-prop-tier").Update("unit_price_microcredits", 250).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ExecuteDramaStudioAction("usr-drama", projectID, confirmedDramaStudioRequest(view)); err == nil {
		t.Fatal("changed image quote accepted old batch confirmation")
	}
	if err := fake.db.Model(&model.DramaProduction{}).Where("project_id = ?", projectID).Update("budget_microcredits", 325).Error; err != nil {
		t.Fatal(err)
	}
	view, err = svc.PreflightDramaStudioAction("usr-drama", projectID, req)
	if err != nil || view.Ready || view.AmountMicrocredits != 350 || !strings.Contains(view.Reason, "预算") {
		t.Fatalf("total must fit the remaining project budget: %+v %v", view, err)
	}
	if err := fake.db.Model(&model.DramaProduction{}).Where("project_id = ?", projectID).Update("budget_microcredits", 0).Error; err != nil {
		t.Fatal(err)
	}
	if err := fake.db.Model(&model.CreditAccount{}).Where("user_id = ?", "usr-drama").Update("available_microcredits", 300).Error; err != nil {
		t.Fatal(err)
	}
	view, err = svc.PreflightDramaStudioAction("usr-drama", projectID, req)
	if err != nil || view.Ready || !strings.Contains(view.Reason, "积分不足") {
		t.Fatalf("total must fit the credit balance: %+v %v", view, err)
	}
	if fake.byKind["image"] != 0 || fake.byKind["video"] != 0 {
		t.Fatal("batch quotes must not generate media")
	}
}

func TestDramaStudioSegmentAssetsLockedAssetBlocksWholeBatch(t *testing.T) {
	svc, fake, projectID, detail := dramaStudioFixture(t)
	casts, _ := svc.repo.DramaCasts(projectID)
	setDramaStudioAssetReferences(t, fake, detail.Segments[0].ID, casts[0].ID, casts[1].ID)
	req := DramaStudioActionRequest{Action: "segment_assets", TargetID: detail.Segments[0].ID}
	view, err := svc.PreflightDramaStudioAction("usr-drama", projectID, req)
	if err != nil || !view.Ready {
		t.Fatalf("initial preflight = %+v %v", view, err)
	}
	if err := svc.repo.UpdateDramaCastFields(casts[1].ID, map[string]any{"locked": true}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ExecuteDramaStudioAction("usr-drama", projectID, confirmedDramaStudioRequest(view)); err == nil {
		t.Fatal("asset locked after preflight accepted stale confirmation")
	}
	view, err = svc.PreflightDramaStudioAction("usr-drama", projectID, req)
	if err != nil || view.Ready || !strings.Contains(view.Reason, "已锁定") {
		t.Fatalf("locked item must block entire batch: %+v %v", view, err)
	}
	if _, err := svc.ExecuteDramaStudioAction("usr-drama", projectID, confirmedDramaStudioRequest(view)); err == nil {
		t.Fatal("blocked batch executed")
	}
	for _, id := range []string{casts[0].ID, casts[1].ID} {
		cast, _ := svc.repo.DramaCast(projectID, id)
		if cast.ImageStatus == model.DramaMediaQueued {
			t.Fatalf("batch partially queued an unlocked item: %+v", cast)
		}
	}
}
