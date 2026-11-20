package app

import (
	_ "embed"
	"encoding/json"
	"slices"
	"strings"
)

//go:embed drama_style_catalog.json
var dramaStyleCatalogJSON []byte

type dramaStyleFamily struct {
	DefaultPresetID string   `json:"defaultPresetId"`
	PresetIDs       []string `json:"presetIds"`
}

var dramaStyleCatalog = func() map[string]dramaStyleFamily {
	var catalog map[string]dramaStyleFamily
	if err := json.Unmarshal(dramaStyleCatalogJSON, &catalog); err != nil {
		panic(err)
	}
	return catalog
}()

func dramaStyleFamilyForType(dramaType string) dramaStyleFamily {
	if dramaType == "live_action" {
		return dramaStyleCatalog["live_action"]
	}
	return dramaStyleCatalog["comic"]
}

func normalizeDramaStyleSelection(settings *DramaSettings) error {
	if settings.StyleSelection == nil {
		return nil
	}
	if strings.TrimSpace(settings.StyleName) == "" || strings.TrimSpace(settings.StylePrompt) == "" {
		return BadAuthRequest("请填写风格名称与风格说明")
	}
	selection := *settings.StyleSelection
	selection.PresetID = strings.TrimSpace(selection.PresetID)
	switch selection.Mode {
	case "preset":
		if !slices.Contains(dramaStyleFamilyForType(settings.DramaType).PresetIDs, selection.PresetID) {
			return BadAuthRequest("请选择与当前剧集类型匹配的风格")
		}
	case "custom":
		if selection.PresetID != "" {
			return BadAuthRequest("自定义风格不能指定预设 ID")
		}
	default:
		return BadAuthRequest("风格来源无效")
	}
	settings.StyleSelection = &selection
	return nil
}

// 旧客户端只发送风格文本。保留同一选择，或将改写后的文本作为自定义风格。
func preserveDramaStyleSelection(next *DramaSettings, previous DramaSettings) error {
	if next.StyleSelection == nil && previous.StyleSelection != nil {
		if strings.TrimSpace(next.StyleName) == strings.TrimSpace(previous.StyleName) &&
			strings.TrimSpace(next.StylePrompt) == strings.TrimSpace(previous.StylePrompt) {
			next.StyleSelection = previous.StyleSelection
		} else {
			next.StyleSelection = &DramaStyleSelection{Mode: "custom"}
		}
	}
	return normalizeDramaStyleSelection(next)
}

// 识别系统预设 ID 时校验剧集类型，自定义和已有资产的风格 ID 仍可读取。
func validateDramaCastPresetSelection(settings DramaSettings, current string, next *string) error {
	if settings.StyleSelection == nil || next == nil {
		return nil
	}
	id := strings.TrimSpace(*next)
	if id == "" || id == current || slices.Contains(dramaStyleFamilyForType(settings.DramaType).PresetIDs, id) {
		return nil
	}
	for _, family := range dramaStyleCatalog {
		if slices.Contains(family.PresetIDs, id) {
			return BadAuthRequest("请选择与当前剧集类型匹配的风格")
		}
	}
	return nil
}
