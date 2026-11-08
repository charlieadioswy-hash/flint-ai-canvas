package production

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestParseBiblePrefersSourceDefinitionRegardlessOfDuplicateOrder(t *testing.T) {
	source := "秦子文：26岁，冷静谨慎，务实有主见。"
	defined := BibleCharacter{Name: "秦子文", SourceDefinition: source, SourceChapterIndex: 1}
	extracted := BibleCharacter{Name: "秦子文", Description: "改写后的人设", Appearance: "模型补充的黑色风衣"}
	for _, characters := range [][]BibleCharacter{{extracted, defined}, {defined, extracted}} {
		body, err := json.Marshal(Bible{Characters: characters})
		if err != nil {
			t.Fatal(err)
		}
		bible, err := ParseBible(string(body), Chapter{Index: 1, Text: source})
		if err != nil || len(bible.Characters) != 1 || bible.Characters[0].Description != source || bible.Characters[0].Appearance != "" {
			t.Fatalf("verified definition must win over duplicate extraction: %+v, %v", bible, err)
		}
	}
}

func TestRestoreCharacterDefinitionsKeepsOriginalAndRejectsInferredFields(t *testing.T) {
	source := "1. 秦子文\n\n年龄：26岁\n\n性格：冷静谨慎，务实有主见\n\n背景：调查员，偶而会看一眼旧手表。"
	characters := []BibleCharacter{{
		Name: "秦子文", SourceDefinition: source, SourceChapterIndex: 1,
		Description: "冷静的年轻男调查员", Role: "调查员", Age: "26岁", Gender: "男",
		Appearance: "黑色短发，灰色夹克", Voice: "低沉男声", Aliases: []string{"秦子文", "秦队"},
		Looks: BibleLooks{{Name: "调查员", Appearance: "灰色夹克"}},
	}}
	chapters := []Chapter{{Index: 1, Text: "人物设定\n\n" + source + "\n\n第一章 夜雨\n秦子文走进街道。"}}
	got, err := RestoreCharacterDefinitions(characters, chapters)
	if err != nil {
		t.Fatal(err)
	}
	character := got[0]
	if character.Description != source || character.SourceDefinition != source || character.Role != "调查员" || character.Age != "26岁" {
		t.Fatalf("original definition not restored: %#v", character)
	}
	if character.Gender != "" || character.Appearance != "" || character.Voice != "" || len(character.Aliases) != 0 || len(character.Looks) != 0 {
		t.Fatalf("inferred fields retained: %#v", character)
	}
	if characters[0].Description != "冷静的年轻男调查员" || len(characters[0].Aliases) != 2 {
		t.Fatalf("input characters mutated: %#v", characters)
	}
}

func TestRestoreCharacterDefinitionsSupportsArbitrarySourceFormats(t *testing.T) {
	sources := []string{
		"## 秦子文\n\n**年龄**：26岁\n- 性格：冷静\n- 外貌：黑发\n- 声音：低沉\n",
		"| 姓名 | 年龄 | 性格 |\n| --- | --- | --- |\n| 秦子文 | 26岁 | 冷静 |",
		"【秦子文】\r\n其年龄为26岁；性格冷静，偶而沉默。",
	}
	for _, source := range sources {
		characters := []BibleCharacter{{Name: "秦子文", SourceDefinition: source, SourceChapterIndex: 7, Age: "26岁"}}
		got, err := RestoreCharacterDefinitions(characters, []Chapter{{Index: 7, Text: "前言\n" + source + "\n正文"}})
		if err != nil {
			t.Fatalf("source %q: %v", source, err)
		}
		if got[0].Description != source || got[0].Age != "26岁" {
			t.Fatalf("source text changed: %#v", got[0])
		}
	}
}

