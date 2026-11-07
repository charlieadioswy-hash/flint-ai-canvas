package production

import (
	"strings"
	"testing"
)

const definedCharacterExample = "1. 秦子文\n\n年龄：26岁\n\n性格：冷静谨慎，务实有主见\n\n背景：父母出事后，秦子文承担起照顾弟弟的责任，放弃原本的保研机会，工作供弟弟读书。刚买下市中心的房子，小区便整体穿越倒了森林。"

func TestBiblePromptReusesExplicitDefinitionWithVerifiableSource(t *testing.T) {
	chapters := []Chapter{{Index: 3, Title: "角色与正文", Text: definedCharacterExample}}
	prompt := BiblePrompt("森林家园", Settings{}, chapters, 40000, &WritingSkill{Name: "改编方法", Path: "SKILL.md", Content: "重新设计每个人物的背景和外貌"})
	for _, want := range []string{
		"sourceDefinition 逐字引用输入中实际可见",
		"必须包含对应的角色姓名标题、表格姓名列或文内姓名",
		"sourceChapterIndex 填该原文所属方括号章节序号",
		`"sourceDefinition":`,
		`"sourceChapterIndex":`,
		"## [3] 角色与正文",
		"年龄：26岁\n\n性格：冷静谨慎，务实有主见\n\n背景：父母出事后，秦子文承担起照顾弟弟的责任",
		"小区便整体穿越倒了森林。",
		"description 逐字复用",
		"说明中没有的字段留空",
		"角色说明复用规则优先于写作技能",
		"每个值只能逐字摘取 sourceDefinition 内的连续原文片段，不拼接、不推断",
		"不得拼接不同段落、虚构引文或引用未出现在本次输入中的内容",
	} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("bible prompt missing %q", want)
		}
	}
}

func TestBiblePromptWithoutDefinitionStillExtractsFromSource(t *testing.T) {
	text := "秦子文扶起弟弟，低声说：“先找到水源。”他的蓝色外套沾满尘土。"
	prompt := BiblePrompt("森林家园", Settings{}, []Chapter{{Index: 1, Title: "第一章", Text: text}}, 40000, nil)
	if !strings.Contains(prompt, text) || !strings.Contains(prompt, "只有没有明确角色说明的角色，才根据文档正文抽取") {
		t.Fatalf("ordinary source extraction must remain available: %s", prompt)
	}
	if !strings.Contains(prompt, "此时 sourceDefinition 留空、sourceChapterIndex 为 0") {
		t.Fatal("ordinary prose must use extraction without a fabricated explicit definition")
	}
}

func TestBiblePromptDoesNotRequireFixedDefinitionFormat(t *testing.T) {
	for name, text := range map[string]string{
		"numbered":  definedCharacterExample,
		"markdown":  "### 秦子文\n26岁。冷静谨慎，务实有主见。为照顾弟弟放弃保研。",
		"colon":     "秦子文：26岁，冷静谨慎，务实有主见，为照顾弟弟放弃保研。",
		"table":     "| 姓名 | 年龄 | 性格 |\n| 秦子文 | 26岁 | 冷静谨慎，务实有主见 |",
		"biography": "人物小传：秦子文今年26岁，冷静谨慎，务实有主见。他在父母出事后承担起照顾弟弟的责任。",
	} {
		t.Run(name, func(t *testing.T) {
			prompt := BiblePrompt("森林家园", Settings{}, []Chapter{{Index: 1, Title: "角色资料", Text: text}}, 40000, nil)
			if !strings.Contains(prompt, text) || !strings.Contains(prompt, "角色说明不限定格式") || !strings.Contains(prompt, "不能仅因缺少固定标题或字段而忽略已有说明") {
				t.Fatalf("definition format must be passed through for source-backed recognition: %s", prompt)
			}
		})
	}
}

func TestScriptPromptReusesCharacterDefinitionWithoutGuessing(t *testing.T) {
	prompt := ScriptPrompt(ScriptContext{
		CastSummary:    "- 秦子文：年龄：26岁；性格：冷静谨慎，务实有主见",
		SourceChapters: []Chapter{{Index: 1, Title: "角色与第一集", Text: definedCharacterExample}},
		Skill:          &WritingSkill{Name: "分镜方法", Path: "SKILL.md", Content: "根据身份设计角色服装"},
	})
	for _, want := range []string{"已确认的角色说明直接沿用", "不为缺失字段补设定", "只有没有明确角色说明的新角色才从正文抽取", "该规则优先于写作技能", "年龄：26岁\n\n性格：冷静谨慎，务实有主见"} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("script prompt missing %q", want)
		}
	}
	if strings.Contains(prompt, "原文未写明的按身份合理补全") {
		t.Fatal("script must not request invented character details")
	}
}
