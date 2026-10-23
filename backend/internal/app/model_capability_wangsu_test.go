package app

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"yingce/backend/internal/model"
)

func TestWangsuImageCapabilitiesMatchGatewayFamilies(t *testing.T) {
	for _, id := range []string{"wangsu-images", "wangsu-openai-images"} {
		for _, name := range []string{"qwen-image", "qwen-image-plus"} {
			profile := DefaultImageCapabilityConfig(id, name)
			if profile.References.MaxImages != 0 || profile.References.MaskSupported || profile.Quality.Supported || profile.TransparentBackground.Supported {
				t.Fatalf("%s/%s advertises unsupported image edits: %+v", id, name, profile)
			}
		}
		gpt := DefaultImageCapabilityConfig(id, "gpt-image-2.5-flare")
		if gpt.MaxOutputs != 10 || !gpt.References.MaskSupported || !containsCapabilityString(gpt.Quality.Values, "xhigh") || !containsCapabilityString(gpt.Quality.Values, "max") {
			t.Fatalf("%s missing GPT image capabilities: %+v", id, gpt)
		}
	}
	for _, id := range []string{"wangsu-gemini-image", "wangsu-chat-image"} {
		profile := DefaultImageCapabilityConfig(id, "gemini-3-pro-image")
		if profile.Size.Parameter != "aspect_ratio" || profile.References.MaskSupported || profile.MaxOutputs != 1 || !profile.Resolution.Supported || !reflect.DeepEqual(profile.Resolution.Values, []string{"1k", "2k", "4k"}) || profile.Quality.Supported || profile.ResolutionUsesQuality {
			t.Fatalf("%s Gemini image profile = %+v", id, profile)
		}
	}
	qwenEdit := DefaultImageCapabilityConfig("wangsu-chat-image", "qwen-image-edit")
	if qwenEdit.Size.Parameter != "none" || qwenEdit.References.MaxImages != 1 || qwenEdit.Quality.Supported {
		t.Fatalf("Qwen image edit profile = %+v", qwenEdit)
	}
}

func TestWangsuVideoDefaultsDoNotInheritUnrelatedMiniMaxProtocol(t *testing.T) {
	for _, id := range []string{"wangsu-videos"} {
		hailuo := DefaultModelCapabilityConfigForModel(id, "MiniMax-Hailuo-02").Video
		if !reflect.DeepEqual(hailuo.Duration.Values, []int{6, 10}) || !reflect.DeepEqual(hailuo.Resolutions, []string{"512P", "768P", "1080P"}) || hailuo.References.MaxImages != 2 || hailuo.References.MaxVideos != 0 || hailuo.GenerateAudio.Supported {
			t.Fatalf("%s Hailuo profile = %+v", id, hailuo)
		}
		seedance := DefaultModelCapabilityConfigForModel(id, "doubao-seedance-2-5-260628").Video
		if seedance.Duration.Max != 30 || seedance.References.MaxVideos != 3 || !seedance.GenerateAudio.Default || !reflect.DeepEqual(seedance.Resolutions, []string{"480p", "720p", "1080p"}) {
			t.Fatalf("%s Seedance 2.5 profile = %+v", id, seedance)
		}
		fast := DefaultModelCapabilityConfigForModel(id, "doubao-seedance-2-0-fast-260128").Video
		if fast.Duration.Max != 15 || fast.References.MaxVideos != 1 || !reflect.DeepEqual(fast.Resolutions, []string{"480p", "720p"}) {
			t.Fatalf("%s Seedance fast profile = %+v", id, fast)
		}
		kling := DefaultModelCapabilityConfigForModel(id, "kling-v3").Video
		if kling.Duration.Default != 5 || !reflect.DeepEqual(kling.Resolutions, []string{"720P", "1080P"}) || kling.DefaultResolution != "1080P" || !reflect.DeepEqual(kling.Ratios, []string{"16:9", "9:16", "1:1"}) {
			t.Fatalf("%s Kling mode contract = %+v", id, kling)
		}
	}
}

