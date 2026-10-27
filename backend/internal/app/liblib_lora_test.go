package app

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"yingce/backend/internal/generation"
	"yingce/backend/internal/model"
	"yingce/backend/internal/protocol"
)

const liblibLoRATestID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

func liblibLoRATestInput() (canvasGenerationInput, *ImageCapabilityConfig) {
	profile := DefaultImageCapabilityConfig(protocol.LiblibImageProtocolID, verifiedLiblibSDCheckpoint)
	profile.LoRA = &generation.LoRACapability{Supported: true, MaxNetworks: 5, BaseModel: "sdxl", Models: []generation.LoRAModelConfig{{ID: liblibLoRATestID, Name: "Portrait style", BaseModel: "sdxl", TriggerWords: []string{"portrait-token", "portrait-token"}}}}
	input := canvasGenerationInput{Mode: "image", Prompt: "Original user prompt", Config: providerConfig{ChannelID: "liblib-channel", Model: verifiedLiblibSDCheckpoint, InterfaceType: protocol.LiblibImageProtocolID, Size: "768x1024", Count: "1"}, Metadata: map[string]any{"providerOptions": map[string]any{protocol.LiblibImageProtocolID: map[string]any{"family": "sd", "templateUuid": "e10adc3949ba59abbe56e057f20f883e", "steps": 20, "sampler": 15, "cfgScale": 7, "additionalNetwork": []any{map[string]any{"modelId": liblibLoRATestID}}}}}}
	return input, profile
}

func TestLiblibLoRAAdmissionRejectsUntrustedCompatibility(t *testing.T) {
	cases := []struct {
		name   string
		change func(*canvasGenerationInput, *ImageCapabilityConfig)
	}{
		{"disabled", func(_ *canvasGenerationInput, p *ImageCapabilityConfig) { p.LoRA.Supported = false }},
		{"unregistered", func(_ *canvasGenerationInput, p *ImageCapabilityConfig) {
			p.LoRA.Models[0].ID = strings.Repeat("b", 32)
		}},
		{"wrong-base", func(_ *canvasGenerationInput, p *ImageCapabilityConfig) { p.LoRA.Models[0].BaseModel = "sd15" }},
		{"checkpoint-base-conflict", func(_ *canvasGenerationInput, p *ImageCapabilityConfig) { p.LoRA.BaseModel = "sd15" }},
		{"wrong-protocol", func(i *canvasGenerationInput, _ *ImageCapabilityConfig) { i.Config.InterfaceType = "openai-image" }},
		{"checkpoint-override", func(i *canvasGenerationInput, _ *ImageCapabilityConfig) {
			liblibLoRAOptions(*i)["checkPointId"] = strings.Repeat("b", 32)
		}},
		{"forged-snapshot", func(i *canvasGenerationInput, p *ImageCapabilityConfig) {
			networks, _ := protocol.NormalizeLiblibAdditionalNetworks(liblibLoRAOptions(*i)["additionalNetwork"])
			i.LiblibLoRA = &liblibLoRASnapshot{ChannelID: i.Config.ChannelID, Model: i.Config.Model, Checkpoint: i.Config.Model, Networks: networks, TriggerWords: []string{"attacker-token"}}
			p.LoRA.Models = nil
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			input, profile := liblibLoRATestInput()
			tc.change(&input, profile)
			raw := map[string]any{liblibLoRASnapshotKey: input.LiblibLoRA}
			if err := prepareLiblibLoRATaskInput(raw, &input, profile); err == nil {
				t.Fatal("client-supplied compatibility was accepted")
			}
		})
	}
}

