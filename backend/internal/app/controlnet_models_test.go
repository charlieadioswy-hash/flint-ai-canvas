package app

import (
	"encoding/json"
	"strings"
	"testing"

	"yingce/backend/internal/generation"
	"yingce/backend/internal/protocol"
)

const (
	controlNetDepthXLTestModel   = "6349e9dae8814084bd9c1585d335c24c"
	controlNetDepthSD15TestModel = "cf63d214734760dcdc108b1bd094921b"
	controlNetCustomTestModel    = "000000000000000000000000000000d1"
)

func controlNetSelectionTestInput(processor, controlType, modelID string, parameters map[string]float64) canvasGenerationInput {
	input := controlNetTestInput()
	input.ControlNet[0].Parameters = generation.ControlNetParameters{
		ControlType: controlType, Preprocessor: processor, Model: modelID,
		Strength: .6, End: .6, ControlMode: "balanced", ResizeMode: "stretch",
		ProcessorParameters: parameters,
	}
	return input
}

func controlNetDepthSelectionTestInput(modelID string) canvasGenerationInput {
	return controlNetSelectionTestInput("depth_leres", "depth", modelID, map[string]float64{
		"resolution": 512, "removeNear": 0, "removeBackground": 0,
	})
}

func TestLiblibControlNetModelSelectionAdmission(t *testing.T) {
	for _, tc := range []struct {
		name      string
		input     func() canvasGenerationInput
		configure func(*generation.ControlNetCapability)
		wantError string
	}{
		{
			name:  "depth accepts matching XL model inferred from checkpoint",
			input: func() canvasGenerationInput { return controlNetDepthSelectionTestInput(controlNetDepthXLTestModel) },
		},
		{
			name: "depth rejects Canny model",
			input: func() canvasGenerationInput {
				return controlNetDepthSelectionTestInput("b6806516962f4e1599a93ac4483c3d23")
			},
			wantError: "不兼容",
		},
		{
			name:      "XL checkpoint rejects SD15 depth model",
			input:     func() canvasGenerationInput { return controlNetDepthSelectionTestInput(controlNetDepthSD15TestModel) },
			wantError: "不兼容",
		},
		{
			name: "SD15 base rejects XL depth model",
			input: func() canvasGenerationInput {
				input := controlNetDepthSelectionTestInput(controlNetDepthXLTestModel)
				input.Config.Model = "00000000000000000000000000000015"
				return input
			},
			configure: func(c *generation.ControlNetCapability) { c.BaseModel = "sd15" },
			wantError: "不兼容",
		},
		{
			name: "InstantID keypoints rejects embedding model",
			input: func() canvasGenerationInput {
				return controlNetSelectionTestInput("instant_id_face_keypoints", "instant-id", "3a8267c7d45c11ee9b5e00163e365853", map[string]float64{"resolution": 512})
			},
			wantError: "不兼容",
		},
		{
			name: "InstantID embedding rejects keypoints model",
			input: func() canvasGenerationInput {
				return controlNetSelectionTestInput("instant_id_face_embedding", "instant-id", "3560664ad45c11ee9b5e00163e365853", map[string]float64{"resolution": 512})
			},
			wantError: "不兼容",
		},
		{
			name: "InstantID keypoints accepts matching model",
			input: func() canvasGenerationInput {
				return controlNetSelectionTestInput("instant_id_face_keypoints", "instant-id", "3560664ad45c11ee9b5e00163e365853", map[string]float64{"resolution": 512})
			},
		},
		{
			name: "InstantID embedding accepts matching model",
			input: func() canvasGenerationInput {
				return controlNetSelectionTestInput("instant_id_face_embedding", "instant-id", "3a8267c7d45c11ee9b5e00163e365853", map[string]float64{"resolution": 512})
			},
		},
		{
			name:      "unknown UUID requires administrator registration",
			input:     func() canvasGenerationInput { return controlNetDepthSelectionTestInput(controlNetCustomTestModel) },
			wantError: "登记",
		},
		{
			name:  "administrator registration accepts matching custom type and base",
			input: func() canvasGenerationInput { return controlNetDepthSelectionTestInput(controlNetCustomTestModel) },
			configure: func(c *generation.ControlNetCapability) {
				c.BaseModel = "sdxl"
				c.ModelCatalog = []generation.ControlNetModelConfig{{ID: controlNetCustomTestModel, Name: "Private depth", BaseModel: "sdxl", ControlTypes: []string{"depth"}}}
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			input := tc.input()
			profile := DefaultImageCapabilityConfig(protocol.LiblibImageProtocolID, verifiedLiblibSDCheckpoint)
			if tc.configure != nil {
				tc.configure(profile.ControlNet)
			}
			for name, err := range map[string]error{
				"image task": validateImageTask(profile, input),
				"selection":  validateLiblibControlNetSelection(profile.ControlNet, input, input.ControlNet[0]),
			} {
				if tc.wantError == "" {
					if err != nil {
						t.Fatalf("%s rejected compatible selection: %v", name, err)
					}
				} else if err == nil || !strings.Contains(err.Error(), tc.wantError) {
					t.Fatalf("%s error = %v; want rejection containing %q", name, err, tc.wantError)
				}
			}
		})
	}
}