func TestWangsuProfilesNormalizeWithoutChangingAdministratorLimits(t *testing.T) {
	for _, tc := range []struct{ protocolID, modelName, capability string }{
		{"wangsu-chat", "deepseek-v4.1-flash", "text"},
		{"wangsu-images", "qwen-image", "image"},
		{"wangsu-openai-images", "gpt-image-2.5-flare", "image"},
		{"wangsu-gemini-image", "gemini-3-pro-image", "image"},
		{"wangsu-chat-image", "qwen-image-edit", "image"},
		{"wangsu-videos", "MiniMax-Hailuo-02", "video"},
		{"wangsu-videos", "doubao-seedance-2-5-260628", "video"},
		{"wangsu-videos", "kling-v3", "video"},
		{"wangsu-videos", "veo-3.1-generate-001", "video"},
		{"wangsu-openai-videos", "sora-2", "video"},
	} {
		profile := DefaultModelCapabilityConfigForModel(tc.protocolID, tc.modelName)
		if _, err := NormalizeModelCapabilityConfigForModel(tc.capability, tc.protocolID, tc.modelName, profile); err != nil {
			t.Fatalf("%s/%s normalization failed: %v", tc.protocolID, tc.modelName, err)
		}
	}
	profile := DefaultModelCapabilityConfigForModel("wangsu-videos", "doubao-seedance-2-5-260628")
	profile.Video.Duration.Max = 12
	got, err := NormalizeModelCapabilityConfigForModel("video", "wangsu-videos", "doubao-seedance-2-5-260628", profile)
	if err != nil || got.Video.Duration.Max != 12 {
		t.Fatalf("administrator duration changed: %+v, %v", got, err)
	}
}

func TestWangsuHailuoRejectsUnsupportedDurationResolutionCombination(t *testing.T) {
	for _, resolution := range []string{"512P", "1080P"} {
		profile := DefaultModelCapabilityConfigForModel("wangsu-videos", "MiniMax-Hailuo-02").Video
		input := canvasGenerationInput{Mode: "video", Prompt: "A quiet landscape", Config: providerConfig{InterfaceType: "wangsu-videos", Model: "display-name", ProviderModelKey: "MiniMax-Hailuo-02", VideoSeconds: "10", VQuality: resolution}}
		if err := validateVideoTask(profile, input); err == nil || !strings.Contains(err.Error(), "仅支持 768P") {
			t.Fatalf("accepted 10-second %s: %v", resolution, err)
		}
		input.Config.VQuality = "768P"
		if err := validateVideoTask(profile, input); err != nil {
			t.Fatalf("rejected 10-second 768P: %v", err)
		}
	}
}

func TestWangsuHailuo02AllowsVerified512P10SecondImageToVideo(t *testing.T) {
	profile := DefaultModelCapabilityConfigForModel("wangsu-videos", "MiniMax-Hailuo-02").Video
	input := canvasGenerationInput{Mode: "video", Prompt: "A quiet landscape", Config: providerConfig{InterfaceType: "wangsu-videos", ProviderModelKey: "MiniMax-Hailuo-02", VideoSeconds: "10", VQuality: "512P"}, ReferenceImages: []providerMedia{{ID: "first-frame"}}}
	if err := validateVideoTask(profile, input); err != nil {
		t.Fatalf("rejected verified 512P/10s image-to-video: %v", err)
	}
	input.Metadata = map[string]any{"videoOperation": "text_to_video"}
	if err := validateVideoTask(profile, input); err == nil {
		t.Fatal("allowed an explicit unverified text-to-video operation")
	}
	input.Metadata = nil
	input.Config.VQuality = "1080P"
	if err := validateVideoTask(profile, input); err == nil {
		t.Fatal("allowed unverified 1080P/10s image-to-video")
	}
}

