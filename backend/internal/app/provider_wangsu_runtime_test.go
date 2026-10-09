package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"yingce/backend/internal/model"
	"yingce/backend/internal/protocol"
)

func TestProtocolBasePathURL(t *testing.T) {
	for _, tc := range []struct {
		base, path, want     string
		basePath, originPath bool
	}{
		{"https://example.com/v2/llm/", "/chat/completions", "https://example.com/v2/llm/chat/completions", true, false},
		{"https://example.com/v2/gws/route", "/openai/responses", "https://example.com/v2/gws/route/openai/responses", true, false},
		{"https://example.com/base/openai", "/images/generations", "https://example.com/base/openai/images/generations", true, false},
		{"https://example.com/base", "/messages", "https://example.com/base/messages", true, false},
		{"https://example.com", "/chat/completions", "https://example.com/v1/chat/completions", false, false},
		{"https://example.com/base", "/messages", "https://example.com/messages", false, true},
	} {
		t.Run(tc.want, func(t *testing.T) {
			got, err := protocolRequestURL(tc.base, protocol.RequestSpec{Path: tc.path, BasePath: tc.basePath, OriginPath: tc.originPath})
			if err != nil || got != tc.want {
				t.Fatalf("URL = %q, err = %v, want %q", got, err, tc.want)
			}
		})
	}
	got, err := protocolRequestURL("https://example.com/v2/llm", protocol.RequestSpec{Path: "/models/m:generateContent?alt=sse", BasePath: true, Query: map[string][]string{"mode": {"fast"}}})
	if err != nil || got != "https://example.com/v2/llm/models/m:generateContent?alt=sse&mode=fast" {
		t.Fatalf("query URL = %q, err = %v", got, err)
	}
	for _, base := range []string{"not-a-url", "https://user:secret@example.com/base", "https://example.com/base?key=secret", "https://example.com/base#fragment"} {
		if _, err := protocolRequestURL(base, protocol.RequestSpec{Path: "/messages", BasePath: true}); err == nil {
			t.Fatalf("ambiguous or credential-bearing base accepted: %q", base)
		}
	}
}

func TestProtocolBasePathKeepsOutboundPolicy(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "")
	t.Setenv("CANVAS_ALLOW_PRIVATE_UPSTREAMS", "")
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1) }))
	defer server.Close()
	_, err := executeProtocolRequest(context.Background(), providerConfig{BaseURL: server.URL + "/base", APIKey: "test-key"}, protocol.RequestSpec{Method: "POST", Path: "/messages", BasePath: true, ContentType: "application/json", Body: map[string]any{}})
	if err == nil || calls.Load() != 0 {
		t.Fatalf("private outbound was not blocked: calls = %d, err = %v", calls.Load(), err)
	}
}

func TestWangsuSystemProxyURLs(t *testing.T) {
	for _, tc := range []struct{ id, path, suffix string }{
		{"wangsu-chat", "/chat/completions", "/chat/completions"},
		{"wangsu-openai-chat", "/chat/completions", "/openai/chat/completions"},
		{"wangsu-responses", "/responses", "/responses"},
		{"wangsu-openai-responses", "/responses", "/openai/responses"},
		{"wangsu-anthropic", "/messages", "/anthropic/v1/messages"},
		{"wangsu-gemini", "/models/model:generateContent", "/gemini/v1beta/models/model:generateContent"},
		{"wangsu-gemini-image", "/models/model:streamGenerateContent", "/gemini/v1beta/models/model:streamGenerateContent"},
		{"wangsu-images", "/images/generations", "/images/generations"},
		{"wangsu-openai-images", "/images/edits", "/openai/images/edits"},
		{"wangsu-chat-image", "/chat/completions", "/chat/completions"},
		{"wangsu-audio", "/audio/speech", "/audio/speech"},
		{"wangsu-openai-audio", "/audio/speech", "/openai/audio/speech"},
	} {
		for _, base := range []string{"https://example.com/v2/llm", "https://example.com/v2/gws/route", "https://example.com/base/openai"} {
			if got := ChannelAPIURLForProtocol(base+"/", tc.path, model.ChannelInterfaceType(tc.id)); got != base+tc.suffix {
				t.Errorf("%s URL = %q, want %q", tc.id, got, base+tc.suffix)
			}
		}
		if got := ChannelAPIURLForProtocol("https://example.com/base", "/unsupported", model.ChannelInterfaceType(tc.id)); got != "" {
			t.Errorf("%s accepted unsupported operation: %q", tc.id, got)
		}
	}
	for _, id := range []string{"wangsu-videos", "wangsu-openai-videos"} {
		if got := ChannelAPIURLForProtocol("https://example.com/base", "/videos", model.ChannelInterfaceType(id)); got != "" {
			t.Errorf("%s accepted task-only operation: %q", id, got)
		}
	}
	if got := ChannelAPIURLForProtocol("https://example.com", "/chat/completions", model.ChannelInterfaceChatCompletion); got != "https://example.com/v1/chat/completions" {
		t.Errorf("legacy URL changed: %q", got)
	}
}

