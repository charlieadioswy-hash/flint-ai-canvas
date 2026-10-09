package protocol

import (
	"regexp"
	"strings"
)

// WangsuBaseProtocol shares wire parsing and input constraints with the named
// protocol. It does not select adapters, change stored IDs, or rewrite URLs.
func WangsuBaseProtocol(id string) string {
	id = strings.TrimSpace(id)
	switch id {
	case "wangsu-chat", "wangsu-openai-chat":
		return "chat-completion"
	case "wangsu-responses", "wangsu-openai-responses":
		return "openai-response"
	case "wangsu-anthropic":
		return "claude-api"
	case "wangsu-gemini":
		return "gemini-generate-content"
	case "wangsu-gemini-image":
		return "gemini-image"
	case "wangsu-images", "wangsu-openai-images":
		return "openai-image"
	case "wangsu-videos", "wangsu-openai-videos":
		return "newapi"
	case "wangsu-audio", "wangsu-openai-audio":
		return "openai-audio"
	default:
		return id
	}
}

var wangsuGeminiProxyPath = regexp.MustCompile(`^/models/[^/:]+:(generateContent|streamGenerateContent)$`)

// WangsuProxyPath translates a selected provider's public proxy operation.
// A true second result with an empty path rejects unsupported operations;
// false means this is not a Wangsu provider. Async video stays task-only.
func WangsuProxyPath(id, path string) (string, bool) {
	path = strings.TrimSpace(path)
	prefix := ""
	allowed := false
	switch strings.TrimSpace(id) {
	case "wangsu-chat", "wangsu-chat-image":
		allowed = path == "/chat/completions"
	case "wangsu-openai-chat":
		prefix, allowed = "/openai", path == "/chat/completions"
	case "wangsu-responses":
		allowed = path == "/responses"
	case "wangsu-openai-responses":
		prefix, allowed = "/openai", path == "/responses"
	case "wangsu-anthropic":
		prefix, allowed = "/anthropic/v1", path == "/messages"
	case "wangsu-gemini", "wangsu-gemini-image":
		prefix, allowed = "/gemini/v1beta", wangsuGeminiProxyPath.MatchString(path)
	case "wangsu-images":
		allowed = path == "/images/generations" || path == "/images/edits"
	case "wangsu-openai-images":
		prefix, allowed = "/openai", path == "/images/generations" || path == "/images/edits"
	case "wangsu-audio":
		allowed = path == "/audio/speech"
	case "wangsu-openai-audio":
		prefix, allowed = "/openai", path == "/audio/speech"
	case "wangsu-videos", "wangsu-openai-videos":
		return "", true
	default:
		return "", false
	}
	if !allowed && path != "/models" {
		return "", true
	}
	return prefix + path, true
}
