package production

import (
	"strings"
	"testing"
)

func TestDirectorTemplateAndTargetReachScriptPrompt(t *testing.T) {
	s := StoryboardSettings{DirectorTemplate: "smart_drama", ShotCountMode: ShotCountFixed, TargetShotCount: 80}
	if s.ShotTarget(300) != 80 {
		t.Fatal("custom target ignored")
	}
	prompt := ScriptPrompt(ScriptContext{Settings: Settings{Storyboard: s}, Skill: &WritingSkill{Name: "自选技能", Content: "沿原文拆镜"}})
	if !strings.Contains(prompt, "智能导演·剧集版") || !strings.Contains(prompt, "必须恰好输出 80 镜") || !strings.Contains(prompt, "沿原文拆镜") {
		t.Fatal("template, exact count or chosen skill missing")
	}
	if (StoryboardSettings{TargetShotCount: 241}).ValidateDirector() == nil || (StoryboardSettings{DirectorTemplate: "invented"}).ValidateDirector() == nil {
		t.Fatal("invalid rules accepted")
	}
	if (StoryboardSettings{GenerationMode: "invented"}).ValidateDirector() == nil {
		t.Fatal("invalid generation mode accepted")
	}
	for _, camera := range []string{"无运镜", "推镜头", "拉镜头", "摇镜头", "移镜头", "跟镜头", "环绕镜头", "升镜头", "航拍镜头", "手持镜头", "荷兰角镜头", "希区柯克镜头", "POV镜头", "FPV镜头"} {
		if CameraPresetRule(camera) == "" || cameraMoveText(5, camera) == "" {
			t.Errorf("camera preset ignored: %s", camera)
		}
	}
}

func TestShotCountModesValidateAndNormalize(t *testing.T) {
	for _, test := range []struct {
		name      string
		settings  StoryboardSettings
		wantMode  string
		wantFixed bool
		wantError bool
	}{
		{name: "default estimate", wantMode: ShotCountSmart},
		{name: "saved reference without mode", settings: StoryboardSettings{TargetShotCount: 27}, wantMode: ShotCountSmart},
		{name: "smart reference", settings: StoryboardSettings{ShotCountMode: ShotCountSmart, TargetShotCount: 27}, wantMode: ShotCountSmart},
		{name: "fixed target", settings: StoryboardSettings{ShotCountMode: ShotCountFixed, TargetShotCount: 27}, wantMode: ShotCountFixed, wantFixed: true},
		{name: "fixed missing target", settings: StoryboardSettings{ShotCountMode: ShotCountFixed}, wantMode: ShotCountFixed, wantError: true},
		{name: "unknown mode", settings: StoryboardSettings{ShotCountMode: "invented", TargetShotCount: 27}, wantMode: ShotCountSmart, wantError: true},
		{name: "negative reference", settings: StoryboardSettings{TargetShotCount: -1}, wantMode: ShotCountSmart, wantError: true},
		{name: "reference exceeds bound", settings: StoryboardSettings{TargetShotCount: MaxScriptShots + 1}, wantMode: ShotCountSmart, wantError: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			if err := test.settings.ValidateDirector(); (err != nil) != test.wantError {
				t.Fatalf("ValidateDirector() = %v; want error %t", err, test.wantError)
			}
			normalized := test.settings.Normalized()
			if normalized.ShotCountMode != test.wantMode || normalized.TargetShotCount != test.settings.TargetShotCount {
				t.Fatalf("normalization changed mode or reference unexpectedly: %+v", normalized)
			}
			if test.settings.HasFixedShotCount() != test.wantFixed || normalized.HasFixedShotCount() != test.wantFixed {
				t.Fatalf("HasFixedShotCount() must only enforce an explicit fixed target: %+v", test.settings)
			}
		})
	}
}

func TestSmartShotCountIsOnlyAReferenceInScriptPrompt(t *testing.T) {
	for _, mode := range []string{"", ShotCountSmart, ShotCountFixed} {
		for _, format := range []string{SourceNovel, SourceScript, SourceStoryboard} {
			t.Run(mode+"/"+format, func(t *testing.T) {
				settings := Settings{EpisodeSeconds: 60, Storyboard: StoryboardSettings{
					ShotCountMode: mode, TargetShotCount: 27,
				}}
				prompt := ScriptPrompt(ScriptContext{Settings: settings, SourceFormat: format})
				exact := strings.Contains(prompt, "必须恰好输出 27 镜")
				reference := strings.Contains(prompt, "镜头数仅作参考，不是强制数量")
				if format == SourceStoryboard {
					if exact || reference || !strings.Contains(prompt, "镜头数与原分镜一致") {
						t.Fatal("imported storyboard must retain source shot count in every mode")
					}
					return
				}
				if mode == ShotCountFixed {
					if !exact || reference {
						t.Fatal("fixed mode must explicitly request the configured number")
					}
					return
				}
				if exact || !reference || !strings.Contains(prompt, "27 个") || !strings.Contains(prompt, "不为凑数删减情节、台词或新增内容") {
					t.Fatal("smart mode must preserve the numeric reference without forcing the output count")
				}
			})
		}
	}

	settings := Settings{EpisodeSeconds: 60, Storyboard: StoryboardSettings{ShotCountMode: ShotCountSmart, Pacing: PacingFast}}
	prompt := ScriptPrompt(ScriptContext{Settings: settings})
	if !strings.Contains(prompt, "约 24 个镜头") || !strings.Contains(prompt, "镜头数仅作参考，不是强制数量") {
		t.Fatal("smart mode without a reference must estimate shots from duration and pacing")
	}
}