func TestWangsuTextAndAgentStreaming(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	for _, tc := range []struct{ id, path, wire, event string }{
		{"wangsu-chat", "/chat/completions", "chat-completion", "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n\n"},
		{"wangsu-openai-chat", "/openai/chat/completions", "chat-completion", "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n\n"},
		{"wangsu-responses", "/responses", "responses", "event: response.output_text.delta\ndata: {\"delta\":\"hello\"}\n\n"},
		{"wangsu-openai-responses", "/openai/responses", "responses", "event: response.output_text.delta\ndata: {\"delta\":\"hello\"}\n\n"},
		{"wangsu-anthropic", "/anthropic/v1/messages", "claude-api", "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"delta\":{\"type\":\"text_delta\",\"text\":\"hello\"}}\n\n"},
	} {
		for _, agent := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/agent=%v", tc.id, agent), func(t *testing.T) {
				auth := protocol.ManifestAuth{Type: "bearer"}
				header, credential := "Authorization", "Bearer test-key"
				if tc.wire == "claude-api" {
					auth.Type = "anthropic"
					header, credential = "x-api-key", "test-key"
				}
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if r.URL.Path != "/v2/gws/route"+tc.path || r.Header.Get(header) != credential || r.Header.Get("Accept") != "text/event-stream" {
						t.Errorf("unexpected request path or headers: %s %v", r.URL.Path, r.Header)
					}
					var body map[string]any
					if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
						t.Error(err)
						return
					}
					if body["stream"] != true {
						t.Errorf("stream not enabled: %#v", body)
					}
					if tc.wire == "chat-completion" {
						options, _ := body["stream_options"].(map[string]any)
						if options["include_usage"] != true {
							t.Errorf("stream usage not requested: %#v", body)
						}
						if agent && body["reasoning_effort"] != "medium" {
							t.Errorf("thinking not forwarded: %#v", body)
						}
						if agent && body["tool_choice"] != nil {
							t.Errorf("auto tool choice retained: %#v", body)
						}
					}
					if agent && tc.wire == "responses" && body["reasoning"] == nil {
						t.Errorf("Responses thinking not forwarded: %#v", body)
					}
					if agent && tc.wire == "claude-api" && body["thinking"] == nil {
						t.Errorf("Claude thinking not forwarded: %#v", body)
					}
					w.Header().Set("Content-Type", "text/event-stream")
					fmt.Fprint(w, tc.event)
				}))
				defer server.Close()
				var deltas strings.Builder
				input := canvasGenerationInput{Mode: "text", StreamText: true, Config: providerConfig{InterfaceType: tc.id, BaseURL: server.URL + "/v2/gws/route", APIKey: "test-key", Model: "model"}, OnTextDelta: func(delta string) { deltas.WriteString(delta) }}
				if agent {
					manifest := fmt.Sprintf(`{"apiVersion":"yingce.plugin/v1","id":%q,"version":"1.0.0","name":"Test","author":"Test","documentation":"# Test","contributes":{"providers":[{"id":%q,"label":"Test","auth":{"type":%q},"capabilities":["text"],"scopes":["agent"],"create":{"method":"POST","path":%q,"basePath":true},"agent":{"method":"POST","path":%q,"basePath":true,"body":{"model":"model","tool_choice":"auto"}},"agentResponse":{"textPaths":["text"]},"response":{}}]}}`, tc.id, tc.id, auth.Type, tc.path, tc.path)
					adapter, err := protocol.LoadManifest([]byte(manifest))
					if err != nil {
						t.Fatal(err)
					}
					registry, err := protocol.NewRegistry(adapter)
					if err != nil {
						t.Fatal(err)
					}
					input.AgentRequests = &agentToolRequests{}
					input.TextOptions.Thinking = true
					result, err := runAgentToolTask(withProtocolRegistry(context.Background(), registry), input)
					if err != nil || result["text"] != "hello" {
						t.Fatalf("result = %#v, err = %v", result, err)
					}
				} else {
					_, result, err := executeProtocolCreateRequest(context.Background(), input, protocol.RequestSpec{Method: "POST", Path: tc.path, BasePath: true, Auth: auth, ContentType: "application/json", Body: map[string]any{"model": "model"}})
					if err != nil || result == nil || result.Text != "hello" {
						t.Fatalf("result = %#v, err = %v", result, err)
					}
				}
				if deltas.String() != "hello" {
					t.Fatalf("deltas = %q", deltas.String())
				}
			})
		}
	}
}

