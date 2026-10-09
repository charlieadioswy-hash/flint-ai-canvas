package protocol

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

const wangsuTestImage = "data:image/png;base64,aGVsbG8="

func wangsuTestAdapter(t *testing.T, id string) Adapter {
	t.Helper()
	return officialPackageAdapter(t, "wangsu.yingce-plugin", id)
}

func wangsuTestCreate(t *testing.T, id string, request GenerationRequest) (RequestSpec, map[string]any) {
	t.Helper()
	spec, err := wangsuTestAdapter(t, id).BuildCreate(context.Background(), RequestContext{
		BaseURL: "https://gateway.example/v2/gws/test-gateway", Request: request,
	})
	if err != nil {
		t.Fatal(err)
	}
	return spec, manifestTestBody(t, spec)
}

func wangsuTestJSON(t *testing.T, got any, want string) {
	t.Helper()
	data, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	var actual, expected any
	if err := json.Unmarshal(data, &actual); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(want), &expected); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(actual, expected) {
		t.Errorf("JSON = %s, want %s", data, want)
	}
}

// Paths are taken from the gateway docs, including Anthropic's /v1 and
// Gemini's /v1beta; OpenAI paths must not gain another /v1 segment.
func TestWangsuProvidersPreserveGatewayBasePathAndAuthentication(t *testing.T) {
	tests := []struct {
		id, path, auth, contentType string
		capability                  Capability
	}{
		{"wangsu-chat", "/chat/completions", "bearer", "application/json", CapabilityText},
		{"wangsu-responses", "/responses", "bearer", "application/json", CapabilityText},
		{"wangsu-openai-chat", "/openai/chat/completions", "bearer", "application/json", CapabilityText},
		{"wangsu-openai-responses", "/openai/responses", "bearer", "application/json", CapabilityText},
		{"wangsu-anthropic", "/anthropic/v1/messages", "anthropic", "application/json", CapabilityText},
		{"wangsu-gemini", "/gemini/v1beta/models/test-model:generateContent", "google-api-key", "application/json", CapabilityText},
		{"wangsu-images", "/images/generations", "bearer", "application/json", CapabilityImage},
		{"wangsu-openai-images", "/openai/images/generations", "bearer", "application/json", CapabilityImage},
		{"wangsu-gemini-image", "/gemini/v1beta/models/test-model:generateContent", "google-api-key", "application/json", CapabilityImage},
		{"wangsu-chat-image", "/chat/completions", "bearer", "application/json", CapabilityImage},
		{"wangsu-videos", "/videos", "bearer", "application/json", CapabilityVideo},
		{"wangsu-openai-videos", "/openai/videos", "bearer", "multipart/form-data", CapabilityVideo},
		{"wangsu-audio", "/audio/speech", "bearer", "application/json", CapabilityAudio},
		{"wangsu-openai-audio", "/openai/audio/speech", "bearer", "application/json", CapabilityAudio},
	}
	for _, tt := range tests {
		t.Run(tt.id, func(t *testing.T) {
			spec, _ := wangsuTestCreate(t, tt.id, GenerationRequest{
				Model: "test-model", Capability: tt.capability, Prompt: "hello", AspectRatio: "16:9", Duration: 8,
			})
			if spec.Method != "POST" || spec.Path != tt.path || !spec.BasePath || spec.OriginPath {
				t.Errorf("gateway request = %#v", spec)
			}
			if spec.Auth.Type != tt.auth || spec.Auth.Field != "apiKey" || spec.ContentType != tt.contentType {
				t.Errorf("auth/content type = %#v / %q", spec.Auth, spec.ContentType)
			}
		})
	}
}

