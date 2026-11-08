package production

import (
	"fmt"
	"strings"
)

// RestoreCharacterDefinitions 让模型识别任意格式的人设，但只有经原文章节核验的
// 连续引用才能作为定义复用；正文未写明的外貌、声音与造型不得由模型补齐。
func RestoreCharacterDefinitions(characters []BibleCharacter, chapters []Chapter) ([]BibleCharacter, error) {
	result := append([]BibleCharacter(nil), characters...)
	for index, character := range result {
		if character.SourceDefinition == "" && character.SourceChapterIndex == 0 {
			continue
		}
		if strings.TrimSpace(character.SourceDefinition) == "" || character.SourceChapterIndex <= 0 {
			return nil, fmt.Errorf("角色“%s”的原文设定引用不完整，请提供说明原文及所属章节序号", character.Name)
		}
		var source string
		for _, chapter := range chapters {
			if chapter.Index != int(character.SourceChapterIndex) {
				continue
			}
			if source = characterDefinitionSource(chapter, character.SourceDefinition); source != "" {
				break
			}
		}
		if source == "" {
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

func characterDefinitionSource(chapter Chapter, quote string) string {
	if strings.Contains(chapter.Text, quote) {
		return quote
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