func TestLiblibLoRAFreezesTriggersWithoutChangingUserPrompt(t *testing.T) {
	input, profile := liblibLoRATestInput()
	raw := map[string]any{"prompt": input.Prompt}
	if err := prepareLiblibLoRATaskInput(raw, &input, profile); err != nil {
		t.Fatal(err)
	}
	if input.Prompt != "Original user prompt" || raw["prompt"] != input.Prompt {
		t.Fatal("LoRA polluted the user's stored prompt")
	}
	if raw[liblibLoRASnapshotKey] == nil {
		t.Fatal("admission did not persist the validated LoRA snapshot")
	}
	encoded, _ := json.Marshal(input)
	var restored canvasGenerationInput
	if err := json.Unmarshal(encoded, &restored); err != nil {
		t.Fatal(err)
	}
	profile.LoRA.Models[0].TriggerWords = []string{"new-admin-token"}
	profile.LoRA.Supported = false
	if err := prepareLiblibLoRATaskInput(nil, &restored, profile); err != nil {
		t.Fatal("queued task lost its admitted snapshot:", err)
	}
	request := protocolRequestFromInput(restored)
	prepared, err := prepareLiblibProtocolRequest(context.Background(), restored, request)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(prepared.Prompt, "portrait-token") != 1 || strings.Contains(prepared.Prompt, "new-admin-token") || restored.Prompt != input.Prompt {
		t.Fatalf("wrong frozen prompt: %q", prepared.Prompt)
	}
	again, err := prepareLiblibProtocolRequest(context.Background(), restored, prepared)
	if err != nil || again.Prompt != prepared.Prompt {
		t.Fatalf("request preparation is not idempotent: %q %v", again.Prompt, err)
	}
	// A new quote/task or a different route must validate against its own catalogue.
	if err := prepareLiblibLoRATaskInput(map[string]any{}, &restored, profile); err == nil {
		t.Fatal("new admission reused an old catalogue snapshot")
	}
	var rerouted canvasGenerationInput
	_ = json.Unmarshal(encoded, &rerouted)
	rerouted.Config.ChannelID = "different-route"
	if err := prepareLiblibLoRATaskInput(nil, &rerouted, profile); err == nil {
		t.Fatal("a different route inherited the original LoRA authorization")
	}
}

func TestLiblibLoRACompilesProjectAssetsAndManualWeightsWin(t *testing.T) {
	for _, manual := range []bool{false, true} {
		input, profile := liblibLoRATestInput()
		weight := -1.5
		style := styleProfileDocument{SchemaVersion: 1, PresetID: "style", Title: "style", Prompt: "project style", Source: "user", Revision: 1, ExecutionPolicy: "strict-assets", Assets: []styleProfileAsset{{ID: "asset", Kind: "lora", Provider: "liblib-image", Title: "portrait", Version: liblibLoRATestID, Status: "validated", Weight: &weight, TriggerWords: []string{"untrusted-token"}}}}
		encoded, _ := json.Marshal(style)
		input.Metadata["styleProfileJson"] = string(encoded)
		if manual {
			liblibLoRAOptions(input)["additionalNetwork"] = []any{map[string]any{"modelId": liblibLoRATestID, "weight": 0.3}}
		} else {
			delete(liblibLoRAOptions(input), "additionalNetwork")
		}
		if err := prepareLiblibLoRATaskInput(map[string]any{}, &input, profile); err != nil {
			t.Fatal(err)
		}
		wantWeight := weight
		if manual {
			wantWeight = 0.3
		}
		if len(input.LiblibLoRA.Networks) != 1 || input.LiblibLoRA.Networks[0].Weight != wantWeight {
			t.Fatalf("manual/project LoRA merge is wrong: %#v", input.LiblibLoRA)
		}
		if strings.Contains(liblibLoRAPrompt(input, input.Prompt), "untrusted-token") {
			t.Fatal("asset-supplied trigger words bypassed the trusted catalogue")
		}
		if err := (&Service{}).applyGenerationStyleProfile("user", "", &input); err != nil {
			t.Fatal("selected compatible project LoRA still blocked:", err)
		}
		profile.LoRA.Models[0].BaseModel = "sd15"
		if err := prepareLiblibLoRATaskInput(map[string]any{}, &input, profile); err == nil {
			t.Fatal("incompatible strict project LoRA was accepted")
		}
	}
}

func TestLiblibLoRADefaultsUseOnlyDeclaredStructuredParameter(t *testing.T) {
	input, profile := liblibLoRATestInput()
	defaults := liblibLoRAOptions(input)
	defaults["additionalNetwork"] = []any{map[string]any{"modelId": liblibLoRATestID, "weight": -2}}
	normalized, err := normalizeChannelProviderDefaults(protocol.Builtins(), protocol.LiblibImageProtocolID, defaults)
	if err != nil {
		t.Fatal(err)
	}
	cm := verifiedLiblibChannelModel(t)
	cm.ProviderDefaults = normalized
	cm.CapabilityConfigJSON = mustEncodeModelCapabilityConfig(t, &ModelCapabilityConfig{Version: 1, Image: profile})
	if err := validateChannelLoRADefaults(cm, &ModelCapabilityConfig{Image: profile}); err != nil {
		t.Fatal(err)
	}
	profile.LoRA.Models[0].BaseModel = "sd15"
	if err := validateChannelLoRADefaults(cm, &ModelCapabilityConfig{Image: profile}); err == nil {
		t.Fatal("channel saved incompatible default LoRA")
	}
	if _, err := normalizeChannelProviderDefaults(protocol.Builtins(), protocol.LiblibImageProtocolID, map[string]any{"loraCatalog": []any{}}); err == nil {
		t.Fatal("a task-overridable provider catalogue was accepted")
	}
}

