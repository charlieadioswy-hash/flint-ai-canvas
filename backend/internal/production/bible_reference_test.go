package production

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestBibleWithReferenceKeepsSourceSeparateAndVerifiesQuotes(t *testing.T) {
	const definition = "秦子文\n年龄：26岁\n性格：冷静谨慎"
	reference := Chapter{Title: "作品参考资料", Text: definition + "\n" + strings.Repeat("资料", 5900) + "末尾的道具", IsReference: true}
	chapters := []Chapter{{Index: 2, Title: "第二集", Text: "秦子文踏进大厅。"}}
	prompt := BibleWithReferencePrompt("测试", Settings{}, chapters, 40000, nil, reference, true)
	body, includeReference, _ := strings.Cut(prompt, "【作品参考资料】")
	if !strings.Contains(body, "章节总数：1") || !strings.Contains(body, "## [2] 第二集\n秦子文踏进大厅。") || strings.Contains(body, definition) || !strings.Contains(includeReference, reference.Text) {
		t.Fatal("formal source and full reference must have distinct sections and counts")
	}
	raw := `{"characters":[{"name":"秦子文","description":"概要"}],"scenes":[],"props":[],"referenceAssets":{"characters":[{"name":"秦子文","sourceDefinition":"秦子文\n年龄：26岁\n性格：冷静谨慎","sourceChapterIndex":0,"age":"26岁"}],"scenes":[],"props":[{"name":"末尾的道具"}]}}`
	ordinary, references, err := ParseBibleWithReference(raw, reference, chapters)
	if err != nil || len(ordinary.Characters) != 1 || ordinary.Characters[0].Description != definition || ordinary.Characters[0].Age != "26岁" || len(ordinary.Props) != 0 || len(references.Props) != 1 {
		t.Fatalf("reference definition should be available to formal assets without merging the asset lists: %+v %+v %v", ordinary, references, err)
	}
	if _, _, err := ParseBibleWithReference(strings.ReplaceAll(raw, "冷静谨慎", "冷静缜密"), reference, chapters); err == nil {
		t.Fatal("modified reference quote was accepted")
	}
	if _, _, err := ParseBibleWithReference(strings.ReplaceAll(raw, `"sourceDefinition":"秦子文`, `"sourceDefinition":"作品参考资料\n秦子文`), reference, chapters); err == nil {
		t.Fatal("synthetic reference title was accepted as part of the source quote")
	}
	if _, _, err := ParseBibleWithReference(`{"characters":[{"name":"秦子文"}],"scenes":[],"props":[]}`, reference, chapters); err == nil {
		t.Fatal("missing reference extraction was silently accepted")
	}
}

func TestBibleWithReferenceRetainsNovelArtDirection(t *testing.T) {
	reference := Chapter{Text: "场景设定\n堡垒用玄武岩建成。\n视觉风格\n冬季冷青自然光。", IsReference: true}
	chapters := []Chapter{{Index: 1, Title: "第一章", Text: "苏岚踏出镇口。"}}
	prompt := BibleWithReferencePrompt("长冬", Settings{StylePrompt: "真人电影质感"}, chapters, 40000, nil, reference, true)
	for _, expected := range []string{"视觉风格：真人电影质感", reference.Text, "等稳定要求整理进 visualRules", "作品已选的视觉风格优先", "只有在明确属于作品世界时才建成资产"} {
		if !strings.Contains(prompt, expected) {
			t.Errorf("asset extraction prompt does not contain %q", expected)
		}
	}
	const result = `{"visualRules":"冬季冷青自然光，玄武岩堡垒。","characters":[{"name":"苏岚"}],"scenes":[],"props":[],"referenceAssets":{"characters":[],"scenes":[{"name":"玄武岩堡垒"}],"props":[]}}`
	bible, assets, err := ParseBibleWithReference(result, reference, chapters)
	if err != nil || bible.VisualRules != "冬季冷青自然光，玄武岩堡垒。" || len(bible.Scenes) != 0 || len(assets.Scenes) != 1 || assets.Scenes[0].Name != "玄武岩堡垒" {
		t.Fatalf("novel visual rules and project-only scene were not retained: %+v %+v %v", bible, assets, err)
	}
}