func TestWangsuNanoDeclaresNativeRatiosWithoutPixelPresets(t *testing.T) {
	profile := DefaultImageCapabilityConfig("wangsu-gemini-image", "gemini-nano-banana-2.1")
	if profile.References.MaxImages != 14 || len(profile.Size.Values) != 14 || len(profile.Size.Presets) != 0 || !profile.Resolution.Supported || profile.ResolutionUsesQuality {
		t.Fatalf("Nano contract = %+v", profile)
	}
	for _, ratio := range []string{"1:4", "1:8", "4:1", "8:1"} {
		if !containsCapabilityString(profile.Size.Values, ratio) {
			t.Fatalf("missing documented ratio %s", ratio)
		}
	}
	if _, err := NormalizeModelCapabilityConfigForModel("image", "wangsu-gemini-image", "gemini-nano-banana-2.1", &ModelCapabilityConfig{Version: 1, Image: profile}); err != nil {
		t.Fatalf("native Nano contract rejected: %v", err)
	}
}

func TestWangsuGPTKeepsQualitySeparateFromResolution(t *testing.T) {
	for _, name := range []string{"gpt-image-2", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst"} {
		profile := DefaultImageCapabilityConfig("wangsu-images", name)
		if profile.Resolution.Supported || profile.ResolutionUsesQuality || len(profile.Size.Presets) != 0 || !reflect.DeepEqual(profile.Size.Values, []string{"1024x1024", "1536x1024", "1024x1536"}) {
			t.Fatalf("%s invented a resolution contract: %+v", name, profile)
		}
		if name == "gpt-image-2" && containsCapabilityString(profile.Quality.Values, "medium") {
			t.Fatal("GPT Image 2 medium opened before pricing was configured")
		}
	}
}

func TestWangsuLegacyGeminiResolutionKeepsRouteDefaultsAndPriceSelectors(t *testing.T) {
	for _, protocolID := range []string{"wangsu-gemini-image", "wangsu-chat-image"} {
		config := DefaultModelCapabilityConfigForModel(protocolID, "gemini-nano-banana-2.1")
		config.Image.Resolution = ImageResolutionConfig{Values: []string{}, Default: "auto"}
		config.Image.Quality = ImageQualityConfig{Supported: true, Values: []string{"1k", "2k", "4k"}, Default: "2k"}
		raw, err := json.Marshal(config)
		if err != nil {
			t.Fatal(err)
		}
		tiers := []model.ChannelModelPriceTier{{Selector: map[string]string{"quality": "4k"}}}
		if err := validateChannelModelTierCapabilities(tiers, string(raw), "image", protocolID); err != nil {
			t.Fatalf("%s rejected existing resolution price selector: %v", protocolID, err)
		}
		normalized, err := NormalizeModelCapabilityConfigForModel("image", protocolID, "gemini-nano-banana-2.1", config)
		if err != nil {
			t.Fatal(err)
		}
		spec, err := CapabilitySpecFromModelCapabilityConfig(normalized, "image")
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(spec.Options["imageResolution"].Values, []any{"1k", "2k", "4k"}) {
			t.Fatalf("%s lost resolution route constraints: %+v", protocolID, spec.Options)
		}
		defaults, err := channelModelDefaultOptions(model.ChannelModel{Capability: "image", Protocol: model.ChannelInterfaceType(protocolID), ProviderModelKey: "gemini-nano-banana-2.1", CapabilityConfigJSON: string(raw)}, spec)
		if err != nil || defaults["imageResolution"] != "2k" {
			t.Fatalf("%s lost configured resolution default: %+v, %v", protocolID, defaults, err)
		}
		request := map[string]any{"quality": "4k"}
		if got := normalizeLegacyImageResolutionRequest(protocolID, normalized, request); got != "4k" || request["imageResolution"] != "4k" || request["quality"] != nil {
			t.Fatalf("%s legacy request projection = %+v (%s)", protocolID, request, got)
		}
		for _, resolution := range []string{"auto", "any"} {
			request = map[string]any{"quality": "4k", "imageResolution": resolution}
			if got := normalizeLegacyImageResolutionRequest(protocolID, normalized, request); got != "4k" || request["imageResolution"] != "4k" {
				t.Fatalf("%s lost legacy resolution with %s: %+v", protocolID, resolution, request)
			}
		}
		request = map[string]any{"quality": "4k", "imageResolution": "2k"}
		normalizeLegacyImageResolutionRequest(protocolID, normalized, request)
		if request["imageResolution"] != "2k" || request["quality"] != nil {
			t.Fatalf("%s legacy quality overrode explicit resolution: %+v", protocolID, request)
		}
	}
}