func TestLiblibLoRAQuoteValidatesSelectionsAndKeepsPrice(t *testing.T) {
	svc, db := newChannelModelTestService(t)
	if err := db.AutoMigrate(&model.SystemSetting{}); err != nil {
		t.Fatal(err)
	}
	channel := model.ModelChannel{ID: "lora-quote", Scope: model.ChannelScopeSystem, Enabled: true, Name: "Liblib", APIFormat: "openai", BaseURL: "https://openapi.liblibai.cloud", APIKey: "test-access", SecretKey: "test-secret", ModelsJSON: `[]`}
	if err := db.Create(&channel).Error; err != nil {
		t.Fatal(err)
	}
	_, profile := liblibLoRATestInput()
	enabled := true
	saved, err := svc.SaveAdminChannelModel(&model.User{ID: "admin", Role: model.UserRoleAdmin}, channel.ID, "", ChannelModelRequest{ModelKey: "image", ProviderModelKey: verifiedLiblibSDCheckpoint, Capability: "image", Protocol: protocol.LiblibImageProtocolID, CapabilityConfig: &ModelCapabilityConfig{Version: 1, Image: profile}, ProviderDefaults: map[string]any{"additionalNetwork": []any{map[string]any{"modelId": liblibLoRATestID, "weight": 0.2}}}, PriceTiers: []ChannelModelPriceTierRequest{{BillingMode: "fixed_request", PriceConfigured: true, UnitPriceMicrocredits: 1_000_000, Enabled: &enabled}}, Enabled: &enabled})
	if err != nil {
		t.Fatal(err)
	}
	for _, networks := range []any{[]any{map[string]any{"modelId": liblibLoRATestID, "weight": -2}}, []any{}} {
		intent := ModelRequestIntent{Capability: "image", Inputs: map[string]int{"image": 1}, Options: map[string]any{"count": 1}, ProviderOptions: map[string]map[string]any{protocol.LiblibImageProtocolID: {"additionalNetwork": networks}}}
		quote, err := svc.QuoteChannelModel(ChannelModelQuoteRequest{ChannelID: channel.ID, ModelKey: saved.ModelKey, Intent: intent})
		if err != nil || quote.AmountMicrocredits != 1_000_000 {
			t.Fatalf("LoRA changed the per-request quote: %#v %v", quote, err)
		}
	}
	for _, options := range []map[string]any{
		{"additionalNetwork": []any{map[string]any{"modelId": strings.Repeat("b", 32)}}},
		{"additionalNetwork": []any{map[string]any{"modelId": liblibLoRATestID, "weight": 5}}},
		{"family": "sd"},
		{"checkPointId": verifiedLiblibSDCheckpoint},
		{"loraCatalog": []any{}},
	} {
		intent := ModelRequestIntent{Capability: "image", ProviderOptions: map[string]map[string]any{protocol.LiblibImageProtocolID: options}}
		if quote, err := svc.QuoteChannelModel(ChannelModelQuoteRequest{ChannelID: channel.ID, ModelKey: saved.ModelKey, Intent: intent}); err == nil || quote != nil {
			t.Fatalf("quote accepted unsupported LoRA options: %#v", options)
		}
	}
}