func TestRestoreCharacterDefinitionsSupportsImportedTitle(t *testing.T) {
	// analyzeNovel("附录：秦子文\n年龄：26岁…", { perEpisode: true }) 将姓名留在标题，正文只含说明。
	chapter := Chapter{Index: 7, Title: "附录：秦子文", Text: "年龄：26岁\n性格：冷静谨慎，务实有主见\n背景：承担照顾弟弟的责任。"}
	want := chapter.Title + "\n" + chapter.Text
	for name, quote := range map[string]string{
		"original title": want,
		"visible title":  chapterHeading(chapter, "") + chapter.Text,
		"sampled title":  chapterHeading(chapter, "（节选）") + chapter.Text,
	} {
		t.Run(name, func(t *testing.T) {
			if name == "sampled title" {
				chapters := []Chapter{{Index: 1, Text: strings.Repeat("文", 8000)}, chapter}
				if !strings.Contains(SampleNovel(chapters, 10000), quote) {
					t.Fatal("fixture must match the actual sampled heading")
				}
			} else if !strings.Contains(SampleNovel([]Chapter{chapter}, 40000), quote) {
				t.Fatal("fixture must match the actual chapter input")
			}
			body, err := json.Marshal(Bible{Characters: []BibleCharacter{{
				Name: "秦子文", SourceDefinition: quote, SourceChapterIndex: 7,
				Description: "模型改写", Age: "26岁", Gender: "男", Appearance: "银发", Voice: "低沉",
				Looks: BibleLooks{{Name: "日常", Appearance: "黑色夹克"}},
			}}})
			if err != nil {
				t.Fatal(err)
			}
			bible, err := ParseBible(string(body), chapter)
			if err != nil {
				t.Fatal(err)
			}
			character := bible.Characters[0]
			if character.Description != want || character.SourceDefinition != want || character.Age != "26岁" {
				t.Fatalf("original title and definition must be restored without host markers: %#v", character)
			}
			if character.Gender != "" || character.Appearance != "" || character.Voice != "" || len(character.Looks) != 0 {
				t.Fatalf("title-backed definition must not retain inferred fields: %#v", character)
			}
		})
	}
}

func TestRestoreCharacterDefinitionsRejectsUnverifiedTitle(t *testing.T) {
	chapter := Chapter{Index: 1, Title: "附录：秦子文", Text: "年龄：26岁\n性格：冷静"}
	original := chapter.Title + "\n" + chapter.Text
	tests := []struct {
		name      string
		character BibleCharacter
		chapters  []Chapter
	}{
		{"other character with visible title", BibleCharacter{Name: "林晓", SourceDefinition: chapterHeading(chapter, "") + chapter.Text, SourceChapterIndex: 1}, []Chapter{chapter}},
		{"unrelated body under matching title", BibleCharacter{Name: "秦子文", SourceDefinition: "林晓：18岁，活泼。", SourceChapterIndex: 1}, []Chapter{{Index: 1, Title: chapter.Title, Text: "林晓：18岁，活泼。"}}},
		{"forged title", BibleCharacter{Name: "秦子文", SourceDefinition: original, SourceChapterIndex: 1}, []Chapter{{Index: 1, Title: "附录：林晓", Text: chapter.Text}}},
		{"rewritten body", BibleCharacter{Name: "秦子文", SourceDefinition: strings.ReplaceAll(original, "26岁", "30岁"), SourceChapterIndex: 1}, []Chapter{chapter}},
		{"forged host index", BibleCharacter{Name: "秦子文", SourceDefinition: "## [2] " + original, SourceChapterIndex: 1}, []Chapter{chapter}},
		{"wrong chapter", BibleCharacter{Name: "秦子文", SourceDefinition: original, SourceChapterIndex: 2}, []Chapter{chapter, {Index: 2, Title: chapter.Title, Text: "年龄：30岁\n性格：开朗"}}},
		{"skipped body prefix", BibleCharacter{Name: "秦子文", SourceDefinition: original, SourceChapterIndex: 1}, []Chapter{{Index: 1, Title: chapter.Title, Text: "不能跳过的原文\n" + chapter.Text}}},
		{"original title only", BibleCharacter{Name: "秦子文", SourceDefinition: chapter.Title, SourceChapterIndex: 1}, []Chapter{chapter}},
		{"visible title only", BibleCharacter{Name: "秦子文", SourceDefinition: chapterHeading(chapter, ""), SourceChapterIndex: 1}, []Chapter{chapter}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := RestoreCharacterDefinitions([]BibleCharacter{test.character}, test.chapters)
			if err == nil || got != nil {
				t.Fatalf("unverified title-backed definition accepted: %#v, %v", got, err)
			}
		})
	}
}

