package production

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
)

func TestParseBibleForKindKeepsOnlyRequestedKind(t *testing.T) {
	raw := `{
		"characters":[{"name":"不该留下","sourceDefinition":"这不是原文","sourceChapterIndex":9}],
		"scenes":[{"name":"演武台"},{"name":" 演武台 "},{"name":"后山"}],
		"props":[{"name":"神丹"},{"name":"神丹"}]
	}`
	chapters := []Chapter{{Index: 1, Title: "一", Text: "陆沉走上演武台。"}}

	scenes, err := ParseBibleForKind(raw, "scene", chapters...)
	if err != nil {
		t.Fatal(err)
	}
	if len(scenes.Scenes) != 2 || scenes.Scenes[0].Name != "演武台" || scenes.Scenes[1].Name != "后山" {
		t.Fatalf("scenes = %+v", scenes.Scenes)
	}
	if len(scenes.Characters) != 0 || len(scenes.Props) != 0 {
		t.Fatalf("scene extraction must drop other kinds: %+v", scenes)
	}

	props, err := ParseBibleForKind(raw, "prop", chapters...)
	if err != nil {
		t.Fatal(err)
	}
	if len(props.Props) != 1 || props.Props[0].Name != "神丹" || len(props.Characters) != 0 || len(props.Scenes) != 0 {
		t.Fatalf("prop extraction must keep only props: %+v", props)
	}
}

func TestParseBibleForKindDoesNotTruncateRequestedAssets(t *testing.T) {
	bible := Bible{}
	for i := 0; i < 30; i++ {
		bible.Characters = append(bible.Characters, BibleCharacter{Name: fmt.Sprintf("角色%d", i)})
		bible.Scenes = append(bible.Scenes, BibleScene{Name: fmt.Sprintf("场景%d", i)})
		bible.Props = append(bible.Props, BibleProp{Name: fmt.Sprintf("道具%d", i)})
	}
	bible.Characters = append(bible.Characters, bible.Characters[0])
	bible.Scenes = append(bible.Scenes, bible.Scenes[0])
	bible.Props = append(bible.Props, bible.Props[0])
	raw, err := json.Marshal(bible)
	if err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"character", "scene", "prop"} {
		t.Run(kind, func(t *testing.T) {
			parsed, err := ParseBibleForKind(string(raw), kind)
			if err != nil {
				t.Fatal(err)
			}
			if len(parsed.Characters)+len(parsed.Scenes)+len(parsed.Props) != 30 {
				t.Fatalf("scoped extraction must keep all unique requested assets: %+v", parsed)
			}
		})
	}
	initial, err := ParseBible(string(raw))
	if err != nil || len(initial.Characters) != 24 || len(initial.Scenes) != 16 || len(initial.Props) != 20 {
		t.Fatalf("initial Bible must retain its existing limits: %+v %v", initial, err)
	}
}

func TestParseBibleForKindRequiresOwnKindAndRejectsUnknown(t *testing.T) {
	onlyCharacters := `{"characters":[{"name":"陆沉"}]}`
	if _, err := ParseBibleForKind(onlyCharacters, "scene"); err == nil || !strings.Contains(err.Error(), "场景") {
		t.Fatalf("missing scenes must fail in Chinese, got %v", err)
	}
	if _, err := ParseBibleForKind(onlyCharacters, "prop"); err == nil || !strings.Contains(err.Error(), "道具") {
		t.Fatalf("missing props must fail in Chinese, got %v", err)
	}
	if _, err := ParseBibleForKind(`{"scenes":[{"name":"演武台"}]}`, "character"); err == nil || !strings.Contains(err.Error(), "角色") {
		t.Fatalf("character extraction still requires a character, got %v", err)
	}
	if _, err := ParseBibleForKind(onlyCharacters, "look"); err == nil || !strings.Contains(err.Error(), "未知") {
		t.Fatalf("unknown kind must fail in Chinese, got %v", err)
	}
	if _, err := ParseBible(onlyCharacters); err != nil {
		t.Fatalf("existing ParseBible must still accept characters without a kind: %v", err)
	}
}

func TestParseBibleForKindAcceptsExplicitEmptyTargetOnly(t *testing.T) {
	for _, tc := range []struct{ kind, key string }{{"character", "characters"}, {"scene", "scenes"}, {"prop", "props"}} {
		t.Run(tc.kind, func(t *testing.T) {
			bible, err := ParseBibleForKind(`{"`+tc.key+`":[],"logline":"本次没有新增"}`, tc.kind)
			if err != nil || len(bible.Characters)+len(bible.Scenes)+len(bible.Props) != 0 {
				t.Fatalf("explicit empty %s must succeed: %+v %v", tc.key, bible, err)
			}
			for _, value := range []string{"null", `{}`, `""`, "0", `["错误条目"]`, `[null]`, `[{}]`, `[{"name":4}]`, `[{"name":""}]`} {
				if _, err := ParseBibleForKind(`{"`+tc.key+`":`+value+`}`, tc.kind); err == nil {
					t.Fatalf("invalid target array was accepted: %s=%s", tc.key, value)
				}
			}
			if _, err := ParseBibleForKind(`{"logline":"漏了目标字段"}`, tc.kind); err == nil {
				t.Fatal("missing target array must fail")
			}
		})
	}
}