func TestBibleWithReferenceRejectsEmptyExtraction(t *testing.T) {
	reference := Chapter{Text: "参考资料", IsReference: true}
	chapters := []Chapter{{Index: 1, Title: "第一章", Text: "苏岚把钥匙放到桌上。"}}
	for _, raw := range []string{
		`{"characters":[],"scenes":[],"props":[],"referenceAssets":{"characters":[],"scenes":[],"props":[]}}`,
		`{"characters":[],"scenes":[{"name":" "}],"props":[],"referenceAssets":{"characters":[],"scenes":[],"props":[{"name":" "}]}}`,
	} {
		if _, _, err := ParseBibleWithReference(raw, reference, chapters); err == nil {
			t.Fatalf("empty extraction was accepted: %s", raw)
		}
	}
	const raw = `{"characters":[],"scenes":[],"props":[],"referenceAssets":{"characters":[],"scenes":[{"name":"荒城"}],"props":[]}}`
	_, assets, err := ParseBibleWithReference(raw, reference, chapters)
	if err != nil || len(assets.Scenes) != 1 {
		t.Fatalf("a reference-only scene should satisfy extraction: %+v %v", assets, err)
	}
}

func TestBibleExtractionWithReferenceKeepsFullSourceThatFitsSharedBudget(t *testing.T) {
	reference := Chapter{Text: strings.Repeat("资", 12000), IsReference: true}
	chapters := []Chapter{
		{Index: 1, Title: "第一章", Text: strings.Repeat("甲", 9000)},
		{Index: 2, Title: "第二章", Text: strings.Repeat("乙", 9000)},
		{Index: 3, Title: "第三章", Text: strings.Repeat("丙", 8998) + "玉佩"},
	}
	prompt := BibleExtractionSourcePrompt("测试", Settings{}, chapters, 40000, nil, "prop", &reference)
	_, source, _ := strings.Cut(prompt, "【正式正文】\n")
	formal, references, _ := strings.Cut(source, "【作品参考资料】\n")
	if !strings.HasSuffix(formal, "玉佩\n\n") || !strings.HasPrefix(references, reference.Text) {
		t.Fatal("formal body and reference should both fit within the shared 40,000-character source budget")
	}
	if size := utf8.RuneCountInString(formal) + utf8.RuneCountInString(reference.Text); size > 40000 {
		t.Fatalf("combined source exceeded budget: %d", size)
	}
	chapters = append(chapters, Chapter{Index: 4, Title: "第四章", Text: strings.Repeat("丁", 12000)})
	prompt = BibleExtractionSourcePrompt("测试", Settings{}, chapters, 40000, nil, "prop", &reference)
	_, source, _ = strings.Cut(prompt, "【正式正文】\n")
	formal, _, _ = strings.Cut(source, "【作品参考资料】\n")
	if size := utf8.RuneCountInString(formal) + utf8.RuneCountInString(reference.Text); size > 40000 || !strings.Contains(formal, "（节选）") {
		t.Fatalf("long source did not sample within the shared budget: %d", size)
	}
}

func TestBibleExtractionWithReferenceIncludesReferenceOnlyAssets(t *testing.T) {
	reference := Chapter{Text: "小传：苏岚的弟弟苏越代管避难所。", IsReference: true}
	chapters := []Chapter{{Index: 1, Title: "第一章", Text: "苏岚把钥匙放到桌上。"}}
	const referenceRule = "即使只出现在作品参考资料中"
	const episodeRule = "角色只保留会在镜头中出现的人物"
	withReference := BibleExtractionSourcePrompt("测试", Settings{}, chapters, 40000, nil, "character", &reference)
	if !strings.Contains(withReference, referenceRule) || !strings.Contains(withReference, reference.Text) || strings.Contains(withReference, episodeRule) {
		t.Fatalf("project catch-up must cover reference-only assets without an appearance restriction: %s", withReference)
	}
	withoutReference := BibleExtractionPrompt("测试", Settings{}, chapters, 40000, nil, "character")
	if strings.Contains(withoutReference, referenceRule) || !strings.Contains(withoutReference, episodeRule) {
		t.Fatalf("episode catch-up must retain its original appearance restriction: %s", withoutReference)
	}
}
