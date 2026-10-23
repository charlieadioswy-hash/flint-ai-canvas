package protocol

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"testing"
)

func TestWangsuImageResolutionTakesPriorityWithoutQualityAliases(t *testing.T) {
	for _, id := range []string{"wangsu-gemini-image", "wangsu-chat-image"} {
		for _, model := range []string{"gemini-3-pro-image", "gemini-nano-banana-2.1"} {
			for _, tt := range []struct{ resolution, quality, want string }{
				{"4k", "low", "4K"}, {"2K", "4k", "2K"}, {"1k", "high", "1K"},
				{"", "2K", "2K"}, {"", "low", ""}, {"", "medium", ""}, {"", "high", ""},
				{"high", "", ""}, {"720", "auto", ""},
			} {
				t.Run(fmt.Sprintf("%s/%s/resolution=%s/quality=%s", id, model, tt.resolution, tt.quality), func(t *testing.T) {
					_, body := wangsuTestCreate(t, id, GenerationRequest{Capability: CapabilityImage, Model: model, Prompt: "draw", AspectRatio: "16:9", Resolution: tt.resolution, Quality: tt.quality})
					config, key := body["eca_image_config"], "image_size"
					if id == "wangsu-gemini-image" {
						config, key = body["generationConfig"].(map[string]any)["imageConfig"], "imageSize"
					}
					actual := config.(map[string]any)[key]
					if tt.want == "" {
						if actual != nil {
							t.Fatalf("ordinary quality became image resolution: %#v", actual)
						}
					} else if actual != tt.want {
						t.Fatalf("image resolution = %#v, want %q", actual, tt.want)
					}
				})
			}
		}
	}
}

func TestWangsuImagesDoNotConvertResolutionTiersIntoQuality(t *testing.T) {
	for _, id := range []string{"wangsu-images", "wangsu-openai-images"} {
		for _, quality := range []string{"auto", "low", "medium", "high", "xhigh", "max", "1k", "2k", "4k"} {
			t.Run(id+"/"+quality, func(t *testing.T) {
				_, body := wangsuTestCreate(t, id, GenerationRequest{Capability: CapabilityImage, Model: "gpt-image-2.5-flare", Prompt: "draw", AspectRatio: "1536x1024", Resolution: "4k", Quality: quality, ImageCount: 2})
				var wantQuality any = quality
				if quality == "auto" {
					wantQuality = nil
				}
				if body["quality"] != wantQuality || body["size"] != "1536x1024" || body["n"] != float64(2) || body["resolution"] != nil {
					t.Fatalf("quality/size/count changed: %#v", body)
				}
			})
		}
	}
}

func TestGeminiImagePluginsExcludeOnlyThoughtPreviewsAndKeepFinalImages(t *testing.T) {
	for _, tt := range []struct{ pkg, id string }{
		{"google-gemini-image.yingce-plugin", "gemini-image"},
		{"wangsu.yingce-plugin", "wangsu-gemini-image"},
	} {
		t.Run(tt.id, func(t *testing.T) {
			adapter := officialPackageAdapter(t, tt.pkg, tt.id)
			parts := []any{
				map[string]any{"thought": true, "inlineData": map[string]any{"data": "cHJldmlldw==", "mimeType": "image/png"}},
				map[string]any{"inlineData": map[string]any{"data": "Zmlyc3Q=", "mimeType": "image/png"}},
				map[string]any{"thought": false, "inline_data": map[string]any{"data": "c2Vjb25k", "mime_type": "image/jpeg"}},
				map[string]any{"thought": true, "inline_data": map[string]any{"data": "cHJldmlldw==", "mime_type": "image/png"}},
			}
			parse := func(candidateParts ...[]any) CreateResult {
				t.Helper()
				candidates := make([]any, 0, len(candidateParts))
				for _, parts := range candidateParts {
					candidates = append(candidates, map[string]any{"content": map[string]any{"parts": parts}})
				}
				payload, err := json.Marshal(map[string]any{"candidates": candidates})
				if err != nil {
					t.Fatal(err)
				}
				parser := adapter.(interface {
					ParseCreateWithRequest(context.Context, GenerationRequest, []byte) (CreateResult, error)
				})
				result, err := parser.ParseCreateWithRequest(context.Background(), GenerationRequest{Capability: CapabilityImage, ImageCount: 1}, payload)
				if err != nil {
					t.Fatal(err)
				}
				return result
			}
			for order, ordered := range [][]any{parts, {parts[2], parts[3], parts[0], parts[1]}} {
				result := parse(ordered)
				if result.Result == nil || len(result.Result.Images) != 2 {
					t.Fatalf("final images = %#v; previews must be removed without count truncation", result.Result)
				}
				want := []string{"data:image/png;base64,Zmlyc3Q=", "data:image/jpeg;base64,c2Vjb25k"}
				if order == 1 {
					want[0], want[1] = want[1], want[0]
				}
				got := []string{result.Result.Images[0].DataURL, result.Result.Images[1].DataURL}
				if !reflect.DeepEqual(got, want) {
					t.Fatalf("images = %#v, want %#v", got, want)
				}
			}
			result := parse([]any{parts[0], parts[1]}, []any{parts[3], parts[2]})
			if result.Result == nil || len(result.Result.Images) != 2 || result.Result.Images[0].DataURL != "data:image/png;base64,Zmlyc3Q=" || result.Result.Images[1].DataURL != "data:image/jpeg;base64,c2Vjb25k" {
				t.Fatalf("images from multiple candidates were lost: %#v", result.Result)
			}
			result = parse([]any{parts[0]}, []any{parts[3]})
			if result.Result != nil && len(result.Result.Images) != 0 {
				t.Fatalf("thought-only response became final output: %#v", result.Result.Images)
			}
		})
	}
}