func TestWangsuImageInputBoundaries(t *testing.T) {
	for _, id := range []string{"wangsu-images", "wangsu-openai-images"} {
		t.Run(id, func(t *testing.T) {
			input := canvasGenerationInput{Mode: "image", Config: providerConfig{InterfaceType: id, Size: "invalid"}}
			if _, err := runImageTask(context.Background(), input); err == nil || !strings.Contains(err.Error(), "尺寸") {
				t.Fatalf("invalid size escaped validation: %v", err)
			}
			input.Config.Size = "1:1"
			if got := protocolRequestFromInput(input).AspectRatio; got != "1024x1024" {
				t.Fatalf("size = %q", got)
			}
			input.Mask = &providerMedia{ID: "mask"}
			if _, err := runImageTask(context.Background(), input); err == nil || !strings.Contains(err.Error(), "源图片") {
				t.Fatalf("mask escaped validation: %v", err)
			}
		})
	}
}

func TestWangsuChannelWireFormat(t *testing.T) {
	for id, want := range map[string]string{"wangsu-gemini": "gemini", "wangsu-gemini-image": "gemini", "wangsu-anthropic": "claude", "wangsu-openai-chat": "openai"} {
		if got := channelAPIFormatForProtocol("openai", model.ChannelInterfaceType(id)); got != want {
			t.Fatalf("%s format = %q, want %q", id, got, want)
		}
	}
}

