package app

import (
	"context"
	"encoding/json"
	"testing"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/protocol"
)

func verifiedLiblibChannelModel(t *testing.T) model.ChannelModel {
	t.Helper()
	return model.ChannelModel{ID: "liblib-model", ChannelID: "liblib-channel", ModelKey: "screen-image", ProviderModelKey: verifiedLiblibSDCheckpoint, Capability: "image", Protocol: protocol.LiblibImageProtocolID, CapabilityConfigJSON: mustEncodeModelCapabilityConfig(t, DefaultModelCapabilityConfigForModel(protocol.LiblibImageProtocolID, verifiedLiblibSDCheckpoint))}
}

func TestChannelProviderDefaultsLimitVerifiedPreset(t *testing.T) {
	cm := verifiedLiblibChannelModel(t)
	defaults := channelModelProviderDefaults(cm)
	if defaults["family"] != "sd" || defaults["controlNetModel"] != "b6806516962f4e1599a93ac4483c3d23" || defaults["imageToImageTemplateUuid"] == defaults["textToImageTemplateUuid"] {
		t.Fatalf("incomplete verified preset: %#v", defaults)
	}
	cm.ProviderDefaults = map[string]any{"steps": 30, "seed": 0, "denoisingStrength": 0.0}
	defaults = channelModelProviderDefaults(cm)
	if defaults["steps"] != 30 || defaults["seed"] != 0 || defaults["denoisingStrength"] != 0.0 {
		t.Fatalf("administrator overrides lost: %#v", defaults)
	}
	cm.ProviderDefaults = nil
	cm.ProviderModelKey = "another-checkpoint"
	if defaults := channelModelProviderDefaults(cm); len(defaults) != 0 {
		t.Fatalf("invented defaults for another checkpoint: %#v", defaults)
	}
	cm = verifiedLiblibChannelModel(t)
	profile := DefaultModelCapabilityConfigForModel(protocol.LiblibImageProtocolID, verifiedLiblibSDCheckpoint)
	profile.Image.ControlNet.Supported = false
	cm.CapabilityConfigJSON = mustEncodeModelCapabilityConfig(t, profile)
	if defaults := channelModelProviderDefaults(cm); len(defaults) != 0 {
		t.Fatalf("invented structure defaults without ControlNet: %#v", defaults)
	}
	profile.Image.ControlNet.Supported = true
	profile.Image.ControlNet.Models = []string{"00000000000000000000000000000001"}
	cm.CapabilityConfigJSON = mustEncodeModelCapabilityConfig(t, profile)
	if defaults := channelModelProviderDefaults(cm); len(defaults) != 0 {
		t.Fatalf("preset bypassed compatible control model list: %#v", defaults)
	}
}

