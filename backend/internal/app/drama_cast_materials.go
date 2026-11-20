package app

import (
	"fmt"
	"strings"
	"unicode/utf8"

	"yingce/backend/internal/model"
	"yingce/backend/internal/production"
)

func validDramaCastKind(kind string) bool {
	return kind == "character" || kind == "scene" || kind == "prop"
}

func validateDramaCastText(value, label string, limit int, required bool) error {
	if required && strings.TrimSpace(value) == "" {
		return BadAuthRequest("请填写" + label)
	}
	if utf8.RuneCountInString(value) > limit {
		return BadAuthRequest(fmt.Sprintf("%s最多 %d 字", label, limit))
	}
	return nil
}

// 同一组可清空字段供基础设定、造型和无副作用的预览使用。
func applyDramaCastImageFields(cast *model.DramaCast, prompt, styleID, styleName, stylePrompt *string) (map[string]any, error) {
	fields := map[string]any{}
	for _, field := range []struct {
		column, label string
		value         *string
		target        *string
		limit         int
	}{
		{"image_prompt", "图片提示词", prompt, &cast.ImagePrompt, 12000},
		{"image_style_id", "画风 ID", styleID, &cast.ImageStyleID, 64},
		{"image_style_name", "画风名称", styleName, &cast.ImageStyleName, 120},
		{"image_style_prompt", "画风提示词", stylePrompt, &cast.ImageStylePrompt, 4000},
	} {
		if field.value == nil {
			continue
		}
		value := strings.TrimSpace(*field.value)
		if field.column == "image_prompt" && utf8.RuneCountInString(value) > field.limit {
			// A rebuilt prompt may include the project style. It is reattached at generation time.
			value = stripDramaVisualDirection(value)
		}
		if err := validateDramaCastText(value, field.label, field.limit, false); err != nil {
			return nil, err
		}
		*field.target = value
		fields[field.column] = value
	}
	return fields, nil
}

func dramaCastHasImageStyle(cast model.DramaCast) bool {
	return strings.TrimSpace(cast.ImageStyleID) != "" || strings.TrimSpace(cast.ImageStyleName) != "" || strings.TrimSpace(cast.ImageStylePrompt) != ""
}

func dramaCastHasImageDefinition(cast model.DramaCast) bool {
	return strings.TrimSpace(cast.Appearance) != "" || strings.TrimSpace(cast.Description) != "" || strings.TrimSpace(cast.ImagePrompt) != "" || dramaCharacterStructuredText(cast, true) != ""
}

// 预览和实际提交使用同一份画风与素材正文。
func buildDramaCastImagePrompt(settings DramaSettings, meta dramaBibleMeta, cast model.DramaCast) string {
	assets := settings.Assets.Normalized()
	imageOptions, _ := parseDramaCastImageOptions(cast.ImageOptionsJSON)
	if cast.Kind == "character" && imageOptions.Ratio != "" {
		assets.CharacterRatio = imageOptions.Ratio
	}
	style, rules := settings.StylePrompt, currentDramaVisualRules(settings, meta)
	independentStyle := dramaCastHasImageStyle(cast)
	direction := dramaVisualDirection(settings, "", "")
	if independentStyle {
		style, rules = firstNonEmpty(cast.ImageStylePrompt, cast.ImageStyleName, "写实电影感"), ""
		direction = dramaVisualDirection(settings, cast.ImageStyleName, style)
	}
	style, rules = production.StripFrameDirectives(style), production.StripFrameDirectives(rules)
	if direction != "" {
		style = "以剧集画风为准"
	}
	prompt := strings.TrimSpace(cast.ImagePrompt)
	if prompt == "" {
		appearance := firstNonEmpty(cast.Appearance, cast.Description, cast.Role)
		if structured := dramaCharacterStructuredText(cast, true); structured != "" {
			appearance += "\n已保存的人物补充设定（与旧描述冲突时以此处为准）：\n" + structured
		}
		prompt = production.CastImagePrompt(assets, cast.Kind, cast.Name, appearance, style, rules)
	} else if direction == "" && independentStyle && style != "" && !strings.Contains(prompt, style) {
		prompt = "本素材画风以以下设定为准，覆盖正文中的旧画风要求：" + style + "。\n" + prompt
	}
	if cast.ParentID != "" {
		identity := "参考图1仅用于识别同一角色的身份与五官特征，不照搬其年龄、体态、服装或背景。按本次造型描述表现年龄与身体比例，允许幼年、成年等年龄变化；服装、发型、妆容和背景以本次造型为准。输出仍须遵循下述作品角色参考图方案的视图与排版。"
		if !strings.Contains(prompt, identity) {
			prompt = identity + "\n" + prompt
		}
	}
	if references := dramaCastReferenceInstructions(cast); references != "" {
		prompt += "\n" + references
	}
	if cast.Kind == "character" || cast.Kind == "scene" {
		prompt = production.WithAssetImageOutputContract(prompt)
	}
	ratio := production.AssetImageRatio
	if cast.Kind == "character" {
		ratio = assets.CharacterRatio
	}
	if imageOptions.Ratio != "" {
		ratio = imageOptions.Ratio
	}
	ratioHint := production.WithAssetRatio("", ratio)
	if !strings.HasSuffix(prompt, ratioHint) {
		prompt = production.WithAssetRatio(prompt, ratio)
	}
	return withDramaVisualDirection(prompt, direction)
}

func (s *Service) PreviewDramaCastImagePrompt(userID, projectID, castID string, req DramaCastImagePromptRequest) (string, error) {
	project, row, err := s.dramaForUser(userID, projectID)
	if err != nil {
		return "", err
	}
	cast, err := s.repo.DramaCast(project.ID, castID)
	if err != nil {
		return "", dramaLookupError(err)
	}
	if req.Appearance != nil {
		appearance := strings.TrimSpace(*req.Appearance)
		if err := validateDramaCastText(appearance, "外观描述", 1000, true); err != nil {
			return "", err
		}
		cast.Appearance = appearance
	}
	settings, meta := parseDramaSettings(row.SettingsJSON), parseDramaBibleMeta(row.BibleJSON)
	if episodeID := strings.TrimSpace(req.EpisodeID); episodeID != "" {
		episode, err := s.repo.DramaEpisode(project.ID, episodeID)
		if err != nil {
			return "", dramaLookupError(err)
		}
		settings, meta = dramaEpisodeStyleSettings(settings, meta, *episode)
	}
	if err := validateDramaCastPresetSelection(settings, cast.ImageStyleID, req.ImageStyleID); err != nil {
		return "", err
	}
	if _, err := applyDramaCastImageFields(cast, nil, req.ImageStyleID, req.ImageStyleName, req.ImageStylePrompt); err != nil {
		return "", err
	}
	cast.ImagePrompt = ""
	return buildDramaCastImagePrompt(settings, meta, *cast), nil
}