func TestWangsuTextAndAgentJSON(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	for _, tc := range []struct{ id, response string }{
		{"wangsu-chat", `{"choices":[{"message":{"content":"hello","reasoning_content":"thought","tool_calls":[{"id":"call-1","function":{"name":"lookup","arguments":"{}"}}]}}]}`},
		{"wangsu-openai-chat", `{"choices":[{"message":{"content":"hello","reasoning_content":"thought","tool_calls":[{"id":"call-1","function":{"name":"lookup","arguments":"{}"}}]}}]}`},
		{"wangsu-responses", `{"output":[{"type":"reasoning","summary":[{"type":"summary_text","text":"thought"}]},{"type":"message","content":[{"type":"output_text","text":"hel"},{"type":"output_text","text":"lo"}]},{"type":"function_call","id":"fc-1","call_id":"call-1","name":"lookup","arguments":"{}"}]}`},
		{"wangsu-openai-responses", `{"output":[{"type":"reasoning","summary":[{"type":"summary_text","text":"thought"}]},{"type":"message","content":[{"type":"output_text","text":"hel"},{"type":"output_text","text":"lo"}]},{"type":"function_call","id":"fc-1","call_id":"call-1","name":"lookup","arguments":"{}"}]}`},
		{"wangsu-anthropic", `{"content":[{"type":"thinking","thinking":"thought"},{"type":"text","text":"hel"},{"type":"text","text":"lo"},{"type":"tool_use","id":"call-1","name":"lookup","input":{}}]}`},
	} {
		for _, stream := range []bool{false, true} {
			for _, agent := range []bool{false, true} {
				t.Run(fmt.Sprintf("%s/stream=%v/agent=%v", tc.id, stream, agent), func(t *testing.T) {
					server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
						if r.URL.Path != "/base/text" {
							t.Errorf("path = %q", r.URL.Path)
						}
						w.Header().Set("Content-Type", "application/json")
						fmt.Fprint(w, tc.response)
					}))
					defer server.Close()
					// Deliberately narrow manifest mappings ensure the shared wire parser
					// handles nested text, reasoning and Responses item IDs in both modes.
					manifest := fmt.Sprintf(`{"apiVersion":"yingce.plugin/v1","id":%q,"version":"1.0.0","name":"Test","author":"Test","documentation":"# Test","contributes":{"providers":[{"id":%q,"label":"Test","capabilities":["text"],"scopes":["canvas","agent"],"create":{"method":"POST","path":"/text","basePath":true,"body":{"model":"model"}},"agent":{"method":"POST","path":"/text","basePath":true,"body":{"model":"model"}},"agentResponse":{"textPaths":["output_text"]},"response":{"textPaths":["output_text"]}}]}}`, tc.id, tc.id)
					adapter, err := protocol.LoadManifest([]byte(manifest))
					if err != nil {
						t.Fatal(err)
					}
					registry, err := protocol.NewRegistry(adapter)
					if err != nil {
						t.Fatal(err)
					}
					ctx := withProtocolRegistry(context.Background(), registry)
					input := canvasGenerationInput{Mode: "text", Prompt: "hello", StreamText: stream, Config: providerConfig{InterfaceType: tc.id, BaseURL: server.URL + "/base", APIKey: "test-key", Model: "model"}}
					var result map[string]interface{}
					if agent {
						input.AgentRequests = &agentToolRequests{}
						result, err = runAgentToolTask(ctx, input)
					} else {
						result, err = runTextTask(ctx, input)
					}
					if err != nil || result["text"] != "hello" || result["reasoning"] != "thought" {
						t.Fatalf("result = %#v, err = %v", result, err)
					}
					if agent {
						calls := interfaceSlice(result["toolCalls"])
						if len(calls) != 1 {
							t.Fatalf("tool calls = %#v", calls)
						}
						call, _ := calls[0].(map[string]interface{})
						if call["id"] != "call-1" {
							t.Fatalf("tool call = %#v", call)
						}
						if protocol.WangsuBaseProtocol(tc.id) == "openai-response" && call["item_id"] != "fc-1" {
							t.Fatalf("Responses item ID lost: %#v", call)
						}
					}
				})
			}
		}
	}
}

func TestDeclarativeKnownWireRejectsEmptyJSON(t *testing.T) {
	for _, wire := range []string{"chat-completion", "responses", "claude-api"} {
		if _, err := parseAgentToolResponse([]byte(`{}`), wire); err == nil {
			t.Fatalf("%s accepted an empty response", wire)
		}
		if _, err := parseAgentToolResponse([]byte(`{"error":{"message":"rejected"}}`), wire); err == nil {
			t.Fatalf("%s accepted a provider error", wire)
		}
	}
}