func TestWangsuTextResponsesUseDocumentedWireShapes(t *testing.T) {
	tests := []struct{ id, payload, text string }{
		{"wangsu-chat", `{"choices":[{"message":{"content":"chat result"}}],"usage":{"total_tokens":3}}`, "chat result"},
		{"wangsu-openai-chat", `{"choices":[{"message":{"content":"native result"}}]}`, "native result"},
		{"wangsu-responses", `{"output":[{"type":"reasoning","summary":[]},{"type":"message","content":[{"type":"output_text","text":"nested result"}]}],"usage":{"total_tokens":3}}`, "nested result"},
		{"wangsu-openai-responses", `{"output":[{"type":"message","content":[{"type":"output_text","text":"native nested"}]}]}`, "native nested"},
		{"wangsu-anthropic", `{"content":[{"type":"text","text":"anthropic result"}],"usage":{"input_tokens":2,"output_tokens":1}}`, "anthropic result"},
		{"wangsu-gemini", `{"candidates":[{"content":{"parts":[{"text":"gemini result"}]}}],"usageMetadata":{"totalTokenCount":3}}`, "gemini result"},
	}
	for _, tt := range tests {
		t.Run(tt.id, func(t *testing.T) {
			result, err := wangsuTestAdapter(t, tt.id).ParseCreate(context.Background(), []byte(tt.payload))
			if err != nil {
				t.Fatal(err)
			}
			if result.Status != StatusSucceeded || result.Result == nil || result.Result.Text != tt.text {
				t.Fatalf("text result = %#v (content %#v)", result, result.Result)
			}
		})
	}
}

func TestWangsuGeminiPreservesHistoryAndReferenceParts(t *testing.T) {
	_, body := wangsuTestCreate(t, "wangsu-gemini", GenerationRequest{
		Model: "gemini-2.5-flash", Prompt: "describe this", Instructions: "be concise",
		Messages: []Message{{Role: "user", Content: "remember blue"}, {Role: "assistant", Content: "remembered"}},
		Images:   []MediaReference{{DataURL: wangsuTestImage, MIMEType: "image/png", Role: "reference_image"}},
	})
	wangsuTestJSON(t, body["contents"], `[{"role":"user","parts":[{"text":"remember blue"}]},{"role":"model","parts":[{"text":"remembered"}]},{"role":"user","parts":[{"text":"describe this"},{"inlineData":{"mimeType":"image/png","data":"aGVsbG8="}}]}]`)
	wangsuTestJSON(t, body["systemInstruction"], `{"parts":[{"text":"be concise"}]}`)

	_, imageBody := wangsuTestCreate(t, "wangsu-gemini-image", GenerationRequest{
		Model: "gemini-3-pro-image", Prompt: "redraw", AspectRatio: "16:9", Quality: "2k",
		Images: []MediaReference{{DataURL: wangsuTestImage, Role: "edit_source"}},
	})
	wangsuTestJSON(t, imageBody["contents"], `[{"role":"user","parts":[{"text":"redraw"},{"inlineData":{"mimeType":"image/png","data":"aGVsbG8="}}]}]`)
	config := imageBody["generationConfig"].(map[string]any)
	wangsuTestJSON(t, config["imageConfig"], `{"aspectRatio":"16:9","imageSize":"2K"}`)
	for _, wirePart := range []string{`{"inlineData":{"mimeType":"image/png","data":"aGVsbG8="}}`, `{"inline_data":{"mime_type":"image/png","data":"aGVsbG8="}}`} {
		result, err := wangsuTestAdapter(t, "wangsu-gemini-image").ParseCreate(context.Background(), []byte(`{"candidates":[{"content":{"parts":[`+wirePart+`]}}]}`))
		if err != nil || result.Result == nil || len(result.Result.Images) != 1 || result.Result.Images[0].DataURL != wangsuTestImage {
			t.Fatalf("Gemini image = %#v / %v", result.Result, err)
		}
	}
}

