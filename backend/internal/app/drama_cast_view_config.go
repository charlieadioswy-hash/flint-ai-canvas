package app

import (
	"encoding/json"
	"fmt"
	"strings"
	"unicode/utf8"

	"yingce/backend/internal/model"
)

type DramaCastViewConfig struct {
	Name         string                `json:"name"`
	Direction    string                `json:"direction"`
	Prompt       string                `json:"prompt"`
	ImageOptions DramaCastImageOptions `json:"imageOptions"`
}

var dramaCastViewDirections = map[string]string{"front": "正面", "back": "背面", "left": "左侧", "right": "右侧", "top": "俯视", "detail": "局部", "custom": "自定义"}

func normalizeDramaCastViewConfig(config DramaCastViewConfig) (DramaCastViewConfig, error) {
	config.Name, config.Prompt = strings.TrimSpace(config.Name), strings.TrimSpace(config.Prompt)
	if utf8.RuneCountInString(config.Name) < 1 || utf8.RuneCountInString(config.Name) > 60 {
		return config, BadAuthRequest("视图名称须为 1–60 字")
	}
	if _, ok := dramaCastViewDirections[config.Direction]; !ok {
		return config, BadAuthRequest("视图方向无效")
	}
	if utf8.RuneCountInString(config.Prompt) > 12000 {
		return config, BadAuthRequest("视图提示词最多 12000 字")
	}
	if config.Direction == "custom" && config.Prompt == "" {
		return config, BadAuthRequest("请填写自定义视图说明")
	}
	return config, nil
}

func dramaCastViewImageCast(cast model.DramaCast, config DramaCastViewConfig) (model.DramaCast, error) {
	config, err := normalizeDramaCastViewConfig(config)
	if err != nil {
		return cast, err
	}
	if cast.Kind != "character" && cast.Kind != "scene" && cast.Kind != "prop" {
		return cast, BadAuthRequest("不支持此类资产视图")
	}
	base, err := parseDramaCastImageOptions(cast.ImageOptionsJSON)
	if err != nil {
		return cast, err
	}
	opts := config.ImageOptions
	if opts.Model.Empty() {
		opts.Model = base.Model
	}
	if opts.Ratio == "" {
		opts.Ratio = base.Ratio
	}
	if opts.Resolution == "" {
		opts.Resolution = base.Resolution
	}
	if opts.SubjectReferenceIDs == nil {
		opts.SubjectReferenceIDs = base.SubjectReferenceIDs
	}
	if opts.StyleReferenceIDs == nil {
		opts.StyleReferenceIDs = base.StyleReferenceIDs
	}
	encoded, _ := json.Marshal(opts)
	cast.ImageOptionsJSON = string(encoded)
	context := strings.TrimSpace(strings.Join([]string{cast.Name, cast.Description, cast.Appearance, cast.ImagePrompt}, "\n"))
	cast.ImagePrompt = fmt.Sprintf("主体设定（其中旧有排版方案由本次单视图要求替代）：\n%s\n\n本次视图要求：仅生成%s单视图，不生成拼图或多视图排版。保持同一主体身份、场景结构或道具形态，不补写未知设定。", context, dramaCastViewDirections[config.Direction])
	if config.Prompt != "" {
		cast.ImagePrompt += "\n本视图补充：" + config.Prompt
	}
	return cast, nil
}