func TestChannelProviderDefaultsChooseOperationAndFreeze(t *testing.T) {
	for _, withReference := range []bool{false, true} {
		cm := verifiedLiblibChannelModel(t)
		cm.ProviderDefaults = map[string]any{"negativePrompt": "administrator default"}
		input := map[string]any{"mode": "image", "metadata": map[string]any{"providerOptions": map[string]any{protocol.LiblibImageProtocolID: map[string]any{"steps": 32, "seed": 0, "negativePrompt": ""}}}, "controlNet": []any{map[string]any{"id": "canny", "parameters": map[string]any{"model": ""}}}}
		if withReference {
			input["referenceImages"] = []any{map[string]any{"storageKey": "resource:content"}}
		}
		applyChannelProviderDefaults(input, cm)
		options := input["metadata"].(map[string]any)["providerOptions"].(map[string]any)[protocol.LiblibImageProtocolID].(map[string]any)
		template := "e10adc3949ba59abbe56e057f20f883e"
		if withReference {
			template = "9c7d531dc75f476aa833b3d452b8f7ad"
		}
		if options["templateUuid"] != template || options["steps"] != 32 || options["seed"] != 0 || options["negativePrompt"] != "" {
			t.Fatalf("wrong effective options: %#v", options)
		}
		control := input["controlNet"].([]any)[0].(map[string]any)["parameters"].(map[string]any)
		if control["model"] != "b6806516962f4e1599a93ac4483c3d23" {
			t.Fatalf("default control model absent: %#v", control)
		}
		data, _ := json.Marshal(input)
		var restored map[string]any
		if err := json.Unmarshal(data, &restored); err != nil {
			t.Fatal(err)
		}
		cm.ProviderDefaults = map[string]any{"sampler": 99, "controlNetModel": "00000000000000000000000000000001"}
		applyChannelProviderDefaults(restored, cm)
		frozen := restored["metadata"].(map[string]any)["providerOptions"].(map[string]any)[protocol.LiblibImageProtocolID].(map[string]any)
		if frozen["sampler"] != float64(15) {
			t.Fatalf("pending task changed after admin update: %#v", frozen)
		}
		cm.ID = "another-route"
		applyChannelProviderDefaults(restored, cm)
		rerouted := restored["metadata"].(map[string]any)["providerOptions"].(map[string]any)[protocol.LiblibImageProtocolID].(map[string]any)
		if rerouted["sampler"] != 99 || rerouted["steps"] != float64(32) {
			t.Fatalf("route switch lost original overrides or retained former defaults: %#v", rerouted)
		}
		control = restored["controlNet"].([]any)[0].(map[string]any)["parameters"].(map[string]any)
		if control["model"] != "00000000000000000000000000000001" {
			t.Fatalf("route switch inherited former control model: %#v", control)
		}
	}
}

func TestChannelProviderDefaultsRespectSelectedPriceTierModel(t *testing.T) {
	input := map[string]any{"config": map[string]any{"providerModelKey": "another-checkpoint"}}
	applyChannelProviderDefaults(input, verifiedLiblibChannelModel(t))
	if input["metadata"] != nil {
		t.Fatalf("verified defaults applied to unverified price-tier model: %#v", input)
	}
}

func TestNormalizeChannelProviderDefaultsValidatesDeclaredScalars(t *testing.T) {
	for _, input := range []map[string]any{
		{"apiKey": "secret"}, {"family": "unknown"}, {"steps": 0}, {"steps": 1.5}, {"steps": "20"},
		{"controlNetModel": "invalid"}, {"denoisingStrength": 1.1}, {"seed": -2}, {"sampler": true},
		{"steps": map[string]any{"value": 20}},
	} {
		if _, err := normalizeChannelProviderDefaults(protocol.Builtins(), protocol.LiblibImageProtocolID, input); err == nil {
			t.Fatalf("accepted invalid defaults: %#v", input)
		}
	}
	input := channelModelProviderDefaults(verifiedLiblibChannelModel(t))
	if _, err := normalizeChannelProviderDefaults(protocol.Builtins(), protocol.LiblibImageProtocolID, input); err != nil {
		t.Fatal(err)
	}
}

