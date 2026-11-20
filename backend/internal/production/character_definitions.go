package production

import (
	"fmt"
	"strings"
)

// RestoreCharacterDefinitions 让模型识别任意格式的人设，但只有经原文章节核验的
// 人物说明才能作为定义复用；字幕或姓名标签不覆盖正文提取，未写明的信息不得补齐。
func RestoreCharacterDefinitions(characters []BibleCharacter, chapters []Chapter) ([]BibleCharacter, error) {
	result := append([]BibleCharacter(nil), characters...)
	for index, character := range result {
		if character.SourceDefinition == "" && character.SourceChapterIndex == 0 {
			continue
		}
		if strings.TrimSpace(character.SourceDefinition) == "" || character.SourceChapterIndex < 0 {
			return nil, fmt.Errorf("角色“%s”的原文设定引用不完整，请提供说明原文及所属章节序号", character.Name)
		}
		var source string
		for _, chapter := range chapters {
			if chapter.Index != int(character.SourceChapterIndex) || chapter.Index == 0 && !chapter.IsReference {
				continue
			}
			if source = characterDefinitionSource(chapter, character.SourceDefinition); source != "" {
				break
			}
		}
		if source == "" {
			if character.SourceChapterIndex == 0 {
				return nil, fmt.Errorf("角色“%s”的设定引用与作品参考资料不一致，请保留原文字句与格式", character.Name)
			}
			return nil, fmt.Errorf("角色“%s”的设定引用与第 %d 章原文不一致，请保留原文字句与格式", character.Name, character.SourceChapterIndex)
		}
		aliases := make([]string, 0, len(character.Aliases))
		seen := map[string]bool{NormalizeName(character.Name): true}
		for _, alias := range character.Aliases {
			alias = strings.TrimSpace(alias)
			key := NormalizeName(alias)
			if key != "" && !seen[key] && strings.Contains(source, alias) {
				seen[key] = true
				aliases = append(aliases, alias)
			}
		}
		name := strings.TrimSpace(character.Name)
		if (name == "" || !strings.Contains(source, name)) && len(aliases) == 0 {
			return nil, fmt.Errorf("角色“%s”的设定引用未包含角色姓名或原文明示的别名", character.Name)
		}
		if characterDefinitionIsLabel(source, append([]string{name}, aliases...)) {
			// 出场字幕只标识人物，不能用它清空正文中已经抽出的外观、声线或其他造型。
			character.SourceDefinition, character.SourceChapterIndex = "", 0
			result[index] = character
			continue
		}
		character.SourceDefinition, character.Description = source, source
		character.Aliases = aliases
		character.Role = characterDefinitionValue(source, character.Role)
		character.Gender = characterDefinitionValue(source, character.Gender)
		character.Age = characterDefinitionValue(source, character.Age)
		character.Appearance = characterDefinitionValue(source, character.Appearance)
		character.Voice = characterDefinitionValue(source, character.Voice)
		character.Looks = nil
		result[index] = character
	}
	return result, nil
}

func characterDefinitionIsLabel(source string, names []string) bool {
	text := strings.TrimSpace(source)
	wrapped := false
	for _, brackets := range [][2]string{{"（", "）"}, {"(", ")"}, {"【", "】"}, {"[", "]"}} {
		if !strings.HasPrefix(text, brackets[0]) {
			continue
		}
		closing := strings.Index(text, brackets[1])
		if closing < 0 {
			return false
		}
		if closing+len(brackets[1]) == len(text) {
			text = strings.TrimSpace(text[len(brackets[0]):closing])
			wrapped = true
		} else if strings.ContainsAny(text[:closing], ":：") {
			// 字幕括号之外还有人物说明时，不能把整段说明降级为标签。
			return false
		}
		break
	}
	if strings.ContainsAny(text, "\r\n") && !wrapped {
		return false
	}
	if separator := strings.IndexAny(text, ":：]】"); separator >= 0 {
		switch NormalizeName(text[:separator]) {
		case "人物字幕", "角色字幕", "姓名字幕", "出场字幕", "字幕":
			// 同一引用还包含外观等说明字段时，仍按完整人物说明核验。
			return !strings.ContainsAny(strings.TrimLeft(text[separator:], ":：]】"), ":：")
		case "姓名", "角色姓名", "人物姓名", "角色名", "人物名":
			text = strings.TrimLeft(text[separator:], ":：]】")
		}
	}
	key := NormalizeName(text)
	for _, name := range names {
		if normalized := NormalizeName(name); normalized != "" && key == normalized {
			return true
		}
	}
	return false
}

func characterDefinitionSource(chapter Chapter, quote string) string {
	if strings.Contains(chapter.Text, quote) {
		return quote
	}
	if chapter.IsReference {
		return ""
	}
	// 导入将标题与正文分开保存；还原跨过两者边界的原文，宿主章节标记不属于人设。
	for _, suffix := range []string{"", "（节选）"} {
		if heading := chapterHeading(chapter, suffix); strings.HasPrefix(quote, heading) {
			body := strings.TrimPrefix(quote, heading)
			if body != "" && strings.HasPrefix(chapter.Text, body) {
				return chapter.Title + "\n" + body
			}
			return ""
		}
	}
	title, body, ok := strings.Cut(quote, "\n")
	if ok && title != "" && body != "" && strings.HasSuffix(chapter.Title, title) && strings.HasPrefix(chapter.Text, body) {
		return quote
	}
	return ""
}

func characterDefinitionValue(source, value string) string {
	value = strings.TrimSpace(value)
	if value != "" && strings.Contains(source, value) {
		return value
	}
	return ""
}
