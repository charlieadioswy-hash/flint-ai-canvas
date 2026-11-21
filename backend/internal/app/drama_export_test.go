package app

import (
	"encoding/json"
	"strings"
	"testing"

	"yingce/backend/internal/model"
)

func TestDramaAssetPackageUsesAdoptedCastTakePrompt(t *testing.T) {
	svc, db := jianyingExportFixture(t)
	if err := db.AutoMigrate(&model.DramaTake{}); err != nil {
		t.Fatal(err)
	}
	cast := model.DramaCast{ID: "hero", ProjectID: "project", ImageResourceID: "shared-image", ImageTakeID: "take-v1"}
	for _, take := range []model.DramaTake{
		{ID: "take-v1", ProjectID: cast.ProjectID, OwnerID: cast.ID, Kind: "cast", Version: 1, ResourceID: cast.ImageResourceID, Prompt: "早晨的自然光"},
		{ID: "take-v3", ProjectID: cast.ProjectID, OwnerID: cast.ID, Kind: "cast", Version: 3, ResourceID: cast.ImageResourceID, Prompt: dramaTakeUploadPrompt},
	} {
		if err := db.Create(&take).Error; err != nil {
			t.Fatal(err)
		}
	}
	if got := svc.dramaCastImagePrompt(cast.ProjectID, cast); got != "早晨的自然光" {
		t.Fatalf("adopted take prompt = %q", got)
	}
}

func TestDramaAssetPackageExportsPortableSegmentPrompts(t *testing.T) {
	svc, db := jianyingExportFixture(t)
	if err := db.AutoMigrate(&model.DramaCast{}, &model.DramaTake{}, &model.DramaShotMedia{}); err != nil {
		t.Fatal(err)
	}
	for _, cast := range []model.DramaCast{
		{ID: "actor-in-source", ProjectID: "project", Kind: "character", Name: "秦子武"},
		{ID: "look-in-source", ProjectID: "project", Kind: "character", Name: "秦子武（雨衣）", ParentID: "actor-in-source", LookName: "雨衣"},
	} {
		if err := db.Create(&cast).Error; err != nil {
			t.Fatal(err)
		}
	}
	generated := "秦子武（@[segment-cast:actor-in-source]）走进房间。"
	override := "@[segment-cast:look-in-source]跑过参考图2。"
	snapshot, err := json.Marshal(dramaSegmentReferenceLabels{
		dramaShotMediaDigest(override): {{Identity: "resource:source-stairwell", Label: "参考图2", Name: "楼梯间"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	for id, fields := range map[string]map[string]any{
		"s0": {"video_prompt": generated},
		"s1": {"video_prompt": "已被覆盖的草稿", "video_prompt_override": override, "reference_labels_json": string(snapshot)},
	} {
		if err := db.Model(&model.DramaSegment{}).Where("id = ?", id).Updates(fields).Error; err != nil {
			t.Fatal(err)
		}
	}
	archive, err := svc.PrepareDramaAssetPackage("owner", "project", DramaAssetPackageRequest{EpisodeIDs: []string{"episode"}, Prompts: true})
	if err != nil {
		t.Fatal(err)
	}
	var manifest dramaAssetManifest
	if err := json.Unmarshal(archive.entries[0].data, &manifest); err != nil {
		t.Fatal(err)
	}
	segments := manifest.Episodes[0].Segments
	if got := segments[0]; got.VideoPrompt != "秦子武走进房间。" || got.CustomPrompt {
		t.Fatalf("generated manifest prompt = %+v", got)
	}
	if got := segments[1]; got.VideoPrompt != "秦子武·雨衣跑过楼梯间。" || !got.CustomPrompt {
		t.Fatalf("override manifest prompt = %+v", got)
	}
	var notes string
	for _, entry := range archive.entries {
		if strings.HasSuffix(entry.path, "/提示词.md") {
			notes = string(entry.data)
		}
	}
	if !strings.Contains(notes, segments[0].VideoPrompt) || !strings.Contains(notes, segments[1].VideoPrompt) || strings.Contains(notes, "segment-cast:") || strings.Contains(notes, "已被覆盖的草稿") {
		t.Fatalf("prompt markdown = %q", notes)
	}
}
