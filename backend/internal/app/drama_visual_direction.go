package app

import (
	"strings"
	"unicode/utf8"

	"yingce/backend/internal/production"
)

const (
	dramaVisualDirectionStart = "【剧集画风】"
	dramaVisualDirectionEnd   = "【剧集画风结束】"
	dramaVisualMediumRule     = "画风描述与剧集类型冲突时，表现形式以剧集类型为准。"
	dramaVisualDirectionRule  = "素材和镜头以此处的表现形式与画风为准。人物身份、场景和动作依据剧本及当前素材。"
)

func dramaVisualDirection(settings DramaSettings, overrideName, overridePrompt string) string {
	if settings.StyleSelection == nil || (settings.DramaType == "" && settings.StyleSelection.Mode == "custom") {
		return ""
	}
	var family string
	switch settings.DramaType {
	case "", "comic", "narration":
		family = "漫剧。采用动画或插画造型，保持人物和场景的表现形式一致。"
	case "live_action":
		family = "真人剧。采用真人影视质感，保持真实的人物比例、材质和光照。"
	default:
		return ""
	}
	name, prompt := overrideName, overridePrompt
	if name == "" && prompt == "" {
		name, prompt = settings.StyleName, settings.StylePrompt
	}
	prompt = production.StripFrameDirectives(prompt)
	name = strings.Join(strings.Fields(firstNonEmpty(name, "遵循当前作品设定")), " ")
	return dramaVisualDirectionStart + "\n剧集类型：" + family + "\n" + dramaVisualMediumRule + "\n视觉风格：" + name +
		"\n" + prompt + "\n" + dramaVisualDirectionRule + "\n" + dramaVisualDirectionEnd
}

// Keep room for the actual shot or segment when a video provider limits prompt length.
func dramaVideoVisualDirection(direction string, maxChars, reservedChars int) string {
	if direction == "" || maxChars <= 0 {
		return direction
	}
	available := min(maxChars/4, maxChars-reservedChars)
	if available <= 0 {
		return ""
	}
	if utf8.RuneCountInString(direction) <= available {
		return direction
	}
	lines := strings.SplitN(direction, "\n", 5)
	family, _, _ := strings.Cut(lines[1], "。")
	summary := strings.Join([]string{lines[0], family, lines[2], lines[3]}, "\n")
	end := "\n" + dramaVisualDirectionEnd
	remaining := available - utf8.RuneCountInString(summary+end)
	if remaining < 0 {
		// Keep the medium first when an authored prompt leaves very little room.
		compact := lines[0] + strings.TrimPrefix(family, "剧集类型：")
		space := available - utf8.RuneCountInString(compact+dramaVisualDirectionEnd)
		if space < 0 {
			return ""
		}
		if name := []rune(strings.TrimPrefix(lines[3], "视觉风格：")); space > 1 {
			compact += "｜" + strings.TrimSpace(string(name[:min(space-1, len(name))]))
		}
		return compact + dramaVisualDirectionEnd
	}
	if remaining > 1 {
		details := strings.TrimSuffix(lines[4], "\n"+dramaVisualDirectionRule+"\n"+dramaVisualDirectionEnd)
		runes := []rune(details)
		if len(runes) > remaining-1 {
			details = strings.TrimSpace(string(runes[:remaining-2])) + "…"
		}
		summary += "\n" + details
	}
	return summary + end
}

// Replace a previous generated block when a compiled prompt was saved as a draft.
func stripDramaVisualDirection(prompt string) string {
	for {
		before, rest, found := strings.Cut(prompt, dramaVisualDirectionStart)
		if !found {
			return strings.TrimSpace(prompt)
		}
		_, after, closed := strings.Cut(rest, dramaVisualDirectionEnd)
		if !closed {
			return strings.TrimSpace(prompt)
		}
		prompt = before + after
	}
}

func withDramaVisualDirection(prompt, direction string) string {
	if direction == "" {
		return prompt
	}
	body := stripDramaVisualDirection(prompt)
	if body == "" {
		return direction
	}
	return direction + "\n\n" + body
}

func dramaPromptSettings(settings DramaSettings) production.Settings {
	result := settings.Settings
	result.VisualDirection = dramaVisualDirection(settings, "", "")
	return result
}

func dramaStyleHash(settings DramaSettings) string {
	if direction := dramaVisualDirection(settings, "", ""); direction != "" {
		return dramaShotMediaDigest(direction)
	}
	return ""
}

func currentDramaVisualRules(settings DramaSettings, meta dramaBibleMeta) string {
	if hash := dramaStyleHash(settings); hash != "" && hash != meta.StyleHash {
		return ""
	}
	return meta.VisualRules
}