func TestRestoreCharacterDefinitionsRejectsUnverifiedSource(t *testing.T) {
	source := "秦子文\n年龄：26岁\n性格：冷静"
	tests := []struct {
		name      string
		character BibleCharacter
		chapters  []Chapter
	}{
		{"rewritten", BibleCharacter{Name: "秦子文", SourceDefinition: strings.ReplaceAll(source, "冷静", "沉着"), SourceChapterIndex: 1}, []Chapter{{Index: 1, Text: source}}},
		{"wrong chapter", BibleCharacter{Name: "秦子文", SourceDefinition: source, SourceChapterIndex: 2}, []Chapter{{Index: 1, Text: source}, {Index: 2, Text: "另一章"}}},
		{"missing chapter", BibleCharacter{Name: "秦子文", SourceDefinition: source}, []Chapter{{Index: 1, Text: source}}},
		{"missing source", BibleCharacter{Name: "秦子文", SourceChapterIndex: 1}, []Chapter{{Index: 1, Text: source}}},
		{"other character", BibleCharacter{Name: "林晓", SourceDefinition: source, SourceChapterIndex: 1}, []Chapter{{Index: 1, Text: source}}},
		{"no chapters", BibleCharacter{Name: "秦子文", SourceDefinition: source, SourceChapterIndex: 1}, nil},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := RestoreCharacterDefinitions([]BibleCharacter{test.character}, test.chapters)
			if err == nil || got != nil || !strings.Contains(err.Error(), "角色") {
				t.Fatalf("unverified source accepted: %#v, %v", got, err)
			}
		})
	}
}

func TestRestoreCharacterDefinitionsKeepsMixedAndLegacyExtraction(t *testing.T) {
	source := "秦队：26岁，冷静。别名：秦哥。"
	characters := []BibleCharacter{
		{Name: "秦子文", Aliases: []string{"秦队", "秦哥", "秦哥", "小秦"}, SourceDefinition: source, SourceChapterIndex: 2, Age: "26岁"},
		{Name: "林晓", Description: "正文提取", Appearance: "短发", Gender: "女", Looks: BibleLooks{{Name: "上班", Appearance: "西装"}}},
	}
	got, err := RestoreCharacterDefinitions(characters, []Chapter{{Index: 2, Text: source}})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got[0].Aliases, []string{"秦队", "秦哥"}) || !reflect.DeepEqual(got[1], characters[1]) {
		t.Fatalf("explicit aliases or extracted character changed: %#v", got)
	}
	legacy, err := RestoreCharacterDefinitions(characters[1:], nil)
	if err != nil || !reflect.DeepEqual(legacy, characters[1:]) {
		t.Fatalf("legacy parse rejected: %#v, %v", legacy, err)
	}
}

func TestRestoreCharacterDefinitionsDoesNotTruncate(t *testing.T) {
	source := "秦子文\n\n" + strings.Repeat("背景：这段设定必须完整保留，偶而重复。\n\n", 400)
	characters := []BibleCharacter{{Name: "秦子文", SourceDefinition: source, SourceChapterIndex: 9}}
	got, err := RestoreCharacterDefinitions(characters, []Chapter{{Index: 9, Text: source}})
	if err != nil {
		t.Fatal(err)
	}
	if got[0].Description != source || got[0].SourceDefinition != source {
		t.Fatal("long source definition was truncated")
	}
}
