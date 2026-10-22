package app

import (
	"errors"
	"testing"

	"yingce/backend/internal/model"
	"yingce/backend/internal/protocol"
)

func TestImageCountEnumProjectionKeepsAdmissionAndExecutionConsistent(t *testing.T) {
	profile := DefaultImageCapabilityConfig("openai-image", "image-model")
	profile.Parameters = []protocol.ImageParameter{{Name: "count", Label: "数量", Type: "integer", Values: []any{1, 4, 8}, Default: 1}}
	if err := projectImageParameters(profile); err != nil {
		t.Fatal(err)
	}
	if profile.MaxOutputs != 8 {
		t.Fatalf("MaxOutputs = %d, want 8 from declared enum", profile.MaxOutputs)
	}
	for _, count := range []int{1, 4, 8} {
		input := canvasGenerationInput{Mode: "image", Config: providerConfig{Count: providerConfigOptionValue(count), ImageParameters: map[string]any{"count": count}}}
		if err := validateImageTask(profile, input); err != nil {
			t.Fatalf("declared count %d rejected during execution: %v", count, err)
		}
	}
	profile.Parameters = append(profile.Parameters,
		protocol.ImageParameter{Name: "size", Label: "尺寸", Type: "string", Values: []any{"1024x1024"}, Default: "1024x1024", Binding: "aspectRatio", Encoding: "pixels"},
		protocol.ImageParameter{Name: "imageResolution", Label: "分辨率", Type: "string", Values: []any{"1k"}, Default: "1k", Binding: "resolution"},
	)
	profile.Size.Presets = []ImageSizePreset{{Tier: "1k", Ratio: "1:1", Size: "1024x1024", Width: 1024, Height: 1024}}
	svc, _, channel, channelModel := createSystemChannelSelectionFixture(t, "image", model.ChannelInterfaceOpenAIImage, &ModelCapabilityConfig{Version: 1, Image: profile}, []model.ChannelModelPriceTier{newSelectionPriceTier("enum-count", `{}`, "image-model", "fixed_request")})
	resolved, err := svc.resolveSystemChannelModelSelection(map[string]any{
		"mode": "image", "config": map[string]any{"channelId": channel.ID, "model": channelModel.ModelKey}, "capabilityOptions": map[string]any{"count": 4},
	}, "canvas_image", "")
	if err != nil {
		t.Fatalf("declared count 4 failed admission: %v", err)
	}
	if err := svc.ValidateTaskCapability(resolved); err != nil {
		t.Fatalf("declared count 4 failed task validation: %v", err)
	}
	if got := resolved["config"].(map[string]any)["count"]; got != "4" {
		t.Fatalf("admitted execution count = %v, want 4", got)
	}
}

func TestLegacyCustomImageSizeRejectsMalformedIntentAndExecution(t *testing.T) {
	profile := DefaultModelCapabilityConfigForModel("openai-image", "image-model")
	profile.Image.Size = ImageSizeConfig{Parameter: "size", Values: []string{"auto", "1024x1024"}, Default: "1024x1024", AllowCustom: true}
	spec, err := CapabilitySpecFromModelCapabilityConfig(profile, "image")
	if err != nil {
		t.Fatal(err)
	}
	for _, size := range []string{"garbage", "0x1024", "-1x1024", "1024x", "NaN:1"} {
		t.Run(size, func(t *testing.T) {
			if match := MatchCapability(spec, ModelRequestIntent{Capability: "image", Options: map[string]any{"size": size}}); match.Matched {
				t.Errorf("malformed size matched admission: %q", size)
			}
			if err := validateImageTask(profile.Image, canvasGenerationInput{Mode: "image", Config: providerConfig{Size: size, Count: "1"}}); err == nil {
				t.Errorf("malformed size passed execution: %q", size)
			}
		})
	}
	for _, size := range []string{"auto", "1536x1024", "3:2", "1.5:1"} {
		if match := MatchCapability(spec, ModelRequestIntent{Capability: "image", Options: map[string]any{"size": size}}); !match.Matched {
			t.Fatalf("valid custom size %q rejected: %v", size, match.Reasons)
		}
	}
}

func TestLegacyImageExecutionRejectsExplicitInvalidCount(t *testing.T) {
	profile := DefaultImageCapabilityConfig("openai-image", "image-model")
	for _, count := range []string{"0", "-1", "2.5", "NaN", "bad"} {
		if err := validateImageTask(profile, canvasGenerationInput{Mode: "image", Config: providerConfig{Count: count}}); err == nil {
			t.Errorf("invalid count %q passed execution", count)
		}
	}
}

func TestChannelImageQuoteAndAdmissionRejectSameInvalidParameters(t *testing.T) {
	profile := DefaultModelCapabilityConfigForModel("openai-image", "image-model")
	profile.Image.Size = ImageSizeConfig{Parameter: "size", Values: []string{"1024x1024"}, Default: "1024x1024", AllowCustom: true}
	profile.Image.Resolution = ImageResolutionConfig{Supported: true, Values: []string{"1k", "2k"}, Default: "1k"}
	profile.Image.Size.Presets = []ImageSizePreset{{Tier: "1k", Ratio: "1:1", Size: "1024x1024", Width: 1024, Height: 1024}, {Tier: "2k", Ratio: "1:1", Size: "2048x2048", Width: 2048, Height: 2048}}
	profile.Image.MaxOutputs = 4
	svc, db, channel, channelModel := createSystemChannelSelectionFixture(t, "image", model.ChannelInterfaceType("legacy-image"), profile, []model.ChannelModelPriceTier{newSelectionPriceTier("image-default", `{}`, "image-model", "fixed_request")})
	if err := db.AutoMigrate(&model.SystemSetting{}, &model.BillingOrder{}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.QuoteChannelModel(ChannelModelQuoteRequest{ChannelID: channel.ID, ModelKey: channelModel.ModelKey, Intent: ModelRequestIntent{Capability: "image", Options: map[string]any{"count": 2}}}); err != nil {
		t.Fatalf("valid request did not reach billing quote: %v", err)
	}
	for _, options := range []map[string]any{{"size": "0x1024"}, {"imageResolution": "8k"}, {"count": 0}, {"count": 5}, {"count": 2.5}} {
		input := func() map[string]any {
			return map[string]any{"mode": "image", "config": map[string]any{"channelId": channel.ID, "model": channelModel.ModelKey}, "capabilityOptions": options}
		}
		assertCapabilityError := func(err error, stage string) {
			t.Helper()
			var modelErr *ModelError
			if !errors.As(err, &modelErr) || modelErr.ErrorCode != ErrCodeModelCapabilityNotSupported {
				t.Fatalf("%s did not reject parameters %#v at capability admission: %v", stage, options, err)
			}
		}
		_, err := svc.resolveSystemChannelModelSelection(input(), "canvas_image", "")
		assertCapabilityError(err, "selection")
		_, err = svc.QuoteChannelModel(ChannelModelQuoteRequest{ChannelID: channel.ID, ModelKey: channelModel.ModelKey, Intent: ModelRequestIntent{Capability: "image", Options: options}})
		assertCapabilityError(err, "quote")
		_, err = svc.CreateTask("user", CreateTaskRequest{Type: "canvas_image", Prompt: "test", Input: input()})
		assertCapabilityError(err, "task creation")
	}
	for _, record := range []any{&model.Task{}, &model.BillingOrder{}} {
		var count int64
		if err := db.Model(record).Count(&count).Error; err != nil || count != 0 {
			t.Fatalf("rejected requests persisted %T: count=%d, error=%v", record, count, err)
		}
	}
}
