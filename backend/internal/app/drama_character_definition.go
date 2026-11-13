package app

import (
	"encoding/json"
	"fmt"
	"io"
	"strings"

	"yingce/backend/internal/model"
	"yingce/backend/internal/production"
)

func parseDramaCharacterDefinition(raw string) (map[string]any, error) {
	if strings.TrimSpace(raw) == "" {
		return map[string]any{}, nil
	}
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.UseNumber()
	var value map[string]any
	if err := decoder.Decode(&value); err != nil || value == nil {
		return nil, BadAuthRequest("人物定义必须为 JSON 对象")
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		return nil, BadAuthRequest("人物定义格式无效")
	}
	return value, nil
}

func dramaDefinitionText(value map[string]any, key string) string {
	text, _ := value[key].(string)
	return text
}

func knownDramaCharacterDefinitionKey(key string) bool {
	switch key {
	case "name", "aliases", "role", "description", "appearance", "imagePrompt", "voiceInstructions", "voice", "sourceDefinition", "sourceChapterIndex", "gender", "age", "personality", "background", "physique", "clothing", "props", "consistencyPrompt", "multiViewPrompt", "voiceLanguage", "voiceAge", "voiceTimbre":
		return true
	}
	return false
}

// 平铺字段是制作台当前已保存的值；结构化扩展及原始定义始终保留。
func dramaCharacterDefinitionForCast(cast model.DramaCast) (map[string]any, error) {
	value, err := parseDramaCharacterDefinition(cast.DefinitionJSON)
	if err != nil {
		return nil, err
	}
	value["name"], value["aliases"], value["role"] = cast.Name, decodeStringList(cast.AliasesJSON), cast.Role
	value["description"], value["appearance"] = cast.Description, cast.Appearance
	value["imagePrompt"], value["voiceInstructions"] = cast.ImagePrompt, cast.VoiceInstructions
	return value, nil
}

func dramaCharacterDefinitionJSON(value map[string]any) (string, error) {
	encoded, err := normalizedCharacterDefinition(value)
	if err != nil {
		return "", err
	}
	if len(encoded) > 128<<10 {
		return "", BadAuthRequest("人物定义过长，请控制在 128 KB 内")
	}
	return string(encoded), nil
}

func dramaCharacterLibraryText(cast *model.DramaCast, name string, value map[string]any) {
	cast.Name, cast.Role = name, dramaDefinitionText(value, "role")
	if current, ok := value["description"].(string); ok {
		cast.Description = current
	} else {
		cast.Description = firstNonEmpty(dramaDefinitionText(value, "sourceDefinition"), dramaDefinitionText(value, "background"))
	}
	cast.Appearance = dramaDefinitionText(value, "appearance")
	cast.ImagePrompt = dramaDefinitionText(value, "imagePrompt")
	cast.VoiceInstructions = firstNonEmpty(dramaDefinitionText(value, "voiceInstructions"), dramaDefinitionText(value, "voice"))
	aliases := []string{}
	if entries, ok := value["aliases"].([]any); ok {
		for _, entry := range entries {
			if text, ok := entry.(string); ok && strings.TrimSpace(text) != "" {
				aliases = append(aliases, text)
			}
		}
	} else if text := dramaDefinitionText(value, "aliases"); text != "" {
		aliases = strings.FieldsFunc(text, func(r rune) bool { return r == ',' || r == '，' || r == '、' || r == '\n' })
	}
	cast.AliasesJSON = encodeStringList(aliases)
}

// 未知键只用于完整保存；生成只读取有明确业务含义的文字，且不补造未填写字段。
func dramaCharacterStructuredText(cast model.DramaCast, visualOnly bool) string {
	if cast.Kind != "character" || cast.ParentID != "" {
		return ""
	}
	definition, err := parseDramaCharacterDefinition(cast.DefinitionJSON)
	if err != nil {
		return ""
	}
	fields := []struct {
		key, label string
		visual     bool
	}{
		{"age", "年龄", true}, {"gender", "性别", true}, {"personality", "性格", false},
		{"background", "背景", false}, {"physique", "体型", true}, {"clothing", "服装", true},
		{"props", "随身物品", true}, {"consistencyPrompt", "形象一致性说明", true}, {"multiViewPrompt", "多视图说明", true},
		{"voiceLanguage", "声音语言", false}, {"voiceAge", "声音年龄", false}, {"voiceTimbre", "音色", false},
	}
	lines := []string{}
	for _, field := range fields {
		if visualOnly && !field.visual {
			continue
		}
		if text := dramaDefinitionText(definition, field.key); strings.TrimSpace(text) != "" {
			lines = append(lines, field.label+"："+text)
		}
	}
	return strings.Join(lines, "\n")
}

func dramaExtractedCharacterDefinition(character production.BibleCharacter) model.DramaCharacterDefinition {
	value := map[string]any{"name": character.Name, "aliases": character.Aliases}
	if character.SourceDefinition != "" {
		// 已明确给出的原文只保留原文；不把模型推测的年龄、性别或背景追加为作者定义。
		value["sourceDefinition"] = character.SourceDefinition
		value["sourceChapterIndex"] = character.SourceChapterIndex
	} else {
		value["role"], value["gender"], value["age"] = character.Role, character.Gender, character.Age
		value["description"], value["appearance"], value["voiceInstructions"] = character.Description, character.Appearance, character.Voice
	}
	// Bible 数据已由提取器限长，编码只涉及字符串与整数，不会失败。
	raw, _ := json.Marshal(value)
	return model.DramaCharacterDefinition{DefinitionJSON: string(raw)}
}

func validateDramaDefinitionFields(fields map[string]string) error {
	allowed := map[string]bool{"age": true, "gender": true, "personality": true, "background": true, "physique": true, "clothing": true, "props": true, "consistencyPrompt": true, "multiViewPrompt": true, "voiceLanguage": true, "voiceAge": true, "voiceTimbre": true, "role": true}
	if len(fields) == 0 || len(fields) > len(allowed) {
		return BadAuthRequest("请选择要修改的人物信息")
	}
	for key, value := range fields {
		if !allowed[key] {
			return BadAuthRequest("不支持修改人物字段：" + key)
		}
		if len(value) > 16<<10 {
			return BadAuthRequest(fmt.Sprintf("人物字段 %s 过长", key))
		}
		if key == "role" && len([]rune(value)) > 120 {
			return BadAuthRequest("角色定位不能超过 120 字")
		}
	}
	return nil
}