func TestParseBibleForKindCharacterKeepsVerifiedSource(t *testing.T) {
	chapters := []Chapter{{Index: 2, Title: "人物", Text: "陆沉：少年修士，黑发白衣。\n他走上演武台。"}}
	raw := `{
		"characters":[{"name":"陆沉","description":"改写后的说明","sourceDefinition":"陆沉：少年修士，黑发白衣。","sourceChapterIndex":2,"appearance":"不存在的外貌"}],
		"scenes":[{"name":"不该留下"}],
		"props":[{"name":"不该留下"}]
	}`
	bible, err := ParseBibleForKind(raw, "character", chapters...)
	if err != nil {
		t.Fatal(err)
	}
	if len(bible.Characters) != 1 || bible.Characters[0].Description != "陆沉：少年修士，黑发白衣。" || bible.Characters[0].Appearance != "" {
		t.Fatalf("verified source must replace rewritten fields: %+v", bible.Characters)
	}
	if len(bible.Scenes) != 0 || len(bible.Props) != 0 {
		t.Fatalf("character extraction must not return other kinds: %+v", bible)
	}
	characterOnly := `{
		"characters":[{"name":"陆沉","description":"改写后的说明","sourceDefinition":"陆沉：少年修士，黑发白衣。","sourceChapterIndex":2,"appearance":"不存在的外貌"}]
	}`
	full, err := ParseBible(characterOnly, chapters...)
	if err != nil {
		t.Fatal(err)
	}
	if full.Characters[0].SourceDefinition != bible.Characters[0].SourceDefinition || full.Characters[0].Description != bible.Characters[0].Description || full.Characters[0].Appearance != "" {
		t.Fatalf("character kind must reuse the same source restore:\nkind=%+v\nfull=%+v", bible.Characters[0], full.Characters[0])
	}
}

func TestParseBibleForKindIgnoresUnrequestedBrokenSource(t *testing.T) {
	raw := `{
		"characters":[{"name":"陆沉","sourceDefinition":"这段原文根本不存在","sourceChapterIndex":3}],
		"scenes":[{"name":"演武台","appearance":"汉白玉台"}],
		"props":[{"name":"神丹"}]
	}`
	chapters := []Chapter{{Index: 1, Title: "一", Text: "演武台上放着神丹。"}}
	scenes, err := ParseBibleForKind(raw, "scene", chapters...)
	if err != nil {
		t.Fatalf("broken character source must not block scene extraction: %v", err)
	}
	if len(scenes.Scenes) != 1 || len(scenes.Characters) != 0 {
		t.Fatalf("scene result = %+v", scenes)
	}
	props, err := ParseBibleForKind(raw, "prop", chapters...)
	if err != nil {
		t.Fatalf("broken character source must not block prop extraction: %v", err)
	}
	if len(props.Props) != 1 || len(props.Characters) != 0 || len(props.Scenes) != 0 {
		t.Fatalf("prop result = %+v", props)
	}
	if _, err := ParseBible(raw, chapters...); err == nil {
		t.Fatal("full parse must still reject a character source that is not in the chapters")
	}
}

func TestBibleExtractionPromptKeepsSkillChapterAndKindBoundary(t *testing.T) {
	chapters := []Chapter{
		{Index: 1, Title: "开篇", Text: "陆沉在演武台吞下神丹。"},
		{Index: 2, Title: "未选", Text: "这段不该进入本次来源。"},
	}
	skill := &WritingSkill{Name: "查漏技能", Path: "skills/bible.md", Content: "只记录原文写明的器物与地点。"}
	prompt := BibleExtractionPrompt("问道", Settings{StylePrompt: "国漫"}, chapters[:1], 4000, skill, "scene")
	for _, want := range []string{"查漏技能", "skills/bible.md", "只记录原文写明的器物与地点。", "[1]", "开篇", "陆沉在演武台吞下神丹。", "增量提取/重新查漏", "只抽取场景", "characters 与 props 必须为 []"} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("scene prompt missing %q", want)
		}
	}
	if strings.Contains(prompt, "这段不该进入本次来源。") {
		t.Fatal("prompt included a chapter that was not requested")
	}
	for _, want := range []string{"完整提取本次来源中实际出现", "不设置资产数量上限", "即使仅出现一次"} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("scoped prompt must request all production assets, missing %q", want)
		}
	}
	for _, restricted := range []string{"最多 24 个", "最多 20 个", "最多 16 个", "只保留反复出现"} {
		if strings.Contains(prompt, restricted) {
			t.Fatalf("scoped prompt must not carry the initial Bible restriction %q", restricted)
		}
		if !strings.Contains(BiblePrompt("问道", Settings{}, chapters, 4000, nil), restricted) {
			t.Fatalf("initial Bible must retain its restriction %q", restricted)
		}
	}
	system := BibleExtractionSystemPrompt("prop")
	for _, want := range []string{"作品圣经", "增量提取/重新查漏", "只抽取道具", "characters 与 scenes 必须为 []"} {
		if !strings.Contains(system, want) {
			t.Fatalf("system prompt missing %q: %s", want, system)
		}
	}
}