func TestWangsuNativeVideoDefaultsAndSingleFrameContract(t *testing.T) {
	for _, name := range []string{"sora-2", "MiniMax-Hailuo-02", "doubao-seedance-2-5-260628"} {
		profile := DefaultModelCapabilityConfigForModel("wangsu-openai-videos", name).Video
		if !reflect.DeepEqual(profile.Duration.Values, []int{4, 8, 12}) || profile.Duration.Default != 4 || !reflect.DeepEqual(profile.Ratios, []string{"16:9", "9:16"}) || profile.References.MaxImages != 1 || profile.References.MaxVideos != 0 || profile.References.MaxAudios != 0 {
			t.Fatalf("native video inherited gateway model defaults: %+v", profile)
		}
		input := canvasGenerationInput{Mode: "video", Prompt: "A quiet landscape", Config: providerConfig{InterfaceType: "wangsu-openai-videos", Model: name, VideoSeconds: "4", Size: "16:9", VQuality: "720p"}, ReferenceImages: []providerMedia{{ID: "frame"}}}
		if err := validateVideoTask(profile, input); err != nil {
			t.Fatalf("single image rejected: %v", err)
		}
		input.Metadata = map[string]interface{}{"videoEndFrameNodeId": "frame"}
		if err := validateVideoTask(profile, input); err == nil {
			t.Fatal("native video accepted a tail frame")
		}
	}
}

func TestWangsuVeoReferenceConstraints(t *testing.T) {
	for _, name := range []string{"veo-3.1-generate-001", "veo-3.1-fast-generate-001"} {
		profile := DefaultModelCapabilityConfigForModel("wangsu-videos", name).Video
		if profile.References.MaxImages != 3 || !reflect.DeepEqual(profile.Duration.Values, []int{4, 6, 8}) || !reflect.DeepEqual(profile.Resolutions, []string{"720p", "1080p", "4k"}) {
			t.Fatalf("Veo profile = %+v", profile)
		}
		input := canvasGenerationInput{Mode: "video", Prompt: "A quiet landscape", Config: providerConfig{InterfaceType: "wangsu-videos", Model: name, VideoSeconds: "8", Size: "16:9", VQuality: "4k"}, ReferenceImages: []providerMedia{{ID: "reference"}}, Metadata: map[string]interface{}{"videoEditOperation": "reference_to_video"}}
		if err := validateVideoTask(profile, input); err != nil {
			t.Fatalf("valid reference rejected: %v", err)
		}
		input.Config.VideoSeconds = "4"
		if err := validateVideoTask(profile, input); err == nil {
			t.Fatal("accepted 4-second Veo reference")
		}
		input.Config.VideoSeconds = "8"
		input.Config.Size = "9:16"
		if err := validateVideoTask(profile, input); err == nil {
			t.Fatal("accepted portrait Veo reference")
		}
		input.Config.Size = "16:9"
		input.Metadata["videoStartFrameNodeId"] = "reference"
		if err := validateVideoTask(profile, input); err == nil || !strings.Contains(err.Error(), "同时使用") {
			t.Fatalf("accepted reference and first frame: %v", err)
		}
		input.Metadata = map[string]interface{}{"videoStartFrameNodeId": "reference"}
		input.Config.VideoSeconds = "4"
		if err := validateVideoTask(profile, input); err != nil {
			t.Fatalf("valid 4-second first-frame input rejected: %v", err)
		}
	}
}