func TestLiblibReferenceAdmissionUsesSD15WithoutControlModel(t *testing.T) {
	input := controlNetSelectionTestInput("reference_only", "reference", "", map[string]float64{"styleFidelity": .5})
	input.Config.Model = "00000000000000000000000000000015"
	profile := DefaultImageCapabilityConfig(protocol.LiblibImageProtocolID, input.Config.Model)
	profile.ControlNet.BaseModel = "sd15"
	if err := validateImageTask(profile, input); err != nil {
		t.Fatalf("SD15 Reference with None model rejected: %v", err)
	}
	profile.ControlNet.BaseModel = "sdxl"
	if err := validateImageTask(profile, input); err == nil || !strings.Contains(err.Error(), "Reference") {
		t.Fatalf("Reference accepted outside SD15: %v", err)
	}
	profile.ControlNet.BaseModel = "sd15"
	input.ControlNet[0].Parameters.Model = controlNetDepthSD15TestModel
	if err := validateImageTask(profile, input); err == nil || !strings.Contains(err.Error(), "None") {
		t.Fatalf("Reference accepted a control model: %v", err)
	}
}

func TestLiblibControlNetAdmissionRejectsContradictoryBaseConfiguration(t *testing.T) {
	for _, tc := range []struct {
		name, base, family, checkpoint, modelID string
	}{
		{"SD15 base conflicts with verified XL checkpoint", "sd15", "sd", verifiedLiblibSDCheckpoint, controlNetDepthSD15TestModel},
		{"F1 base conflicts with SD family", "f1", "sd", "000000000000000000000000000000f1", "13c1e1b96ba64f9cbb2b54f89b5fe873"},
		{"XL base conflicts with F1 family", "sdxl", "f1", "0000000000000000000000000000000c", controlNetDepthXLTestModel},
	} {
		t.Run(tc.name, func(t *testing.T) {
			input := controlNetDepthSelectionTestInput(tc.modelID)
			input.Config.Model = tc.checkpoint
			input.Metadata = map[string]any{"providerOptions": map[string]any{protocol.LiblibImageProtocolID: map[string]any{"family": tc.family}}}
			profile := DefaultImageCapabilityConfig(protocol.LiblibImageProtocolID, tc.checkpoint)
			profile.ControlNet.BaseModel = tc.base
			for name, err := range map[string]error{
				"image task": validateImageTask(profile, input),
				"selection":  validateLiblibControlNetSelection(profile.ControlNet, input, input.ControlNet[0]),
			} {
				if err == nil {
					t.Fatalf("%s accepted contradictory base=%q family=%q checkpoint=%q", name, tc.base, tc.family, tc.checkpoint)
				}
			}
		})
	}
}

