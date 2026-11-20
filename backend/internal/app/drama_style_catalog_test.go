package app

import (
	"slices"
	"testing"
)

func TestDramaStyleCatalogAndLegacySelections(t *testing.T) {
	for _, kind := range []string{"comic", "live_action"} {
		family := dramaStyleFamilyForType(kind)
		if !slices.Contains(family.PresetIDs, family.DefaultPresetID) {
			t.Fatalf("missing default preset for %s: %+v", kind, family)
		}
	}
	comic := DramaSettings{DramaType: "comic"}
	comic.StyleName, comic.StylePrompt = "国漫都市", "清晰线稿"
	comic.StyleSelection = &DramaStyleSelection{Mode: "preset", PresetID: "2d-manhua"}
	legacy := comic
	legacy.StyleSelection = nil
	if err := preserveDramaStyleSelection(&legacy, comic); err != nil || legacy.StyleSelection == nil || legacy.StyleSelection.PresetID != "2d-manhua" {
		t.Fatalf("older clients must retain the existing preset: %+v %v", legacy.StyleSelection, err)
	}
	legacy.StyleSelection = nil
	legacy.StylePrompt = "暖色插画"
	if err := preserveDramaStyleSelection(&legacy, comic); err != nil || legacy.StyleSelection == nil || legacy.StyleSelection.Mode != "custom" {
		t.Fatalf("older clients can still save custom styles: %+v %v", legacy.StyleSelection, err)
	}
	legacy.StyleSelection = nil
	if err := preserveDramaStyleSelection(&legacy, legacy); err != nil || legacy.StyleSelection != nil {
		t.Fatalf("legacy works retain the saved style behavior: %+v %v", legacy.StyleSelection, err)
	}
	live := comic
	live.DramaType = "live_action"
	if err := normalizeDramaStyleSelection(&live); err == nil {
		t.Fatal("a newly selected comic preset is invalid for live action")
	}
	liveID, customID, unclassifiedID := "live-campus", "my-style-1", "art-noir"
	if validateDramaCastPresetSelection(comic, "", &liveID) == nil || validateDramaCastPresetSelection(comic, "", &unclassifiedID) == nil {
		t.Fatal("new incompatible and unclassified asset presets must be rejected")
	}
	if validateDramaCastPresetSelection(comic, liveID, &liveID) != nil || validateDramaCastPresetSelection(comic, "", &customID) != nil {
		t.Fatal("existing asset styles and custom styles must be accepted")
	}
}