func TestChannelProviderDefaultsReachLiblibWithoutAuxiliaryPayloadFields(t *testing.T) {
	cm := verifiedLiblibChannelModel(t)
	for _, withReference := range []bool{false, true} {
		input := map[string]any{"mode": "image", "prompt": "A wide landscape", "config": map[string]any{"model": cm.ProviderModelKey, "interfaceType": protocol.LiblibImageProtocolID, "size": "1024x768", "count": "1"}}
		path, template := "/api/generate/webui/text2img", "e10adc3949ba59abbe56e057f20f883e"
		if withReference {
			input["referenceImages"] = []any{map[string]any{"url": "https://cdn.example.com/reference.png"}}
			path, template = "/api/generate/webui/img2img", "9c7d531dc75f476aa833b3d452b8f7ad"
		}
		applyChannelProviderDefaults(input, cm)
		encoded, _ := json.Marshal(input)
		var generation canvasGenerationInput
		if err := json.Unmarshal(encoded, &generation); err != nil {
			t.Fatal(err)
		}
		spec, err := protocol.LiblibImageAdapter().BuildCreate(context.Background(), protocol.RequestContext{Request: protocolRequestFromInput(generation)})
		if err != nil {
			t.Fatal(err)
		}
		body := spec.Body.(map[string]any)
		if spec.Path != path || body["templateUuid"] != template {
			t.Fatalf("wrong operation/template: %s %#v", spec.Path, body)
		}
		parameters := body["generateParams"].(map[string]any)
		for _, key := range []string{"controlNetModel", "textToImageTemplateUuid", "imageToImageTemplateUuid"} {
			if body[key] != nil || parameters[key] != nil {
				t.Fatalf("auxiliary field leaked upstream: %s", key)
			}
		}
	}
	cm.ProviderDefaults = map[string]any{"templateUuid": "00000000000000000000000000000001"}
	input := map[string]any{"referenceImages": []any{map[string]any{"storageKey": "resource:content"}}}
	applyChannelProviderDefaults(input, cm)
	options := input["metadata"].(map[string]any)["providerOptions"].(map[string]any)[protocol.LiblibImageProtocolID].(map[string]any)
	if options["templateUuid"] != "00000000000000000000000000000001" {
		t.Fatal("explicit fixed template lost to operation default")
	}
}

func TestSaveChannelProviderDefaultsPersistsAndPublishes(t *testing.T) {
	svc, db := newChannelModelTestService(t)
	admin := &model.User{ID: "admin", Role: model.UserRoleAdmin}
	channel := model.ModelChannel{ID: "liblib-channel", Scope: model.ChannelScopeSystem, Enabled: true, Name: "Liblib", APIFormat: "openai", BaseURL: "https://openapi.liblibai.cloud", APIKey: "test-access", SecretKey: "test-secret", ModelsJSON: `[]`}
	if err := db.Create(&channel).Error; err != nil {
		t.Fatal(err)
	}
	enabled := true
	saved, err := svc.SaveAdminChannelModel(admin, channel.ID, "", ChannelModelRequest{ModelKey: "screen-image", ProviderModelKey: verifiedLiblibSDCheckpoint, Capability: "image", Protocol: protocol.LiblibImageProtocolID, CapabilityConfig: DefaultModelCapabilityConfigForModel(protocol.LiblibImageProtocolID, verifiedLiblibSDCheckpoint), ProviderDefaults: map[string]any{"steps": 28}, PriceTiers: []ChannelModelPriceTierRequest{{BillingMode: "fixed_request", PriceConfigured: true, Enabled: &enabled}}, Enabled: &enabled})
	if err != nil {
		t.Fatal(err)
	}
	stored, err := svc.repo.ChannelModel(saved.ID)
	if err != nil || stored.ProviderDefaults["steps"] != float64(28) {
		t.Fatalf("defaults not persisted: %#v, %v", stored, err)
	}
	public, err := svc.sanitizeChannelModel(stored)
	if err != nil || public.DefaultOptions["steps"] != float64(28) || public.DefaultOptions["controlNetModel"] == nil {
		t.Fatalf("defaults not published: %#v, %v", public.DefaultOptions, err)
	}
	input := map[string]any{"mode": "image", "config": map[string]any{"channelId": channel.ID, "model": stored.ModelKey, "size": "1024x1024"}, "referenceImages": []any{map[string]any{"storageKey": "resource:content"}}}
	resolved, err := svc.resolveSystemChannelModelSelection(input, "canvas_image", "")
	if err != nil {
		t.Fatal(err)
	}
	options := resolved["metadata"].(map[string]any)["providerOptions"].(map[string]any)[protocol.LiblibImageProtocolID].(map[string]any)
	if options["steps"] != float64(28) || options["templateUuid"] != "9c7d531dc75f476aa833b3d452b8f7ad" {
		t.Fatalf("system admission did not freeze selected model defaults: %#v", options)
	}
}
