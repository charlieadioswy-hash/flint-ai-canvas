package production

import (
	"strings"
	"testing"
)

func TestSceneAssetSchemesRenderTheSelectedFullPrompt(t *testing.T) {
	for _, scheme := range SceneAssetSchemes() {
		settings := AssetSettings{ScenePrompt: scheme.Prompt}.Normalized()
		if issue := ValidateAssetPrompts(settings); issue != "" {
			t.Fatalf("invalid built-in template %s: %s", scheme.ID, issue)
		}
		prompt := CastImagePrompt(settings, "scene", "秦家客厅", "窄窗、木桌与两扇门", "写实电影", "无字幕")
		for _, want := range []string{"秦家客厅", "窄窗、木桌与两扇门", "写实电影", "无字幕"} {
			if !strings.Contains(prompt, want) {
				t.Fatalf("selected template %s lost %q: %s", scheme.ID, want, prompt)
			}
		}
		if strings.Contains(prompt, "{{") {
			t.Fatalf("unexpanded variables in %s: %s", scheme.ID, prompt)
		}
		if strings.Count(prompt, AssetImageOutputContract) != 1 {
			t.Fatalf("scene layout must remain one complete image: %s", prompt)
		}
		if scheme.ID == "fourview" && !strings.Contains(prompt, "2×2") {
			t.Fatal("fourview template was replaced by the default scene prompt")
		}
	}
}
