package app

import (
	"encoding/json"
	"testing"

	"yingce/backend/internal/model"
)

func TestDramaWorkflowCastImpactIncludesManualLookReferencesAndRealContinuity(t *testing.T) {
	for _, parallel := range []bool{false, true} {
		name := "tail-frame"
		if parallel {
			name = "parallel"
		}
		t.Run(name, func(t *testing.T) {
			svc, fake, projectID, detail := dramaStudioFixture(t)
			p, _ := svc.repo.DramaProduction(projectID)
			settings := parseDramaSettings(p.SettingsJSON)
			if parallel {
				settings.VideoContinuity = DramaContinuityParallel
			}
			if err := fake.db.Model(&model.DramaEpisode{}).Where("id = ?", detail.Episode.ID).Update("settings_json", encodeDramaSettings(settings)).Error; err != nil {
				t.Fatal(err)
			}
			if err := fake.db.Model(&model.DramaShot{}).Where("project_id = ?", projectID).Updates(map[string]any{"cast_ids_json": "[]", "prop_ids_json": "[]", "look_cast_ids_json": "[]", "scene_cast_id": ""}).Error; err != nil {
				t.Fatal(err)
			}
			base := model.DramaCast{ID: "workflow-impact-base", ProjectID: projectID, Kind: "character", Name: "人工角色", Appearance: "黑发青年"}
			look := model.DramaCast{ID: "workflow-impact-look", ProjectID: projectID, Kind: "character", ParentID: base.ID, Name: base.Name, LookName: "便装", Appearance: "白色便装"}
			if err := svc.repo.CreateDramaCasts([]model.DramaCast{base, look}); err != nil {
				t.Fatal(err)
			}
			setDramaStudioAssetReferences(t, fake, detail.Segments[0].ID, look.ID)
			if err := fake.db.Model(&model.DramaSegment{}).Where("id = ?", detail.Segments[0].ID).Updates(map[string]any{"video_status": model.DramaMediaReady, "video_resource_id": "existing-impact-video"}).Error; err != nil {
				t.Fatal(err)
			}
			tail := model.DramaSegment{ID: "workflow-impact-tail", ProjectID: projectID, EpisodeID: detail.Episode.ID, SegmentIndex: 10, Revision: 5, PromptStatus: model.DramaMediaReady, VideoPrompt: "尾段提示词", VideoStatus: model.DramaMediaReady, VideoResourceID: "existing-tail-video"}
			if err := fake.db.Create(&tail).Error; err != nil {
				t.Fatal(err)
			}
			episodes, _ := svc.repo.DramaEpisodes(projectID)
			otherSegments, _ := svc.repo.DramaSegments(episodes[1].ID)
			audioIDs, _ := json.Marshal([]string{base.ID})
			if err := fake.db.Model(&model.DramaSegment{}).Where("id = ?", otherSegments[0].ID).Update("audio_cast_ids_json", string(audioIDs)).Error; err != nil {
				t.Fatal(err)
			}
			p, _ = svc.repo.DramaProduction(projectID)
			impact, err := svc.DramaCastImpact("usr-drama", projectID, base.ID)
			wantTail := len(detail.Segments)
			if parallel {
				wantTail = 0
			}
			if err != nil || impact.CastID != base.ID || impact.Revision != p.Revision || impact.Segments != 2 || impact.Episodes != 2 || len(impact.DirectSegments) != 2 || len(impact.ContinuitySegments) != wantTail || len(impact.AssetIDs) != 2 {
				t.Fatalf("real manual/look/continuity impact: %+v %v", impact, err)
			}
			if impact.DirectSegments[0].ID != detail.Segments[0].ID || impact.DirectSegments[0].EpisodeNumber != detail.Episode.Number || impact.DirectSegments[1].ID != otherSegments[0].ID {
				t.Fatalf("impact must identify exact episode/segment: %+v", impact)
			}
			// 音色直接引用的另一集没有旧视频，不应把其后段误报为尾帧失效范围。
			for _, affected := range impact.ContinuitySegments {
				if affected.EpisodeID != detail.Episode.ID {
					t.Fatalf("unrendered direct segment cannot invalidate later media: %+v", affected)
				}
			}
			saved, _ := svc.repo.DramaSegment(projectID, tail.ID)
			if saved.Revision != tail.Revision || saved.VideoStatus != tail.VideoStatus || fake.byKind["video"] != 0 || fake.byKind["image"] != 0 {
				t.Fatal("impact query changed media or queued work")
			}
			if _, err := svc.DramaCastImpact("usr-drama", projectID, "not-a-real-cast"); err == nil {
				t.Fatal("missing cast must not return an empty successful impact")
			}
			if _, err := svc.DramaCastImpact("other-user", projectID, base.ID); err == nil {
				t.Fatal("foreign project impact accepted")
			}
		})
	}
}

func TestDramaWorkflowStyleImpactRespectsIndependentImagePrompts(t *testing.T) {
	svc, fake, projectID, _ := dramaStudioFixture(t)
	casts, _ := svc.repo.DramaCasts(projectID)
	if err := svc.repo.UpdateDramaCastFields(casts[0].ID, map[string]any{"image_prompt": "这是一份完整自定义图片提示词"}); err != nil {
		t.Fatal(err)
	}
	if err := svc.repo.UpdateDramaCastFields(casts[1].ID, map[string]any{"image_style_name": "独立油画", "image_style_prompt": "独立油画风格"}); err != nil {
		t.Fatal(err)
	}
	view, err := svc.DramaSettingsImpact("usr-drama", projectID)
	if err != nil || view.Kind != "style" || len(view.AssetIDs) != len(casts)-2 || view.AffectedSegments != len(view.DirectSegments) || len(view.DirectSegments) == 0 || len(view.ContinuitySegments) != 0 {
		t.Fatalf("style scope must preserve independent overrides: %+v %v", view, err)
	}
	for _, id := range view.AssetIDs {
		if id == casts[0].ID || id == casts[1].ID {
			t.Fatalf("independent asset incorrectly included in global style scope: %+v", view)
		}
	}
	if fake.byKind["image"] != 0 || fake.byKind["video"] != 0 {
		t.Fatal("style impact generated media")
	}
}

func TestDramaWorkflowStyleRejectsMissingFieldsAndForeignOwner(t *testing.T) {
	svc, _, projectID, _ := dramaStudioFixture(t)
	p, _ := svc.repo.DramaProduction(projectID)
	for _, req := range []UpdateDramaWorkflowStyleRequest{
		{StyleName: "水彩", StylePrompt: "水彩画风"},
		{ExpectedRevision: &p.Revision, StyleName: "", StylePrompt: "水彩画风"},
		{ExpectedRevision: &p.Revision, StyleName: "水彩", StylePrompt: ""},
	} {
		if _, err := svc.UpdateDramaWorkflowStyle("usr-drama", projectID, req); err == nil {
			t.Fatalf("accepted invalid style fields: %+v", req)
		}
	}
	if _, err := svc.UpdateDramaWorkflowStyle("foreign", projectID, UpdateDramaWorkflowStyleRequest{ExpectedRevision: &p.Revision, StyleName: "水彩", StylePrompt: "水彩画风"}); err == nil {
		t.Fatal("foreign owner changed style")
	}
	if _, err := svc.DramaWorkflowReadiness("foreign", projectID); err == nil {
		t.Fatal("foreign owner read readiness")
	}
}
