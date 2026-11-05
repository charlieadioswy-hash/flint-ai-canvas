package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestGPT6ChatCompletionOutputLimitOnSharedProviderPaths(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	for _, tc := range []struct {
		name, interfaceType, path string
		agent, declarative        bool
	}{
		{"builtin text", "chat-completion", "/v1/chat/completions", false, false},
		{"builtin agent", "chat-completion", "/v1/chat/completions", true, false},
		{"wangsu openai text", "wangsu-openai-chat", "/v2/llm/openai/chat/completions", false, true},
		{"wangsu openai agent", "wangsu-openai-chat", "/v2/llm/openai/chat/completions", true, true},
	} {
		stream := tc.agent
		t.Run(fmt.Sprintf("%s/stream=%t", tc.name, stream), func(t *testing.T) {
			var calls atomic.Int32
			wantLimit := 512
			if tc.agent {
				wantLimit = 256
			}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				if r.Method != http.MethodPost || r.URL.Path != tc.path {
					t.Errorf("request = %s %s, want POST %s", r.Method, r.URL.Path, tc.path)
				}
				var body map[string]any
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				_, legacy := body["max_tokens"]
				if legacy || body["max_completion_tokens"] != float64(wantLimit) {
					t.Errorf("output fields: model=%v max_tokens=%v max_completion_tokens=%v, want %d", body["model"], body["max_tokens"], body["max_completion_tokens"], wantLimit)
					w.Header().Set("Content-Type", "application/json")
					w.WriteHeader(http.StatusBadRequest)
					fmt.Fprint(w, `{"error":{"message":"Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens' instead."}}`)
					return
				}
				if body["model"] != "gpt-6.1-sol" {
					t.Errorf("model changed: %#v", body["model"])
				}
				if stream {
					w.Header().Set("Content-Type", "text/event-stream")
					fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n\ndata: [DONE]\n\n")
					return
				}
				w.Header().Set("Content-Type", "application/json")
				fmt.Fprint(w, `{"choices":[{"message":{"content":"hello"}}]}`)
			}))
			defer server.Close()
			baseURL := server.URL
			if tc.interfaceType != "chat-completion" {
				baseURL += "/v2/llm"
			}
			input := canvasGenerationInput{
				Mode: "text", Prompt: "hello", StreamText: stream, MaxOutputTokens: 512,
				Config: providerConfig{BaseURL: baseURL, APIKey: "test-key", Model: "gpt-6.1-sol", InterfaceType: tc.interfaceType},
			}
			ctx := context.Background()
			if tc.declarative {
				ctx = withProtocolRegistry(ctx, loadOfficialFallbackRegistry())
			} else {
				ctx = withProtocolRegistry(ctx, emptyProtocolRegistry)
			}
			var result map[string]interface{}
			var err error
			if tc.agent {
				input.TextOptions.MaxOutputTokens = 256
				input.AgentRequests = &agentToolRequests{Canonical: &canonicalAgentRequest{
					Messages:   []map[string]interface{}{{"role": "user", "content": "hello"}},
					ToolChoice: "auto",
				}}
				result, err = runAgentToolTask(ctx, input)
			} else {
				result, err = runTextTask(ctx, input)
			}
			if err != nil || result["text"] != "hello" {
				t.Fatalf("result = %#v, err = %v", result, err)
			}
			if calls.Load() != 1 {
				t.Fatalf("request count = %d, want one without compatibility retry", calls.Load())
			}
		})
	}
}

func TestAgentOutputLimitProtocolAndModelFields(t *testing.T) {
	for _, tc := range []struct {
		model, wire, field string
	}{
		{"gpt-6.1-sol", "chat-completion", "max_completion_tokens"},
		{"openai/gpt-6.1-sol", "chat-completion", "max_completion_tokens"},
		{"GPT-6.1-SOL", "chat-completion", "max_completion_tokens"},
		{"gpt-5.4-mini", "chat-completion", "max_completion_tokens"},
		{"o1-mini", "chat-completion", "max_completion_tokens"},
		{"openai/o3", "chat-completion", "max_completion_tokens"},
		{"o4-mini", "chat-completion", "max_completion_tokens"},
		{"gpt-4.1", "chat-completion", "max_tokens"},
		{"gpt-4o", "chat-completion", "max_tokens"},
		{"deepseek-chat", "chat-completion", "max_tokens"},
		{"custom-gpt-6-alias", "chat-completion", "max_tokens"},
		{"gpt-6.1-sol", "responses", "max_output_tokens"},
		{"claude-sonnet", "claude-api", "max_tokens"},
	} {
		t.Run(tc.model+"/"+tc.wire, func(t *testing.T) {
			body := map[string]interface{}{"model": tc.model}
			applyAgentOutputLimit(body, 256, tc.wire)
			if body[tc.field] != 256 {
				t.Fatalf("output field = %#v, want %s=256", body, tc.field)
			}
			for _, key := range []string{"max_tokens", "max_completion_tokens", "max_output_tokens"} {
				if key != tc.field {
					if _, exists := body[key]; exists {
						t.Fatalf("conflicting output limit %s in %#v", key, body)
					}
				}
			}
		})
	}
}

func TestChatCompletionOutputLimitPreservesRequestLimits(t *testing.T) {
	for _, tc := range []struct {
		name  string
		body  map[string]interface{}
		limit int
		want  interface{}
	}{
		{"unbounded", map[string]interface{}{"model": "gpt-6.1-sol"}, 0, nil},
		{"inherited legacy limit", map[string]interface{}{"model": "gpt-6.1-sol", "max_tokens": 1024}, 0, 1024},
		{"host limit wins", map[string]interface{}{"model": "gpt-6.1-sol", "max_tokens": 2048, "max_completion_tokens": 1024}, 256, 256},
		{"explicit compatible field", map[string]interface{}{"model": "custom-model", "max_tokens": 2048, "max_completion_tokens": 1024}, 256, 256},
	} {
		t.Run(tc.name, func(t *testing.T) {
			applyAgentOutputLimit(tc.body, tc.limit, "chat-completion")
			if tc.body["max_completion_tokens"] != tc.want {
				t.Fatalf("max_completion_tokens = %#v, want %#v", tc.body["max_completion_tokens"], tc.want)
			}
			if _, exists := tc.body["max_tokens"]; exists {
				t.Fatalf("legacy field remains in %#v", tc.body)
			}
		})
	}
}
