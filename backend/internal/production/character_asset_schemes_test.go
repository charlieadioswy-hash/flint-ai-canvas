package production

import (
	"strings"
	"testing"
)

func TestCharacterAssetSchemesMatchCompositeLayouts(t *testing.T) {
	cases := []struct {
		mode, name, ratio string
		layout            []string
	}{
		{AssetModeNone, "不使用", "16:9", []string{"单幅单人构图", "不安排重复视角"}},
		{AssetModeCloseupTurnaround, "单特写+三视图", "16:9", []string{"左侧约占 40%", "右侧约占 60%", "均保留头部", "正面全身、右侧面全身、背面全身"}},
		{AssetModeCloseupFrontNoFace, "单特写+正面无面部", "16:9", []string{"左侧约占 2/3", "右侧约占 1/3", "整个头部不在右区内"}},
		{AssetModeCloseupTurnaroundNoHead, "单特写+三视图无头部", "16:9", []string{"三张无头身体图", "完全不包含头部"}},
		{AssetModeCloseupFullbody, "单特写+全身", "16:9", []string{"保留完整头部和双脚", "不使用无头服装身体图"}},
		{AssetModeDualCloseupFrontBackNoHead, "双特写+正背面无头部", "9:16", []string{"总高度 30%", "总高度 70%", "正面无头身体、背面无头身体"}},
		{AssetModeTripleCloseupFrontNoFace, "面部三特写+正面无面部", "16:9", []string{"左列一张大幅正面头肩主特写", "中列一张", "全图共四张面孔"}},
		{AssetModeTurnaroundTripleCloseup, "三视图+脸部三特写", "16:9", []string{"三个完整全身视角加三个头肩特写", "不要增加左侧主脸大特写"}},
		{AssetModeTurnaroundFiveAngleHalfbody, "三视图+五角度半身照", "16:9", []string{"上行两张、下行三张", "三个全身视角加五个半身视角"}},
		{AssetModeHeadshotFullbody, "大头照+全身照", "16:9", []string{"仅从头顶到下巴", "不含肩膀、衣领或上半身", "不要给右侧身体补画头部"}},
	}
	schemes := AssetSchemes()
	if len(schemes) != len(cases) {
		t.Fatalf("catalog has %d items, want %d", len(schemes), len(cases))
	}
	seen := map[string]bool{}
	for i, want := range cases {
		t.Run(want.mode, func(t *testing.T) {
			scheme := schemes[i]
			if scheme.Mode != want.mode || scheme.Name != want.name || scheme.Ratio != want.ratio || seen[scheme.CharacterPrompt] {
				t.Fatalf("wrong or duplicate composition: %+v", scheme)
			}
			seen[scheme.CharacterPrompt] = true
			settings := AssetSettings{Mode: want.mode, CharacterRatio: "1:1"}.Normalized()
			if settings.Mode != want.mode || settings.CharacterRatio != want.ratio || ValidateAssetPrompts(settings) != "" {
				t.Fatalf("catalog mode not preserved by settings: %+v", settings)
			}
			prompt := CastImagePrompt(settings, "character", "林逸", "短发，黑色外套", "写实摄影", "柔和光线")
			for _, text := range append(want.layout, AssetImageOutputContract, "林逸", "黑色外套", "写实摄影", "柔和光线") {
				if !strings.Contains(prompt, text) {
					t.Fatalf("composition missing %q:\n%s", text, prompt)
				}
			}
			if strings.Contains(prompt, "{{") || strings.Count(prompt, AssetImageOutputContract) != 1 || !strings.Contains(settings.FrameHint(), "参考图") {
				t.Fatalf("invalid rendered contract or reference hint:\n%s", prompt)
			}
		})
	}
}

func TestCharacterAssetSettingsDefaultAndCustomContract(t *testing.T) {
	for _, input := range []AssetSettings{{}, {Mode: "invalid"}, {Mode: AssetModeCustom}} {
		settings := input.Normalized()
		if settings.Mode != AssetModeCloseupTurnaround || !strings.Contains(settings.CharacterPrompt, "单特写+三视图") {
			t.Fatalf("new draft must default to catalog composition: %+v", settings)
		}
	}
	settings := AssetSettings{Mode: AssetModeCustom, CharacterRatio: "3:4", CharacterPrompt: "{{角色名称}}，只有一个正面角色"}.Normalized()
	prompt := CastImagePrompt(settings, "character", "林逸", "黑发", "写实", "")
	if settings.Mode != AssetModeCustom || settings.CharacterRatio != "3:4" || !strings.Contains(prompt, "只有一个正面角色") || strings.Contains(prompt, "三视图") {
		t.Fatalf("custom composition was replaced: %+v %s", settings, prompt)
	}
	if again := WithAssetImageOutputContract(prompt); again != prompt || strings.Count(again, AssetImageOutputContract) != 1 {
		t.Fatal("single-image contract must be idempotent")
	}
	for _, mode := range []string{"", "saved-layout"} {
		settings := AssetSettings{Mode: mode, CharacterRatio: "9:16", CharacterPrompt: "{{角色名称}}，已有保存的参考图构图"}.Normalized()
		if settings.Mode != AssetModeCustom || settings.CharacterRatio != "9:16" || settings.CharacterPrompt != "{{角色名称}}，已有保存的参考图构图" {
			t.Fatalf("saved prompt with unknown mode must stay custom: %+v", settings)
		}
	}
}
