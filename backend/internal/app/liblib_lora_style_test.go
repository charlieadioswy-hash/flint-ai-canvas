package app

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"gorm.io/gorm"

	"yingce/backend/internal/generation"
	"yingce/backend/internal/model"
	"yingce/backend/internal/protocol"
)

func liblibProjectStyleTestJSON(t *testing.T, name, network, policy string) string {
	t.Helper()
	style := styleProfileDocument{SchemaVersion: 1, PresetID: "project-style", Title: "Project style", Prompt: "style-" + name, Source: "user", Revision: 1, ExecutionPolicy: policy, Assets: []styleProfileAsset{}}
	if network != "" {
		style.Assets = []styleProfileAsset{{ID: "project-lora", Kind: "lora", Provider: "liblib", Title: "Style " + name, Version: network, Status: "validated"}}
	}
	encoded, err := json.Marshal(style)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

func liblibProjectStyleTestService(t *testing.T, current string) (*Service, *gorm.DB, model.ChannelModel) {
	t.Helper()
	svc, db, _, _ := creationTestService(t)
	_, imageProfile := liblibLoRATestInput()
	imageProfile.LoRA.Models = nil
	for _, letter := range []string{"a", "b", "c"} {
		imageProfile.LoRA.Models = append(imageProfile.LoRA.Models, generation.LoRAModelConfig{ID: strings.Repeat(letter, 32), Name: letter, BaseModel: "sdxl", TriggerWords: []string{"trusted-" + letter}})
	}
	cm := verifiedLiblibChannelModel(t)
	cm.Enabled, cm.PriceConfigured, cm.BillingMode, cm.UnitPriceMicrocredits = true, true, "fixed_request", 100
	cm.CapabilityConfigJSON = mustEncodeModelCapabilityConfig(t, &ModelCapabilityConfig{Version: 1, Image: imageProfile})
	for _, row := range []any{
		&model.ModelChannel{ID: cm.ChannelID, Scope: model.ChannelScopeSystem, Name: "Liblib", Enabled: true, BaseURL: "https://openapi.liblibai.cloud", APIKey: "test-access", SecretKey: "test-secret"},
		&cm,
		&model.ChannelModelPriceTier{ID: "liblib-tier", ChannelModelID: cm.ID, SelectorKey: "{}", SelectorJSON: "{}", ProviderModelKey: cm.ProviderModelKey, BillingMode: "fixed_request", UnitPriceMicrocredits: 100, PriceConfigured: true, Enabled: true},
		&model.Project{ID: "style-project", UserID: "user", Name: "Style project", Status: model.ProjectStatusActive, StyleProfileJSON: current},
		&model.CanvasProject{ID: "style-canvas", UserID: "user", ProjectID: "style-project", PayloadJSON: `{"nodes":[],"connections":[]}`},
	} {
		if err := db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	return svc, db, cm
}

func liblibProjectStyleTestRequest(cm model.ChannelModel, clientStyle string) CreateTaskRequest {
	metadata := map[string]any{}
	prompt := "subject"
	if clientStyle != "" {
		metadata["styleProfileJson"] = clientStyle
		metadata["styleExecutionPlan"] = map[string]any{"prompt": "style-a"}
		prompt += "\n\n【项目画风执行规范】\nstyle-a"
	}
	return CreateTaskRequest{Type: "canvas_image", ProjectID: "style-canvas", Prompt: "subject", Input: map[string]any{
		"mode": "image", "prompt": prompt,
		"config":   map[string]any{"channelId": cm.ChannelID, "model": cm.ModelKey, "size": "768x1024", "count": "1"},
		"metadata": metadata, liblibLoRASnapshotKey: "untrusted-client-snapshot",
	}}
}

func restoreLiblibProjectStyleTestInput(t *testing.T, svc *Service, taskID string) canvasGenerationInput {
	t.Helper()
	task, err := svc.repo.Task(taskID)
	if err != nil {
		t.Fatal(err)
	}
	var input canvasGenerationInput
	if err := json.Unmarshal([]byte(task.InputJSON), &input); err != nil {
		t.Fatal(err)
	}
	return input
}

func TestLiblibLoRAProjectStyleAdmissionAndRecoveryUseOneServerRevision(t *testing.T) {
	for _, policy := range []string{"strict-assets", "compatible-fallback"} {
		t.Run(policy, func(t *testing.T) {
			current := liblibProjectStyleTestJSON(t, "b", strings.Repeat("b", 32), policy)
			svc, db, cm := liblibProjectStyleTestService(t, current)
			stale := liblibProjectStyleTestJSON(t, "a", strings.Repeat("a", 32), policy)
			task, err := svc.CreateTask("user", liblibProjectStyleTestRequest(cm, stale))
			if err != nil {
				t.Fatal("stale canvas prevented admission using the current server style:", err)
			}
			input := restoreLiblibProjectStyleTestInput(t, svc, task.ID)
			if task.Status != model.TaskStatusQueued || input.LiblibLoRA == nil || len(input.LiblibLoRA.Networks) != 1 || input.LiblibLoRA.Networks[0].ModelID != strings.Repeat("b", 32) || input.LiblibLoRA.StyleProfileJSON == nil || *input.LiblibLoRA.StyleProfileJSON != current {
				t.Fatalf("admission froze stale or forged style/LoRA: %#v", input.LiblibLoRA)
			}
			if metadataString(input.Metadata, "styleProfileJson") != current || task.Prompt != "subject" {
				t.Fatal("trusted style metadata or the original user prompt changed incorrectly")
			}
			later := liblibProjectStyleTestJSON(t, "c", strings.Repeat("c", 32), policy)
			if err := db.Model(&model.Project{}).Where("id = ?", "style-project").Update("style_profile_json", later).Error; err != nil {
				t.Fatal(err)
			}
			// Simulate recovery after queue persistence and a concurrent project edit.
			input.Config, err = svc.resolveProviderConfig(input.Config)
			if err != nil {
				t.Fatal(err)
			}
			if err := svc.applyGenerationStyleProfile("user", task.ProjectID, &input); err != nil {
				t.Fatal("queued style became incompatible after a project edit:", err)
			}
			if err := svc.validateResolvedImageCapability(&input); err != nil {
				t.Fatal(err)
			}
			request, err := prepareLiblibProtocolRequest(context.Background(), input, protocolRequestFromInput(input))
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(request.Prompt, "style-b") || !strings.Contains(request.Prompt, "trusted-b") || strings.Contains(request.Prompt, "style-a") || strings.Contains(request.Prompt, "style-c") || strings.Contains(request.Prompt, "trusted-a") || strings.Contains(request.Prompt, "trusted-c") {
				t.Fatalf("prompt and automatic LoRA use different revisions: %q", request.Prompt)
			}
			networks, err := protocol.NormalizeLiblibAdditionalNetworks(request.ProviderOptions[protocol.LiblibImageProtocolID]["additionalNetwork"])
			if err != nil || len(networks) != 1 || networks[0].ModelID != strings.Repeat("b", 32) {
				t.Fatalf("recovery changed the frozen LoRA: %#v %v", networks, err)
			}
			// A new task resolves the next server revision instead of reusing B.
			next, err := svc.CreateTask("user", liblibProjectStyleTestRequest(cm, stale))
			if err != nil {
				t.Fatal(err)
			}
			if nextInput := restoreLiblibProjectStyleTestInput(t, svc, next.ID); nextInput.LiblibLoRA.Networks[0].ModelID != strings.Repeat("c", 32) {
				t.Fatal("new admission reused the prior task's style")
			}
		})
	}
}

func TestLiblibLoRAProjectStyleHandlesMissingAndClearedMetadata(t *testing.T) {
	for _, tc := range []struct {
		name, current, client string
		wantNetwork           bool
	}{
		{"missing client metadata", liblibProjectStyleTestJSON(t, "b", strings.Repeat("b", 32), "strict-assets"), "", true},
		{"cleared project style", "", liblibProjectStyleTestJSON(t, "a", strings.Repeat("a", 32), "strict-assets"), false},
		{"no style", "", "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			svc, db, cm := liblibProjectStyleTestService(t, tc.current)
			task, err := svc.CreateTask("user", liblibProjectStyleTestRequest(cm, tc.client))
			if err != nil {
				t.Fatal(err)
			}
			input := restoreLiblibProjectStyleTestInput(t, svc, task.ID)
			if input.LiblibLoRA == nil || input.LiblibLoRA.StyleProfileJSON == nil || (len(input.LiblibLoRA.Networks) == 1) != tc.wantNetwork {
				t.Fatalf("wrong style/LoRA snapshot: %#v", input.LiblibLoRA)
			}
			if !tc.wantNetwork && (metadataString(input.Metadata, "styleProfileJson") != "" || input.Prompt != "subject") {
				t.Fatal("cleared project retained stale automatic style inputs")
			}
			later := liblibProjectStyleTestJSON(t, "c", strings.Repeat("c", 32), "strict-assets")
			if err := db.Model(&model.Project{}).Where("id = ?", "style-project").Update("style_profile_json", later).Error; err != nil {
				t.Fatal(err)
			}
			if err := svc.applyGenerationStyleProfile("user", task.ProjectID, &input); err != nil {
				t.Fatal("frozen empty style was replaced during recovery:", err)
			}
			if !tc.wantNetwork && input.Prompt != "subject" {
				t.Fatal("recovery injected a style into a task admitted without one")
			}
		})
	}
}

func TestLiblibLoRAProjectStyleClearingCleansFallbackPrompt(t *testing.T) {
	for _, tc := range []struct {
		name, inputPrompt, prompt string
		omit, wantError           bool
	}{
		{"omitted input prompt", "", "subject\n\n【项目画风执行规范】\nstyle-a", true, false},
		{"blank input prompt", "  ", "subject\n\n【项目画风执行规范】\nstyle-a", false, false},
		{"style-only fallback", "", "【项目画风执行规范】\nstyle-a", true, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			svc, _, cm := liblibProjectStyleTestService(t, "")
			req := liblibProjectStyleTestRequest(cm, liblibProjectStyleTestJSON(t, "a", strings.Repeat("a", 32), "strict-assets"))
			req.Prompt, req.Input["prompt"] = tc.prompt, tc.inputPrompt
			if tc.omit {
				delete(req.Input, "prompt")
			}
			task, err := svc.CreateTask("user", req)
			if tc.wantError {
				if err == nil || !strings.Contains(err.Error(), "prompt is required") {
					t.Fatalf("style-only fallback must fail before queueing: %v", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			input := restoreLiblibProjectStyleTestInput(t, svc, task.ID)
			if input.Prompt != "subject" || len(input.LiblibLoRA.Networks) != 0 || metadataString(input.Metadata, "styleProfileJson") != "" {
				t.Fatalf("fallback resurrected cleared style: %#v", input)
			}
		})
	}
}

func TestProjectStyleAdmissionPreservesOwnershipLegacyPresetAndLiveProviders(t *testing.T) {
	current := liblibProjectStyleTestJSON(t, "b", "", "compatible-fallback")
	svc, db, cm := liblibProjectStyleTestService(t, current)
	stale := liblibProjectStyleTestJSON(t, "a", "", "compatible-fallback")
	input := liblibProjectStyleTestRequest(cm, stale).Input
	delete(input, liblibLoRASnapshotKey)
	input["referenceImages"] = []any{map[string]any{"url": "https://example.com/user-reference.png"}}
	if err := svc.prepareTaskProjectStyleProfile("user", "style-canvas", "subject", input); err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(input)
	var execution canvasGenerationInput
	if err := json.Unmarshal(encoded, &execution); err != nil {
		t.Fatal(err)
	}
	execution.Config.InterfaceType = "openai-images"
	later := liblibProjectStyleTestJSON(t, "c", "", "compatible-fallback")
	if err := db.Model(&model.Project{}).Where("id = ?", "style-project").Update("style_profile_json", later).Error; err != nil {
		t.Fatal(err)
	}
	if err := svc.applyGenerationStyleProfile("user", "style-canvas", &execution); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(execution.Prompt, "style-c") || strings.Contains(execution.Prompt, "style-a") || strings.Contains(execution.Prompt, "style-b") || len(execution.ReferenceImages) != 1 || execution.ReferenceImages[0].URL != "https://example.com/user-reference.png" {
		t.Fatalf("live provider refresh or explicit reference changed: %#v", execution)
	}
	// A user's canvas cannot make another user's linked project a trusted source.
	if err := db.Model(&model.Project{}).Where("id = ?", "style-project").Update("user_id", "other-user").Error; err != nil {
		t.Fatal(err)
	}
	if err := svc.prepareTaskProjectStyleProfile("user", "style-canvas", "subject", input); err == nil {
		t.Fatal("foreign linked project became a trusted style source")
	}
	standalone := liblibProjectStyleTestRequest(cm, stale).Input
	if err := svc.prepareTaskProjectStyleProfile("user", "style-project", "subject", standalone); err != nil || metadataString(standalone["metadata"].(map[string]any), "styleProfileJson") != stale {
		t.Fatalf("foreign direct project leaked its style: %v", err)
	}
	if err := db.Model(&model.Project{}).Where("id = ?", "style-project").Updates(map[string]any{"user_id": "user", "style_profile_json": "", "style_preset_id": "project-style"}).Error; err != nil {
		t.Fatal(err)
	}
	if err := svc.prepareTaskProjectStyleProfile("user", "style-canvas", "subject", standalone); err != nil {
		t.Fatal("matching legacy preset rejected:", err)
	}
	standalone["metadata"].(map[string]any)["styleProfileJson"] = strings.Replace(stale, "project-style", "other-preset", 1)
	if err := svc.prepareTaskProjectStyleProfile("user", "style-canvas", "subject", standalone); err == nil {
		t.Fatal("legacy preset allowed a different client style")
	}
}

func TestLiblibLoRAProjectStyleLogicalRoutingQuoteAndRetryKeepAdmissionRevision(t *testing.T) {
	current := liblibProjectStyleTestJSON(t, "b", strings.Repeat("b", 32), "strict-assets")
	svc, db, cm := liblibProjectStyleTestService(t, current)
	if err := db.Create(&model.SystemSetting{Key: featureAvailabilitySettingKey, ValueJSON: `{"frontendModelsEnabled":true}`}).Error; err != nil {
		t.Fatal(err)
	}
	logical := model.LogicalModel{ID: "style-logical", Code: "style-image", Name: "Style image", Capability: "image", Enabled: true, ActiveRevisionID: "style-revision", PricePolicy: "channel"}
	for index, letter := range []string{"a", "b", "c"} {
		item := cm
		item.ID, item.ModelKey = "style-model-"+letter, "style-image-"+letter
		profile, err := DecodeModelCapabilityConfig(item.CapabilityConfigJSON)
		if err != nil {
			t.Fatal(err)
		}
		profile.Image.LoRA.Models = []generation.LoRAModelConfig{profile.Image.LoRA.Models[index]}
		item.CapabilityConfigJSON = mustEncodeModelCapabilityConfig(t, profile)
		for _, row := range []any{
			&item,
			&model.ChannelModelPriceTier{ID: "style-tier-" + letter, ChannelModelID: item.ID, SelectorKey: "{}", SelectorJSON: "{}", ProviderModelKey: item.ProviderModelKey, BillingMode: "fixed_request", UnitPriceMicrocredits: 100, PriceConfigured: true, Enabled: true},
			&model.LogicalModelRoute{ID: "style-route-" + letter, LogicalModelRevisionID: logical.ActiveRevisionID, ChannelModelID: item.ID, Enabled: true, Priority: index, Weight: 1},
		} {
			if err := db.Create(row).Error; err != nil {
				t.Fatal(err)
			}
		}
	}
	stored, err := svc.repo.ChannelModel("style-model-b")
	if err != nil {
		t.Fatal(err)
	}
	spec, err := channelModelCapabilitySpec(*stored, svc.protocolRegistry())
	if err != nil {
		t.Fatal(err)
	}
	specJSON, _ := json.Marshal(spec)
	for _, row := range []any{&logical, &model.LogicalModelRevision{ID: logical.ActiveRevisionID, LogicalModelID: logical.ID, Version: 1, CapabilitySpecJSON: string(specJSON), DefaultOptionsJSON: "{}"}} {
		if err := db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	req := liblibProjectStyleTestRequest(cm, liblibProjectStyleTestJSON(t, "a", strings.Repeat("a", 32), "strict-assets"))
	req.LogicalModelID = logical.ID
	delete(req.Input["config"].(map[string]any), "channelId")
	task, err := svc.CreateTask("user", req)
	if err != nil {
		t.Fatal("routing used stale client A instead of current B:", err)
	}
	private, err := svc.repo.Task(task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if private.RouteID != "style-route-b" {
		t.Fatalf("wrong route at admission: %s", private.RouteID)
	}
	var retryInput map[string]any
	if err := json.Unmarshal([]byte(private.InputJSON), &retryInput); err != nil {
		t.Fatal(err)
	}
	quote, err := svc.QuoteLogicalModel(logical.ID, ModelRequestIntentFromTaskInput(retryInput, task.Type, task.Operation))
	if err != nil || quote.AmountMicrocredits != 100 {
		t.Fatalf("admitted LoRA and quote diverged: %#v %v", quote, err)
	}
	later := liblibProjectStyleTestJSON(t, "c", strings.Repeat("c", 32), "strict-assets")
	if err := db.Model(&model.Project{}).Where("id = ?", "style-project").Update("style_profile_json", later).Error; err != nil {
		t.Fatal(err)
	}
	if err := svc.prepareLogicalTaskRetry(private, retryInput); err != nil {
		t.Fatal("retry stopped using original admitted B:", err)
	}
	var retried canvasGenerationInput
	if err := json.Unmarshal([]byte(private.InputJSON), &retried); err != nil {
		t.Fatal(err)
	}
	if private.RouteID != "style-route-b" || retried.LiblibLoRA == nil || *retried.LiblibLoRA.StyleProfileJSON != current || retried.LiblibLoRA.Networks[0].ModelID != strings.Repeat("b", 32) {
		t.Fatalf("retry changed admitted style/LoRA revision: %#v", retried.LiblibLoRA)
	}
	next, err := svc.CreateTask("user", req)
	if err != nil {
		t.Fatal(err)
	}
	nextPrivate, err := svc.repo.Task(next.ID)
	if err != nil || nextPrivate.RouteID != "style-route-c" {
		t.Fatalf("new task did not use current C: %#v %v", nextPrivate, err)
	}
}

func TestLiblibLoRAProjectStyleExplicitStyleToolOverridesProject(t *testing.T) {
	const token = "@[tool:style:42:Explicit style:palette]"
	for _, tc := range []struct {
		name, prompt, inputPrompt string
		omit, wantProject         bool
	}{
		{"explicit input", "subject " + token, "subject " + token + "\n\n【项目画风执行规范】\nstyle-a", false, false},
		{"omitted input falls back", "subject " + token, "", true, false},
		{"blank input falls back", "subject " + token, " ", false, false},
		{"display prompt does not override actual input", "subject " + token, "subject\n\n【项目画风执行规范】\nstyle-a", false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			current := liblibProjectStyleTestJSON(t, "b", strings.Repeat("b", 32), "strict-assets")
			svc, _, cm := liblibProjectStyleTestService(t, current)
			if _, err := svc.repo.CreateTool(&model.Tool{ID: 42, Type: "style", OwnerID: "user", Source: "user", Visibility: "private", Enabled: true, Prompt: "explicit-tool-style"}); err != nil {
				t.Fatal(err)
			}
			req := liblibProjectStyleTestRequest(cm, liblibProjectStyleTestJSON(t, "a", strings.Repeat("a", 32), "strict-assets"))
			req.Prompt, req.Input["prompt"] = tc.prompt, tc.inputPrompt
			if tc.omit {
				delete(req.Input, "prompt")
			}
			task, err := svc.CreateTask("user", req)
			if err != nil {
				t.Fatal("explicit style tool was blocked by the project style:", err)
			}
			input := restoreLiblibProjectStyleTestInput(t, svc, task.ID)
			if input.LiblibLoRA == nil || input.LiblibLoRA.StyleProfileJSON == nil {
				t.Fatal("Liblib style choice was not frozen")
			}
			if tc.wantProject {
				if len(input.LiblibLoRA.Networks) != 1 || *input.LiblibLoRA.StyleProfileJSON != current {
					t.Fatal("display-only token overrode the actual generation prompt")
				}
				return
			}
			if len(input.LiblibLoRA.Networks) != 0 || *input.LiblibLoRA.StyleProfileJSON != "" || metadataString(input.Metadata, "styleProfileJson") != "" || !strings.Contains(input.Prompt, token) {
				t.Fatalf("project style/LoRA mixed with explicit style tool: %#v", input.LiblibLoRA)
			}
			input.Config, err = svc.resolveProviderConfig(input.Config)
			if err != nil {
				t.Fatal(err)
			}
			input.Prompt, err = svc.ResolveToolMentionTokens("user", input.Mode, input.Prompt)
			if err != nil {
				t.Fatal(err)
			}
			if err := svc.applyGenerationStyleProfile("user", task.ProjectID, &input); err != nil {
				t.Fatal(err)
			}
			if err := svc.validateResolvedImageCapability(&input); err != nil {
				t.Fatal(err)
			}
			request, err := prepareLiblibProtocolRequest(context.Background(), input, protocolRequestFromInput(input))
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(request.Prompt, "explicit-tool-style") || strings.Contains(request.Prompt, "style-a") || strings.Contains(request.Prompt, "style-b") || strings.Contains(request.Prompt, "trusted-b") {
				t.Fatalf("execution restored project styling over the explicit tool: %q", request.Prompt)
			}
		})
	}
}

func TestLiblibLoRAProjectStyleMalformedToolPrefixCannotOverrideProject(t *testing.T) {
	for _, tc := range []struct{ name, prompt, inputPrompt string }{
		{"display prompt", "subject @[tool:style:", "subject"},
		{"generation prompt", "subject", "subject @[tool:style:"},
		{"ordinary text prefix", "describe @[tool:style: as plain text", "subject"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			svc, _, cm := liblibProjectStyleTestService(t, liblibProjectStyleTestJSON(t, "b", strings.Repeat("b", 32), "strict-assets"))
			req := liblibProjectStyleTestRequest(cm, "")
			req.Prompt, req.Input["prompt"] = tc.prompt, tc.inputPrompt
			if task, err := svc.CreateTask("user", req); task != nil || err == nil || !strings.Contains(err.Error(), "工具标签无效") {
				t.Fatalf("unrecognized style prefix reached project-style admission: %#v %v", task, err)
			}
		})
	}
}
