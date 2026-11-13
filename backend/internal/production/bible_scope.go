package production

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
)

// 查漏允许目标数组明确为空，但不能把未返回目标字段、null 或错误结构视为“没有新增”。
// 先隔离目标字段，非本类输出的结构错误与原文引文都不参与本次处理。
func scopeBibleJSON(text, kind string) (string, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal([]byte(text), &fields); err != nil {
		return "", err
	}
	key := map[string]string{"character": "characters", "scene": "scenes", "prop": "props"}[kind]
	value := bytes.TrimSpace(fields[key])
	if len(value) == 0 || value[0] != '[' {
		return "", fmt.Errorf("作品圣经未返回有效的%s数组", bibleKindLabel(kind))
	}
	var entries []map[string]json.RawMessage
	if err := json.Unmarshal(value, &entries); err != nil {
		return "", fmt.Errorf("作品圣经%s条目格式错误：%w", bibleKindLabel(kind), err)
	}
	for _, entry := range entries {
		var name string
		if err := json.Unmarshal(entry["name"], &name); err != nil || strings.TrimSpace(name) == "" {
			return "", fmt.Errorf("作品圣经%s条目缺少有效名称", bibleKindLabel(kind))
		}
	}
	filtered, err := json.Marshal(map[string]json.RawMessage{key: value})
	return string(filtered), err
}

// BibleExtractionSystemPrompt 在全书设定建档约束上，收紧为只增量提取或重新查漏一类。
// kind 已由调用方校验。正文必须保留“作品圣经”，供现有识别逻辑定位。
func BibleExtractionSystemPrompt(kind string) string {
	return BibleSystemPrompt() + "本次按种类做增量提取/重新查漏，仍然输出作品圣经。" + bibleExtractionScope(kind)
}

// BibleExtractionPrompt 复用全书设定提示词，并要求只抽取本次种类。
// 非本类数组必须为空；不得根据已有资产补写本次来源中未出现的内容，不得生成图片。
func BibleExtractionPrompt(title string, settings Settings, chapters []Chapter, maxChars int, skill *WritingSkill, kind string) string {
	base := BiblePrompt(title, settings, chapters, maxChars, skill)
	var b strings.Builder
	b.WriteString(base)
	b.WriteString("\n【增量提取/重新查漏】\n")
	b.WriteString(bibleExtractionScope(kind))
	fmt.Fprintf(&b, "本次只做%s的增量提取或重新查漏：只抽取本次来源中实际出现、且属于%s的内容。\n", bibleKindLabel(kind), bibleKindLabel(kind))
	b.WriteString("不得根据已有资产、记忆或设定补写未出现在本次来源中的角色、场景或道具。不得生成图片、图片提示词或参考图。\n")
	b.WriteString("依旧只输出既有作品圣经 JSON 结构；非本次种类的 characters、props、scenes 数组必须为 []，不得返回其他种类的条目。\n")
	b.WriteString("必须返回本次目标种类的数组；本次来源确实没有对应资产时明确返回 []，不要省略目标字段或使用 null。\n")
	return b.String()
}

func bibleExtractionScope(kind string) string {
	label := bibleKindLabel(kind)
	var other string
	switch kind {
	case "scene":
		other = "characters 与 props 必须为 []"
	case "prop":
		other = "characters 与 scenes 必须为 []"
	default:
		other = "props 与 scenes 必须为 []"
	}
	return fmt.Sprintf("本次是增量提取/重新查漏，只抽取%s。%s。不要抽取、补写或改写其他种类。", label, other)
}

func bibleKindLabel(kind string) string {
	switch kind {
	case "scene":
		return "场景"
	case "prop":
		return "道具"
	default:
		return "角色"
	}
}
