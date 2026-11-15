package production

import (
	"strings"
	"testing"
)

func TestDirectorTemplateAndTargetReachScriptPrompt(t *testing.T) {
	s := StoryboardSettings{DirectorTemplate: "smart_drama", TargetShotCount: 80}
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
