package production

import (
	"strings"
	"testing"
)

func TestSegmentDraftRemainsStableWhenAssetAppearanceOrVoiceChanges(t *testing.T) {
	in := SegmentPromptInput{
		Title: "雨夜交接", Count: 1,
		References: []SegmentReference{
			{Kind: "character", Name: "陆沉", Label: "参考图1", Detail: "旧外观银发青衫", Voice: "旧音色低沉沙哑"},
			{Kind: "scene", Name: "客栈", Label: "参考图2", Detail: "旧陈设红漆柜台"},
			{Kind: "prop", Name: "令牌", Label: "参考图3", Detail: "旧材质玄铁"},
		},
		Shots: []SegmentShot{{
			Scene: "客栈", ImagePrompt: "陆沉站在门边，右袖被划破",
			Action: "陆沉用左手把令牌放在桌上", VideoPrompt: "陆沉压低声音，眉头紧锁",
			Speaker: "陆沉", Dialogue: "拿着它，快走。", DurationMs: 5000,
		}},
	}
	before := SegmentVideoPrompt(in)
	in.References[0].Detail, in.References[0].Voice = "新外观黑发白衣", "新音色清亮"
	in.References[1].Detail, in.References[2].Detail = "新陈设青石柜台", "新材质黄铜"
	if after := SegmentVideoPrompt(in); after != before {
		t.Fatalf("asset edits changed the narrative draft:\nbefore:\n%s\nafter:\n%s", before, after)
	}
	for _, text := range []string{"陆沉（参考图1）", "客栈（参考图2）", "令牌（参考图3）", "右袖被划破", "左手把令牌放在桌上", "压低声音，眉头紧锁", "拿着它，快走。", "【00.00—05.00秒"} {
		if !strings.Contains(before, text) {
			t.Errorf("narrative or asset binding lost: %q", text)
		}
	}
	for _, text := range []string{"旧外观", "旧音色", "旧陈设", "旧材质"} {
		if strings.Contains(before, text) {
			t.Errorf("asset setting frozen into narrative: %q", text)
		}
	}
}

func TestSegmentWriterSeparatesAssetSettingsFromNarrative(t *testing.T) {
	in := SegmentPromptInput{Count: 1, Shots: []SegmentShot{{DurationMs: 5000}}}
	prompt := SegmentWriterPrompt(in, "素材", "旧外观设定与剧情状态混在上一段结尾", &WritingSkill{
		Name: "自由格式", Content: "每次写人物完整外貌和声线规格",
	})
	for _, text := range []string{
		"【硬性规则】始终适用", "由视频生成时提供最新设定，不在段稿中复述或编造",
		"即使素材稿或上一段结尾含有这些固定设定", "剧情必需的换装、受伤、道具接触等临时状态必须保留",
		"每句台词标明说话人此刻的情绪与说话方式", "台词逐字使用素材稿中的台词",
	} {
		if !strings.Contains(prompt, text) {
			t.Errorf("writer lost the narrative/asset boundary: %q", text)
		}
	}
	if !strings.Contains(SegmentWriterSystemPrompt(), "生成时提供的最新资产设定") {
		t.Fatal("system prompt must not describe a standalone asset snapshot")
	}
}

func TestShotPromptStillUsesLatestDynamicAssetSettings(t *testing.T) {
	in := shotPromptFixture()
	in.Segment.References[0].Detail = "最新场景陈设"
	in.Segment.References[1].Detail, in.Segment.References[1].Voice = "最新角色外观", "最新角色声线"
	in.Segment.References[2].Detail = "最新道具材质"
	prompt := ShotVideoPrompt(in)
	for _, text := range []string{"最新场景陈设", "最新角色外观", "最新角色声线", "最新道具材质"} {
		if !strings.Contains(prompt, text) {
			t.Errorf("dynamic single-shot asset setting lost: %q", text)
		}
	}
	for _, text := range []string{"纸窗透入冷月光", "青色长衫", "清冷青年音", "黄铜材质"} {
		if strings.Contains(prompt, text) {
			t.Errorf("old asset setting reused: %q", text)
		}
	}
}