func TestWangsuKlingMapsResolutionToModeOnlyForVerifiedModels(t *testing.T) {
	for _, model := range []string{"kling-v3", "kling-v3-omni"} {
		for _, tt := range []struct{ resolution, mode string }{
			{"", "pro"}, {"720", "std"}, {"720p", "std"}, {"720P", "std"}, {"std", "std"},
			{"1080", "pro"}, {"1080p", "pro"}, {"1080P", "pro"}, {"pro", "pro"},
		} {
			t.Run(model+"/"+tt.resolution, func(t *testing.T) {
				_, body := wangsuTestCreate(t, "wangsu-videos", GenerationRequest{Model: model, Prompt: "movie", Resolution: tt.resolution})
				if body["eca_mode"] != tt.mode {
					t.Fatalf("eca_mode = %#v, want %q", body["eca_mode"], tt.mode)
				}
				if _, exists := body["size"]; exists {
					t.Fatalf("Kling must use eca_mode, not size: %#v", body)
				}
			})
		}
		for _, invalid := range []string{"4k", "480p", "auto"} {
			if _, err := wangsuTestAdapter(t, "wangsu-videos").BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{Model: model, Resolution: invalid}}); err == nil {
				t.Errorf("%s accepted unsupported resolution %q", model, invalid)
			}
		}
	}
	for _, model := range []string{"doubao-seedance-2-5-260628", "MiniMax-Hailuo-02", "kling-v2", "kling-v3-preview"} {
		_, body := wangsuTestCreate(t, "wangsu-videos", GenerationRequest{Model: model, Prompt: "movie", Resolution: "720p"})
		if _, exists := body["eca_mode"]; exists {
			t.Errorf("%s received Kling-only mode: %#v", model, body)
		}
		if body["size"] == nil {
			t.Errorf("%s lost its normal resolution field: %#v", model, body)
		}
	}
}

func TestWangsuHailuo02Allows512P10sOnlyWithFirstFrame(t *testing.T) {
	for _, tt := range []struct {
		name, model, resolution, role string
		allowed                       bool
	}{
		{"02 first frame", "MiniMax-Hailuo-02", "512p", "first_frame", true},
		{"02 text", "MiniMax-Hailuo-02", "512p", "", false},
		{"02 last frame alone", "MiniMax-Hailuo-02", "512p", "last_frame", false},
		{"02 1080P", "MiniMax-Hailuo-02", "1080p", "first_frame", false},
		{"2.3 first frame", "MiniMax-Hailuo-2.3", "512p", "first_frame", false},
		{"2.3 standard", "MiniMax-Hailuo-2.3", "768p", "", true},
	} {
		t.Run(tt.name, func(t *testing.T) {
			request := GenerationRequest{Model: tt.model, Prompt: "movie", Duration: 10, Resolution: tt.resolution}
			if tt.role != "" {
				request.Images = []MediaReference{{URL: "https://cdn.example/frame.png", Role: tt.role}}
			}
			spec, err := wangsuTestAdapter(t, "wangsu-videos").BuildCreate(context.Background(), RequestContext{Request: request})
			if !tt.allowed {
				if err == nil {
					t.Fatal("unsupported Hailuo 10s combination accepted")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if body := manifestTestBody(t, spec); body["size"] != map[string]string{"512p": "512P", "768p": "768P"}[tt.resolution] {
				t.Fatalf("Hailuo wire resolution = %#v", body)
			}
		})
	}
}

func TestWangsuSeedanceFastDoesNotInheritStandard4K(t *testing.T) {
	adapter := wangsuTestAdapter(t, "wangsu-videos")
	for _, resolution := range []string{"480p", "720p", "4k"} {
		request := GenerationRequest{Model: "doubao-seedance-2-0-fast-260128", Prompt: "movie", Resolution: resolution}
		_, err := adapter.BuildCreate(context.Background(), RequestContext{Request: request})
		if resolution == "4k" {
			if err == nil {
				t.Fatal("Fast accepted standard-only 4K")
			}
		} else if err != nil {
			t.Fatal(err)
		}
	}
	_, body := wangsuTestCreate(t, "wangsu-videos", GenerationRequest{Model: "doubao-seedance-2-0-260128", Prompt: "movie", Resolution: "4k"})
	if body["size"] != "4k" {
		t.Fatalf("standard Seedance lost its own size: %#v", body)
	}
}