func TestLiblibInpaintAdmissionKeepsControlMaskSeparate(t *testing.T) {
	input := controlNetSelectionTestInput("inpaint_global_harmonious", "inpaint", "a311363995dd4f2fa42ee3fc9582d920", nil)
	profile := DefaultImageCapabilityConfig(protocol.LiblibImageProtocolID, verifiedLiblibSDCheckpoint)
	input.Mask = &providerMedia{StorageKey: "resource:ordinary-inpaint-mask"}
	if err := validateImageTask(profile, input); err == nil || !strings.Contains(err.Error(), "独立的控制区域蒙版") {
		t.Fatalf("ordinary editing mask or output mask satisfied a missing control mask: %v", err)
	}
	input.Mask = nil
	mask := input.ControlNet[0].Image
	mask.StorageKey = "resource:control-inpaint-mask"
	input.ControlNet[0].Mask = &mask
	profile.References.MaskSupported = false
	if err := validateImageTask(profile, input); err != nil {
		t.Fatalf("control inpaint incorrectly required ordinary mask-editing support: %v", err)
	}
	input.Mask = &providerMedia{StorageKey: "resource:ordinary-inpaint-mask"}
	if err := validateImageTask(profile, input); err == nil || !strings.Contains(err.Error(), "不支持蒙版编辑") {
		t.Fatalf("ordinary editing mask bypassed its own capability check: %v", err)
	}
	input.Mask = nil
	input.ControlNet[0].Mask.Width++
	if err := validateImageTask(profile, input); err == nil || !strings.Contains(err.Error(), "同尺寸") {
		t.Fatalf("misaligned control inpaint mask accepted: %v", err)
	}
}

func TestLiblibControlNetCatalogAdmissionProtectsOfficialCompatibility(t *testing.T) {
	for _, tc := range []struct {
		name      string
		catalog   []generation.ControlNetModelConfig
		wantError bool
	}{
		{"matching custom registration", []generation.ControlNetModelConfig{{ID: controlNetCustomTestModel, Name: "Private depth", BaseModel: "sdxl", ControlTypes: []string{"depth"}}}, false},
		{"matching official metadata", []generation.ControlNetModelConfig{{ID: controlNetDepthXLTestModel, Name: "Depth", BaseModel: "sdxl", ControlTypes: []string{"depth"}}}, false},
		{"official base cannot change", []generation.ControlNetModelConfig{{ID: controlNetDepthXLTestModel, Name: "Depth", BaseModel: "sd15", ControlTypes: []string{"depth"}}}, true},
		{"official type cannot change", []generation.ControlNetModelConfig{{ID: controlNetDepthXLTestModel, Name: "Depth", BaseModel: "sdxl", ControlTypes: []string{"canny"}}}, true},
		{"official types cannot expand", []generation.ControlNetModelConfig{{ID: controlNetDepthXLTestModel, Name: "Depth", BaseModel: "sdxl", ControlTypes: []string{"depth", "canny"}}}, true},
		{"unknown type", []generation.ControlNetModelConfig{{ID: controlNetCustomTestModel, Name: "Private depth", BaseModel: "sdxl", ControlTypes: []string{"unregistered-type"}}}, true},
		{"duplicate model", []generation.ControlNetModelConfig{
			{ID: controlNetCustomTestModel, Name: "Private depth", BaseModel: "sdxl", ControlTypes: []string{"depth"}},
			{ID: controlNetCustomTestModel, Name: "Other model", BaseModel: "sdxl", ControlTypes: []string{"canny"}},
		}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			profile := DefaultModelCapabilityConfigForModel(protocol.LiblibImageProtocolID, verifiedLiblibSDCheckpoint)
			profile.Image.ControlNet.BaseModel = "sdxl"
			profile.Image.ControlNet.ModelCatalog = tc.catalog
			_, err := NormalizeModelCapabilityConfigForModel("image", protocol.LiblibImageProtocolID, verifiedLiblibSDCheckpoint, profile)
			if (err != nil) != tc.wantError {
				t.Fatalf("catalog error = %v; wantError = %v", err, tc.wantError)
			}
		})
	}
}

