package app

import (
	"strconv"
	"strings"
)

func chatCompletionOutputLimitField(model string) string {
	name := strings.ToLower(strings.TrimSpace(model))
	if index := strings.LastIndexByte(name, '/'); index >= 0 {
		name = name[index+1:]
	}
	for _, family := range []string{"o1", "o3", "o4"} {
		if name == family || strings.HasPrefix(name, family+"-") {
			return "max_completion_tokens"
		}
	}
	if strings.HasPrefix(name, "gpt-") {
		major, _, _ := strings.Cut(strings.TrimPrefix(name, "gpt-"), ".")
		major, _, _ = strings.Cut(major, "-")
		if version, err := strconv.Atoi(major); err == nil && version >= 5 {
			return "max_completion_tokens"
		}
	}
	return "max_tokens"
}

// Normalize both host limits and limits inherited from declarative Agent bodies
// before sending; GPT-5+ and o-series reject the legacy max_tokens field.
func applyChatCompletionOutputLimit(body map[string]interface{}, limit int) {
	model, _ := body["model"].(string)
	field := chatCompletionOutputLimitField(model)
	if _, explicit := body["max_completion_tokens"]; explicit {
		field = "max_completion_tokens"
	}
	if field == "max_completion_tokens" {
		if previous, exists := body["max_tokens"]; exists {
			if _, explicit := body[field]; !explicit {
				body[field] = previous
			}
			delete(body, "max_tokens")
		}
	}
	applyTextOutputLimit(body, limit, field)
}
