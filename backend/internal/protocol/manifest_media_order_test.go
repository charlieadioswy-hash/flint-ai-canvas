package protocol

import (
	"context"
	"testing"
)

func TestCoolhsMixedMediaTokensKeepTheirKindOrder(t *testing.T) {
	adapter := officialPackageAdapter(t, "coolhs-wan3-relay.yingce-plugin", "coolhs-wan3-relay")
	inputs := []MediaReference{
		{Kind: "image", Order: 0, Metadata: map[string]any{MediaUploadIDKey: "image-1"}},
		{Kind: "video", Order: 0, Metadata: map[string]any{MediaUploadIDKey: "video-1"}},
		{Kind: "video", Order: 1, Metadata: map[string]any{MediaUploadIDKey: "video-2"}},
		{Kind: "audio", Order: 0, Metadata: map[string]any{MediaUploadIDKey: "audio-1"}},
		{Kind: "audio", Order: 1, Metadata: map[string]any{MediaUploadIDKey: "audio-2"}},
	}
	spec, err := adapter.BuildCreate(context.Background(), RequestContext{Request: GenerationRequest{
		Model: "wan3.0", Prompt: "@图片1 @视频1 @视频2 @音频1 @音频2", Inputs: inputs,
		Extra: map[string]any{"idempotencyKey": "batch-one"},
	}})
	if err != nil {
		t.Fatal(err)
	}
	body := manifestTestBody(t, spec)
	media, ok := body["media"].([]any)
	if !ok || len(media) != len(inputs) {
		t.Fatalf("media = %#v", body["media"])
	}
	for i, want := range []string{"图片1", "视频1", "视频2", "音频1", "音频2"} {
		if got := media[i].(map[string]any)["token"]; got != want {
			t.Errorf("media[%d].token = %v, want %s", i, got, want)
		}
	}
}

func TestManifestMediaFallbackOrderIsPerKind(t *testing.T) {
	values := manifestMediaValues([]MediaReference{{Kind: "image"}, {Kind: "video"}, {Kind: "video"}, {Kind: "audio"}})
	for i, want := range []int{0, 0, 1, 0} {
		if got := values[i].(map[string]any)["order"]; got != want {
			t.Errorf("media[%d].order = %v, want %d", i, got, want)
		}
	}
}