func TestWangsuChatImageUsesImageURLContentAndECASizing(t *testing.T) {
	_, body := wangsuTestCreate(t, "wangsu-chat-image", GenerationRequest{
		Model: "gemini-3-pro-image", Prompt: "redraw", AspectRatio: "16:9", Quality: "2k",
		Images: []MediaReference{{DataURL: wangsuTestImage, Role: "edit_source"}},
	})
	wangsuTestJSON(t, body["eca_image_config"], `{"aspect_ratio":"16:9","image_size":"2K"}`)
	wangsuTestJSON(t, body["modalities"], `["image","text"]`)
	wangsuTestJSON(t, body["messages"], `[{"role":"user","content":[{"type":"text","text":"redraw"},{"type":"image_url","image_url":{"url":"data:image/png;base64,aGVsbG8="}}]}]`)
	result, err := wangsuTestAdapter(t, "wangsu-chat-image").ParseCreate(context.Background(), []byte(`{"choices":[{"message":{"content":[{"type":"text","text":"image"},{"type":"image_url","image_url":{"url":"data:image/png;base64,aGVsbG8="}}]}}]}`))
	if err != nil || result.Result == nil || len(result.Result.Images) != 1 {
		t.Fatalf("Chat image = %#v / %v", result.Result, err)
	}
	image := result.Result.Images[0]
	if image.DataURL != wangsuTestImage || image.URL != "" {
		t.Fatalf("Chat image reference = %#v", image)
	}
	urlResult, err := wangsuTestAdapter(t, "wangsu-chat-image").ParseCreate(context.Background(), []byte(`{"choices":[{"message":{"content":[{"type":"image_url","image_url":{"url":"https://cdn.example/result.png"}}]}}]}`))
	if err != nil || urlResult.Result == nil || len(urlResult.Result.Images) != 1 || urlResult.Result.Images[0].URL != "https://cdn.example/result.png" || urlResult.Result.Images[0].DataURL != "" {
		t.Fatalf("Chat image URL reference = %#v / %v", urlResult.Result, err)
	}
	_, qwenBody := wangsuTestCreate(t, "wangsu-chat-image", GenerationRequest{
		Model: "qwen-image-edit", Prompt: "redraw", AspectRatio: "16:9", Quality: "2k",
		Images: []MediaReference{{DataURL: wangsuTestImage, Role: "edit_source"}},
	})
	for _, key := range []string{"modalities", "eca_image_config"} {
		if _, exists := qwenBody[key]; exists {
			t.Errorf("Qwen Image Edit must omit Gemini-only field %s", key)
		}
	}
	wangsuTestJSON(t, qwenBody["messages"], `[{"role":"user","content":[{"type":"text","text":"redraw"},{"type":"image_url","image_url":{"url":"data:image/png;base64,aGVsbG8="}}]}]`)
}

func TestWangsuImagesChooseJSONGenerationAndMultipartEdit(t *testing.T) {
	for _, id := range []string{"wangsu-images", "wangsu-openai-images"} {
		t.Run(id, func(t *testing.T) {
			prefix := ""
			if id == "wangsu-openai-images" {
				prefix = "/openai"
			}
			request := GenerationRequest{Model: "gpt-image-2.5-flare", Prompt: "draw", AspectRatio: "1536x1024", Quality: "high", ImageCount: 2}
			spec, body := wangsuTestCreate(t, id, request)
			if spec.Path != prefix+"/images/generations" || spec.ContentType != "application/json" || len(spec.Files) != 0 || body["n"] != float64(2) || body["size"] != "1536x1024" {
				t.Fatalf("generation = %#v, body = %#v", spec, body)
			}
			request.Images = []MediaReference{{DataURL: wangsuTestImage, Role: "edit_source"}, {URL: "https://cdn.example/mask.png", Role: "mask"}}
			spec, body = wangsuTestCreate(t, id, request)
			if spec.Path != prefix+"/images/edits" || spec.ContentType != "multipart/form-data" || len(spec.Files) != 2 {
				t.Fatalf("edit = %#v", spec)
			}
			if spec.Files[0].Name != "image" || spec.Files[0].Reference.DataURL != wangsuTestImage || spec.Files[1].Name != "mask" || spec.Files[1].Reference.URL != "https://cdn.example/mask.png" {
				t.Errorf("multipart sources = %#v", spec.Files)
			}
			if _, exists := body["images"]; exists {
				t.Error("edit must not contain an incompatible JSON images field")
			}
			request.Images = request.Images[1:]
			if _, err := wangsuTestAdapter(t, id).BuildCreate(context.Background(), RequestContext{Request: request}); err == nil {
				t.Error("mask-only edit must fail")
			}
			for _, model := range []string{"qwen-image", "qwen-image-plus"} {
				request.Model, request.Images = model, nil
				_, body := wangsuTestCreate(t, id, request)
				for _, name := range []string{"quality", "background", "output_format"} {
					if _, exists := body[name]; exists {
						t.Errorf("%s must omit unsupported %s", model, name)
					}
				}
				request.Images = []MediaReference{{DataURL: wangsuTestImage, Role: "edit_source"}}
				if _, err := wangsuTestAdapter(t, id).BuildCreate(context.Background(), RequestContext{Request: request}); err == nil {
					t.Errorf("%s must reject edits", model)
				}
			}
			result, err := wangsuTestAdapter(t, id).ParseCreate(context.Background(), []byte(`{"data":[{"b64_json":"aGVsbG8="},{"url":"https://cdn.example/result.png"}],"usage":{"total_tokens":10}}`))
			if err != nil || result.Result == nil || len(result.Result.Images) != 2 || result.Result.Images[0].DataURL != wangsuTestImage || result.Result.Images[1].URL != "https://cdn.example/result.png" {
				t.Fatalf("image result = %#v / %v", result.Result, err)
			}
		})
	}
}