func TestLiblibLoRARouteEligibilityRequiresCompatibleCatalogue(t *testing.T) {
	_, profile := liblibLoRATestInput()
	valid := verifiedLiblibChannelModel(t)
	valid.Enabled = true
	valid.CapabilityConfigJSON = mustEncodeModelCapabilityConfig(t, &ModelCapabilityConfig{Version: 1, Image: profile})
	invalid := valid
	invalid.ID, invalid.ModelKey = "invalid", "invalid"
	invalidProfile := *profile
	invalidLoRA := *profile.LoRA
	invalidLoRA.Models = []generation.LoRAModelConfig{{ID: strings.Repeat("b", 32), Name: "another style", BaseModel: "sdxl"}}
	invalidProfile.LoRA = &invalidLoRA
	invalid.CapabilityConfigJSON = mustEncodeModelCapabilityConfig(t, &ModelCapabilityConfig{Version: 1, Image: &invalidProfile})
	intent := ModelRequestIntent{Capability: "image", ProviderOptions: map[string]map[string]any{protocol.LiblibImageProtocolID: {"additionalNetwork": []any{map[string]any{"modelId": liblibLoRATestID}}}}}
	capability := CapabilitySpec{Version: 1, Capability: "image"}
	routes := []cachedLogicalRoute{
		{Route: model.LogicalModelRoute{ID: "wrong", Enabled: true, Weight: 100, Priority: 10}, ChannelModel: invalid, CapabilitySpec: capability},
		{Route: model.LogicalModelRoute{ID: "right", Enabled: true, Weight: 1, Priority: 1}, ChannelModel: valid, CapabilitySpec: capability},
	}
	eligible := (&Service{}).eligibleLogicalRoutes(routes, intent, nil, false)
	if len(eligible) != 1 || eligible[0].Route.ID != "right" {
		t.Fatalf("routing selected an incompatible high-priority catalogue: %#v", eligible)
	}
	if remaining := (&Service{}).eligibleLogicalRoutes(routes, intent, map[string]bool{"right": true}, false); len(remaining) != 0 {
		t.Fatal("retry fell back to a route that cannot execute the selected LoRA")
	}
}

func TestLiblibLoRARouteEligibilityCompilesProjectAssetsBeforeSelection(t *testing.T) {
	_, profile := liblibLoRATestInput()
	valid := verifiedLiblibChannelModel(t)
	valid.Enabled = true
	valid.CapabilityConfigJSON = mustEncodeModelCapabilityConfig(t, &ModelCapabilityConfig{Version: 1, Image: profile})
	other := valid
	other.ID, other.ModelKey, other.ProviderModelKey, other.Protocol = "other", "image-other", "image-other", model.ChannelInterfaceOpenAIImage
	other.CapabilityConfigJSON = mustEncodeModelCapabilityConfig(t, DefaultModelCapabilityConfigForModel(string(other.Protocol), other.ModelKey))
	style := styleProfileDocument{SchemaVersion: 1, PresetID: "style", Title: "style", Prompt: "project style", Source: "user", Revision: 1, ExecutionPolicy: "strict-assets", Assets: []styleProfileAsset{{ID: "asset", Kind: "lora", Provider: "liblib", Title: "portrait", Version: liblibLoRATestID, Status: "validated"}}}
	encoded, _ := json.Marshal(style)
	intent := ModelRequestIntent{Capability: "image", styleProfileJSON: string(encoded)}
	if err := (&Service{}).validateLoRAIntentForRoute(valid, intent); err != nil {
		t.Fatal("compatible project LoRA route was rejected:", err)
	}
	capability := CapabilitySpec{Version: 1, Capability: "image"}
	routes := []cachedLogicalRoute{
		{Route: model.LogicalModelRoute{ID: "other", Enabled: true, Weight: 100, Priority: 10}, ChannelModel: other, CapabilitySpec: capability},
		{Route: model.LogicalModelRoute{ID: "liblib", Enabled: true, Weight: 1, Priority: 1}, ChannelModel: valid, CapabilitySpec: capability},
	}
	eligible := (&Service{}).eligibleLogicalRoutes(routes, intent, nil, false)
	if len(eligible) != 1 || eligible[0].Route.ID != "liblib" {
		t.Fatalf("strict project LoRA selected a route without its adapter: %#v", eligible)
	}
	if remaining := (&Service{}).eligibleLogicalRoutes(routes, intent, map[string]bool{"liblib": true}, false); len(remaining) != 0 {
		t.Fatal("project LoRA retry silently dropped its required adapter")
	}
	style.ExecutionPolicy = "compatible-fallback"
	encoded, _ = json.Marshal(style)
	intent.styleProfileJSON = string(encoded)
	if eligible := (&Service{}).eligibleLogicalRoutes(routes, intent, nil, false); len(eligible) != 1 || eligible[0].Route.ID != "other" {
		t.Fatal("compatible-fallback project style lost its allowed fallback")
	}
}