func TestLiblibControlNetDefaultsSelectProcessorAndBaseCompatibleModel(t *testing.T) {
	for _, tc := range []struct {
		name, processor, base, checkpoint, wantModel string
		allowedModels                                []string
	}{
		{"Depth ignores global Canny preset", "depth_leres", "sdxl", verifiedLiblibSDCheckpoint, controlNetDepthXLTestModel, nil},
		{"Depth uses SD15 recommendation", "depth_leres", "sd15", "00000000000000000000000000000015", controlNetDepthSD15TestModel, nil},
		{"TEED uses its own XL recommendation", "softedge_teed", "sdxl", verifiedLiblibSDCheckpoint, "37bddde3d45c11ee9b5e00163e365853", nil},
		{"Depth uses F1 recommendation", "depth_leres", "f1", "000000000000000000000000000000f1", "13c1e1b96ba64f9cbb2b54f89b5fe873", nil},
		{"Canny-only model allowlist leaves Depth unconfigured", "depth_leres", "sdxl", verifiedLiblibSDCheckpoint, "", []string{"b6806516962f4e1599a93ac4483c3d23"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cm := verifiedLiblibChannelModel(t)
			cm.ProviderModelKey = tc.checkpoint
			family := "sd"
			if tc.base == "f1" {
				family = "f1"
			}
			cm.ProviderDefaults = map[string]any{"family": family, "controlNetModel": "b6806516962f4e1599a93ac4483c3d23", "steps": 20}
			profile := DefaultModelCapabilityConfigForModel(protocol.LiblibImageProtocolID, tc.checkpoint)
			profile.Image.ControlNet.BaseModel = tc.base
			profile.Image.ControlNet.Models = tc.allowedModels
			cm.CapabilityConfigJSON = mustEncodeModelCapabilityConfig(t, profile)
			parameters := map[string]any{"preprocessor": tc.processor, "model": ""}
			input := map[string]any{"mode": "image", "controlNet": []any{map[string]any{"id": "depth", "parameters": parameters}}}
			applyChannelProviderDefaults(input, cm)
			if parameters["model"] != tc.wantModel {
				t.Fatalf("default model = %v; want %q for %s/%s", parameters["model"], tc.wantModel, tc.base, tc.processor)
			}
		})
	}
}

func TestLiblibControlNetDefaultsFreezeAndPreserveExplicitModelsOnRouteSwitch(t *testing.T) {
	cm := verifiedLiblibChannelModel(t)
	explicitModel := "3156f3428afc7122c66b2b950f09d4cd"
	input := map[string]any{
		"mode":     "image",
		"metadata": map[string]any{"providerOptions": map[string]any{protocol.LiblibImageProtocolID: map[string]any{"steps": 32, "seed": 0, "negativePrompt": ""}}},
		"controlNet": []any{
			map[string]any{"id": "automatic", "parameters": map[string]any{"preprocessor": "depth_leres", "model": ""}},
			map[string]any{"id": "explicit", "parameters": map[string]any{"preprocessor": "depth_leres", "model": explicitModel}},
		},
	}
	applyChannelProviderDefaults(input, cm)
	encoded, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	var restored map[string]any
	if err := json.Unmarshal(encoded, &restored); err != nil {
		t.Fatal(err)
	}
	models := func() (string, string) {
		units := restored["controlNet"].([]any)
		return units[0].(map[string]any)["parameters"].(map[string]any)["model"].(string), units[1].(map[string]any)["parameters"].(map[string]any)["model"].(string)
	}
	otherDepthModel := "04dcab4b18c7b821e96660d6c19de50b"
	cm.ProviderDefaults = map[string]any{"controlNetModel": otherDepthModel, "sampler": 20, "steps": 40, "negativePrompt": "route default"}
	applyChannelProviderDefaults(restored, cm)
	if automatic, explicit := models(); automatic != controlNetDepthXLTestModel || explicit != explicitModel {
		t.Fatalf("same-route admin update changed frozen models: automatic=%q explicit=%q", automatic, explicit)
	}
	options := restored["metadata"].(map[string]any)["providerOptions"].(map[string]any)[protocol.LiblibImageProtocolID].(map[string]any)
	if options["sampler"] != float64(15) {
		t.Fatalf("same-route admin update changed frozen provider defaults: %#v", options)
	}
	cm.ID = "other-depth-route"
	applyChannelProviderDefaults(restored, cm)
	if automatic, explicit := models(); automatic != otherDepthModel || explicit != explicitModel {
		t.Fatalf("route switch failed to replace automatic model while retaining user model: automatic=%q explicit=%q", automatic, explicit)
	}
	options = restored["metadata"].(map[string]any)["providerOptions"].(map[string]any)[protocol.LiblibImageProtocolID].(map[string]any)
	if options["steps"] != float64(32) || options["seed"] != float64(0) || options["negativePrompt"] != "" || options["sampler"] != 20 {
		t.Fatalf("route switch lost explicit user values or retained old route defaults: %#v", options)
	}
}
