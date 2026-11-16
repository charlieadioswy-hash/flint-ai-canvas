package production

import (
	"strings"
	"testing"
)

func TestStylePromptLimitsPreserveCompleteInstructions(t *testing.T) {
	for _, prompt := range []string{strings.Repeat("水", 1400) + "系统风格的完整末尾约束", strings.Repeat("🎨", MaxStylePromptRunes)} {
		settings := Settings{StylePrompt: prompt}
		if err := settings.ValidateStylePrompt(); err != nil {
			t.Fatal(err)
		}
		if settings.Normalized().StylePrompt != prompt {
			t.Fatal("normalization truncated a valid full style prompt")
		}
	}
	if err := (Settings{StylePrompt: strings.Repeat("🎨", MaxStylePromptRunes+1)}).ValidateStylePrompt(); err == nil {
		t.Fatal("oversized style prompt accepted")
	}
}