func TestWangsuVideosMapFramesAndMultimodalReferences(t *testing.T) {
	_, body := wangsuTestCreate(t, "wangsu-videos", GenerationRequest{
		Model: "doubao-seedance-2-0-260128", Prompt: "movie", Duration: 8, Resolution: "720p", AspectRatio: "16:9", GenerateAudio: true,
		Images: []MediaReference{
			{URL: "https://cdn.example/second.png", Role: "reference_image", Order: 3},
			{URL: "https://cdn.example/start.png", Role: "first_frame", Order: 0},
			{URL: "https://cdn.example/end.png", Role: "last_frame", Order: 1},
			{URL: "https://cdn.example/first.png", Role: "reference_image", Order: 2},
		},
		Videos: []MediaReference{{URL: "https://cdn.example/ref.mp4", Metadata: map[string]any{"audio": "https://cdn.example/embedded.mp3"}}},
		Audios: []MediaReference{{URL: "https://cdn.example/voice.mp3"}},
	})
	for key, want := range map[string]any{"seconds": float64(8), "size": "720p", "eca_aspect_ratio": "16:9", "eca_audio": true, "eca_first_frame": "https://cdn.example/start.png", "eca_last_frame": "https://cdn.example/end.png"} {
		if body[key] != want {
			t.Errorf("%s = %#v, want %#v", key, body[key], want)
		}
	}
	wangsuTestJSON(t, body["input_reference"], `[{"image":"https://cdn.example/first.png"},{"image":"https://cdn.example/second.png"}]`)
	wangsuTestJSON(t, body["eca_video_reference"], `[{"video":"https://cdn.example/ref.mp4","audio":"https://cdn.example/embedded.mp3"}]`)
	wangsuTestJSON(t, body["eca_audio_reference"], `[{"audio":"https://cdn.example/voice.mp3"}]`)

	_, vidu := wangsuTestCreate(t, "wangsu-videos", GenerationRequest{Model: "viduq2", Prompt: "movie", Images: []MediaReference{{URL: "https://cdn.example/ref.png", Role: "reference_image", Metadata: map[string]any{"eca_id": "actor", "eca_voice": "voice"}}}})
	wangsuTestJSON(t, vidu["input_reference"], `[{"image":["https://cdn.example/ref.png"],"eca_id":"actor","eca_voice":"voice"}]`)
}

func TestWangsuHailuoAndVeoRejectUnsupportedCombinations(t *testing.T) {
	for _, model := range []string{"MiniMax-Hailuo-02", "MiniMax-Hailuo-2.3"} {
		t.Run(model, func(t *testing.T) {
			request := GenerationRequest{Model: model, Prompt: "movie", Duration: 10, Resolution: "768p", Images: []MediaReference{{DataURL: wangsuTestImage, Role: "first_frame"}}}
			_, body := wangsuTestCreate(t, "wangsu-videos", request)
			if body["size"] != "768P" || body["eca_first_frame"] != wangsuTestImage {
				t.Errorf("Hailuo body = %#v", body)
			}
			request.Resolution = "1080p"
			if _, err := wangsuTestAdapter(t, "wangsu-videos").BuildCreate(context.Background(), RequestContext{Request: request}); err == nil {
				t.Error("Hailuo 10s/1080P must fail")
			}
		})
	}
	for _, model := range []string{"veo-3.1-generate-001", "veo-3.1-fast-generate-001"} {
		t.Run(model, func(t *testing.T) {
			request := GenerationRequest{Model: model, Prompt: "movie", Duration: 8, AspectRatio: "16:9", Resolution: "1080p", Images: []MediaReference{{DataURL: wangsuTestImage, Role: "reference_image"}}}
			_, body := wangsuTestCreate(t, "wangsu-videos", request)
			wangsuTestJSON(t, body["input_reference"], `[{"image":"data:image/png;base64,aGVsbG8="}]`)
			for _, tt := range []struct {
				name   string
				mutate func(*GenerationRequest)
			}{
				{"duration", func(r *GenerationRequest) { r.Duration = 6 }},
				{"ratio", func(r *GenerationRequest) { r.AspectRatio = "9:16" }},
				{"four references", func(r *GenerationRequest) {
					r.Images = []MediaReference{r.Images[0], r.Images[0], r.Images[0], r.Images[0]}
				}},
				{"mixed frames", func(r *GenerationRequest) {
					r.Images = append(r.Images, MediaReference{DataURL: wangsuTestImage, Role: "first_frame"})
				}},
				{"tail without first", func(r *GenerationRequest) {
					r.Images = []MediaReference{{DataURL: wangsuTestImage, Role: "last_frame"}}
				}},
			} {
				t.Run(tt.name, func(t *testing.T) {
					invalid := request
					tt.mutate(&invalid)
					if _, err := wangsuTestAdapter(t, "wangsu-videos").BuildCreate(context.Background(), RequestContext{Request: invalid}); err == nil {
						t.Error("unsupported Veo combination must fail")
					}
				})
			}
		})
	}
}

func TestWangsuSeedancePreservesAutomaticDuration(t *testing.T) {
	for _, model := range []string{"doubao-seedance-2-0-260128", "doubao-seedance-2-0-fast-260128", "doubao-seedance-2-5-260628"} {
		t.Run(model, func(t *testing.T) {
			_, body := wangsuTestCreate(t, "wangsu-videos", GenerationRequest{Model: model, Prompt: "movie", Duration: -1})
			if body["seconds"] != float64(-1) {
				t.Errorf("automatic duration must remain explicit: seconds = %#v", body["seconds"])
			}
		})
	}
}

func TestWangsuVideosDoNotAdvertiseUndocumentedCancellation(t *testing.T) {
	for _, id := range []string{"wangsu-videos", "wangsu-openai-videos"} {
		t.Run(id, func(t *testing.T) {
			adapter := wangsuTestAdapter(t, id)
			if adapter.Metadata().Cancel != "" {
				t.Errorf("undocumented cancel endpoint in metadata: %s", adapter.Metadata().Cancel)
			}
			if capability, ok := adapter.(interface{ CancelAvailable() bool }); ok && capability.CancelAvailable() {
				t.Error("undocumented cancellation must not be advertised")
			}
			if spec, err := adapter.BuildCancel(context.Background(), PollContext{Model: "sora-2", TaskID: "video-1"}); err == nil {
				t.Errorf("undocumented cancellation must return an error, got %#v", spec)
			}
		})
	}
}

func TestWangsuVideoLifecycleAndAuthenticatedDownload(t *testing.T) {
	adapter := wangsuTestAdapter(t, "wangsu-videos")
	for _, tt := range []struct {
		wire string
		want Status
	}{
		{"created", StatusPending}, {"queued", StatusPending}, {"processing", StatusProcessing},
		{"in_progress", StatusProcessing}, {"completed", StatusSucceeded}, {"expired", StatusFailed}, {"failed", StatusFailed},
	} {
		t.Run(tt.wire, func(t *testing.T) {
			payload := []byte(`{"id":"video-1","object":"video_generation","status":"` + tt.wire + `"}`)
			created, err := adapter.ParseCreate(context.Background(), payload)
			if err != nil || created.Status != tt.want || created.TaskID != "video-1" {
				t.Errorf("create = %#v / %v", created, err)
			}
			polled, err := adapter.ParsePoll(context.Background(), PollContext{TaskID: "video-1"}, payload)
			if err != nil || polled.Status != tt.want || polled.TaskID != "video-1" {
				t.Errorf("poll = %#v / %v", polled, err)
			}
		})
	}
	failed, err := adapter.ParsePoll(context.Background(), PollContext{TaskID: "video-1"}, []byte(`{"id":"video-1","status":"failed","error":{"code":"content_policy","message":"blocked by provider"}}`))
	if err != nil && !strings.Contains(err.Error(), "blocked by provider") {
		t.Errorf("upstream error message was lost: %v", err)
	}
	if err == nil && (failed.Status != StatusFailed || !strings.Contains(failed.Message, "blocked by provider")) {
		t.Errorf("upstream error was lost: %#v", failed)
	}
	for _, tt := range []struct{ id, prefix string }{{"wangsu-videos", ""}, {"wangsu-openai-videos", "/openai"}} {
		a := wangsuTestAdapter(t, tt.id)
		pollContext := PollContext{BaseURL: "https://gateway.example/v2/gws/test", Model: "sora-2", TaskID: "video-1"}
		poll, err := a.BuildPoll(context.Background(), pollContext)
		if err != nil || poll.Method != "GET" || poll.Path != tt.prefix+"/videos/video-1" || !poll.BasePath || poll.OriginPath || poll.Auth.Type != "bearer" {
			t.Errorf("%s poll = %#v / %v", tt.id, poll, err)
		}
		resultAdapter, ok := a.(ResultAdapter)
		if !ok {
			t.Fatalf("%s missing authenticated result operation", tt.id)
		}
		result, err := resultAdapter.BuildResult(context.Background(), pollContext)
		if err != nil || result.Method != "GET" || result.Path != tt.prefix+"/videos/video-1/content" || !result.BasePath || result.OriginPath || result.Auth.Type != "bearer" || result.Headers["Accept"] != "video/mp4" {
			t.Errorf("%s result = %#v / %v", tt.id, result, err)
		}
	}
}

func TestWangsuOpenAIVideoUsesSingleMultipartImageAndPixelSize(t *testing.T) {
	for _, tt := range []struct{ ratio, size string }{{"16:9", "1280x720"}, {"9:16", "720x1280"}} {
		request := GenerationRequest{Model: "sora-2", Prompt: "movie", Duration: 8, AspectRatio: tt.ratio, Images: []MediaReference{{DataURL: wangsuTestImage, Role: "first_frame"}}}
		spec, body := wangsuTestCreate(t, "wangsu-openai-videos", request)
		if spec.ContentType != "multipart/form-data" || body["size"] != tt.size || len(spec.Files) != 1 || spec.Files[0].Name != "input_reference" || spec.Files[0].Reference.DataURL != wangsuTestImage {
			t.Errorf("native video = %#v / %#v", spec, body)
		}
		for _, key := range []string{"resolution_name", "eca_first_frame", "eca_last_frame", "eca_aspect_ratio"} {
			if _, exists := body[key]; exists {
				t.Errorf("native video must not receive %s", key)
			}
		}
	}
	for _, request := range []GenerationRequest{
		{Images: []MediaReference{{DataURL: wangsuTestImage}, {DataURL: wangsuTestImage}}},
		{Images: []MediaReference{{DataURL: wangsuTestImage, Role: "last_frame"}}},
		{Images: []MediaReference{{DataURL: wangsuTestImage, Role: "mask"}}},
		{Videos: []MediaReference{{URL: "https://cdn.example/ref.mp4"}}},
		{Audios: []MediaReference{{URL: "https://cdn.example/ref.mp3"}}},
	} {
		request.Model, request.Prompt = "sora-2", "movie"
		if _, err := wangsuTestAdapter(t, "wangsu-openai-videos").BuildCreate(context.Background(), RequestContext{Request: request}); err == nil {
			t.Errorf("unsupported native video media accepted: %#v", request)
		}
	}
}

func TestWangsuSpeechMapsParametersAndReturnsBinaryAudio(t *testing.T) {
	for _, id := range []string{"wangsu-audio", "wangsu-openai-audio"} {
		t.Run(id, func(t *testing.T) {
			_, body := wangsuTestCreate(t, id, GenerationRequest{Model: "gpt-4o-mini-tts", Prompt: "hello", Extra: map[string]any{"audioVoice": "alloy", "audioFormat": "mp3", "audioSpeed": "1.25", "audioInstructions": "speak slowly"}})
			wangsuTestJSON(t, body, `{"model":"gpt-4o-mini-tts","input":"hello","voice":"alloy","response_format":"mp3","speed":1.25,"instructions":"speak slowly"}`)
			payload := []byte("ID3fake-mp3-bytes")
			result, err := wangsuTestAdapter(t, id).ParseCreate(context.Background(), payload)
			if err != nil || result.Status != StatusSucceeded || result.Result == nil || len(result.Result.Audios) != 1 {
				t.Fatalf("speech = %#v / %v", result, err)
			}
			if !strings.HasSuffix(result.Result.Audios[0].DataURL, base64.StdEncoding.EncodeToString(payload)) {
				t.Errorf("audio payload changed: %#v", result.Result.Audios[0])
			}
		})
	}
}
