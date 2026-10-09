package app

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"math"
	"testing"

	"yingce/backend/internal/assets"
	"yingce/backend/internal/generation"
	"yingce/backend/internal/model"
	"yingce/backend/internal/protocol"
)

func controlNetTestInput() canvasGenerationInput {
	media := generation.Media{StorageKey: "resource:ref-one", Width: 2, Height: 2, Bytes: 100, MimeType: "image/png"}
	return canvasGenerationInput{Mode: "image", Prompt: "panda", Config: providerConfig{InterfaceType: "liblib-image", Size: "1024x1024"}, ControlNet: []generation.ControlNetUnit{{ID: "unit1", Image: media, Parameters: generation.ControlNetParameters{Preprocessor: "canny", Model: "control-model", Strength: .6, End: .6, ControlMode: "balanced", ResizeMode: "stretch", Canny: &generation.CannyParameters{Resolution: 512, LowThreshold: 100, HighThreshold: 200}}}}, OutputMask: &generation.OutputMask{Image: media, Mode: "non-black", ResizeMode: "stretch"}}
}

func TestControlNetCapabilityAndGeometryValidation(t *testing.T) {
	for name, change := range map[string]func(*canvasGenerationInput, *ImageCapabilityConfig){
		"unsupported":   func(_ *canvasGenerationInput, p *ImageCapabilityConfig) { p.ControlNet = nil },
		"missing model": func(i *canvasGenerationInput, _ *ImageCapabilityConfig) { i.ControlNet[0].Parameters.Model = "" },
		"too many": func(i *canvasGenerationInput, _ *ImageCapabilityConfig) {
			i.ControlNet = append(i.ControlNet, i.ControlNet[0])
		},
		"unknown processor": func(i *canvasGenerationInput, _ *ImageCapabilityConfig) {
			i.ControlNet[0].Parameters.Preprocessor = "depth"
		},
		"invalid weight": func(i *canvasGenerationInput, _ *ImageCapabilityConfig) {
			i.ControlNet[0].Parameters.Strength = math.NaN()
		},
		"uncatalogued model": func(_ *canvasGenerationInput, p *ImageCapabilityConfig) { p.ControlNet.Models = []string{"another"} },
		"mutable url": func(i *canvasGenerationInput, _ *ImageCapabilityConfig) {
			i.OutputMask.Image.StorageKey = ""
			i.OutputMask.Image.URL = "https://example.com/mask.png"
		},
		"misaligned crop": func(i *canvasGenerationInput, _ *ImageCapabilityConfig) {
			i.ControlNet[0].Parameters.ResizeMode = "crop"
		},
		"misaligned aspect":      func(i *canvasGenerationInput, _ *ImageCapabilityConfig) { i.OutputMask.Image.Height = 3 },
		"invalid mask transform": func(i *canvasGenerationInput, _ *ImageCapabilityConfig) { i.OutputMask.ResizeMode = "crop" },
		"control mask dimensions": func(i *canvasGenerationInput, _ *ImageCapabilityConfig) {
			mask := i.ControlNet[0].Image
			mask.Width = 3
			i.ControlNet[0].Mask = &mask
		},
	} {
		t.Run(name, func(t *testing.T) {
			input := controlNetTestInput()
			profile := DefaultImageCapabilityConfig("liblib-image", "test")
			change(&input, profile)
			if validateImageTask(profile, input) == nil {
				t.Fatal("invalid control task accepted")
			}
		})
	}
	input := controlNetTestInput()
	if err := validateImageTask(DefaultImageCapabilityConfig("liblib-image", "test"), input); err != nil {
		t.Fatal(err)
	}
	input.ControlNet = nil
	if err := validateImageTask(DefaultImageCapabilityConfig("openai-image", "test"), input); err != nil {
		t.Fatalf("host output mask incorrectly requires ControlNet: %v", err)
	}
}

func TestControlNetAdmissionFreezesOwnedResourceFacts(t *testing.T) {
	s, db, pixels := cloudAgentVisionFixture(t)
	if err := db.Model(&model.Resource{}).Where("id = ?", "ref-one").Updates(map[string]any{"width": 3000, "height": 2000}).Error; err != nil {
		t.Fatal(err)
	}
	input := controlNetTestInput()
	input.ControlNet[0].Image.URL = "https://example.com/replacement.png"
	input.ControlNet[0].Image.DataURL = "data:image/png;base64,attacker"
	input.ControlNet[0].Image.Width = 4096
	data, _ := json.Marshal(input)
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatal(err)
	}
	if err := s.prepareControlNetTaskInput("other-user", raw); err == nil {
		t.Fatal("foreign resources accepted")
	}
	if err := s.prepareControlNetTaskInput("user", raw); err != nil {
		t.Fatal(err)
	}
	data, _ = json.Marshal(raw)
	if err := json.Unmarshal(data, &input); err != nil {
		t.Fatal(err)
	}
	if image := input.ControlNet[0].Image; image.URL != "" || image.DataURL != "" || image.Width != 2 {
		t.Fatalf("untrusted input survived: %+v", image)
	}
	if err := s.hydrateGenerationMedia("user", &input, providerMediaHydrationPolicy{}); err != nil {
		t.Fatal(err)
	}
	if input.ControlNet[0].Image.DataURL != "data:image/png;base64,"+base64.StdEncoding.EncodeToString(pixels) {
		t.Fatal("did not hydrate owned bytes")
	}
	refs, err := assets.CollectDocumentResourceReferences(string(data))
	if err != nil || len(refs) != 2 {
		t.Fatalf("durable task resource references lost: %#v %v", refs, err)
	}
}

func TestControlledInputsRejectExecutorsThatIgnoreThem(t *testing.T) {
	for _, name := range []string{"unknown", "runninghub-workflow-image", "legacy-image"} {
		input := controlNetTestInput()
		input.Config.InterfaceType = name
		if _, err := runImageTask(context.Background(), input); err == nil {
			t.Fatalf("%s ignored control input", name)
		}
		input.ControlNet = nil
		if _, err := runImageTask(context.Background(), input); err == nil {
			t.Fatalf("%s ignored output mask", name)
		}
	}
}

func TestInspectControlImageRejectsCorruptionBeforeSubmission(t *testing.T) {
	_, _, pixels := cloudAgentVisionFixture(t)
	for _, data := range [][]byte{nil, []byte("not an image"), pixels[:len(pixels)/2]} {
		if inspectControlImage(data, &generation.Media{}) == nil {
			t.Fatal("invalid image accepted")
		}
	}
}

func TestControlNetProtocolAndRoutingKeepReferenceRolesSeparate(t *testing.T) {
	input := controlNetTestInput()
	input.ControlNet[0].Image.DataURL = "data:image/png;base64,pixels"
	request := protocolRequestFromInput(input)
	if len(request.Images) != 0 || len(request.Inputs) != 0 || len(request.ControlNet) != 1 || request.ControlNet[0].Image.Role != "control_image" {
		t.Fatalf("controls leaked into ordinary references: %#v", request)
	}
	raw, err := normalizeTaskInput(map[string]any{"mode": "image", "controlNet": input.ControlNet})
	if err != nil {
		t.Fatal(err)
	}
	intent := ModelRequestIntentFromTaskInput(raw, "canvas_image", "")
	if intent.Inputs["image"] != 0 || intent.Inputs["control_image"] != 1 {
		t.Fatalf("wrong routing inputs: %#v", intent)
	}
	spec, err := CapabilitySpecFromModelCapabilityConfig(&ModelCapabilityConfig{Version: 1, Image: DefaultImageCapabilityConfig("liblib-image", "test")}, "image")
	if err != nil {
		t.Fatal(err)
	}
	if !MatchCapability(spec, intent).Matched {
		t.Fatal("compatible control route excluded")
	}
	delete(spec.Inputs, "control_image")
	if MatchCapability(spec, intent).Matched {
		t.Fatal("ordinary route silently accepts control request")
	}
}

func TestControlNetCapabilityDefaultPreservesExplicitDisable(t *testing.T) {
	profile := DefaultImageCapabilityConfig(protocol.LiblibImageProtocolID, "")
	profile.ControlNet = nil
	got, err := NormalizeModelCapabilityConfigForModel("image", protocol.LiblibImageProtocolID, "", &ModelCapabilityConfig{Image: profile})
	if err != nil || got.Image.ControlNet == nil || !got.Image.ControlNet.Supported {
		t.Fatalf("missing protocol default: %+v %v", got, err)
	}
	if profile.ControlNet != nil {
		t.Fatal("normalization mutated caller draft")
	}
	profile.ControlNet = &generation.ControlNetCapability{Supported: false}
	got, err = NormalizeModelCapabilityConfigForModel("image", protocol.LiblibImageProtocolID, "", &ModelCapabilityConfig{Image: profile})
	if err != nil || got.Image.ControlNet.Supported {
		t.Fatal("explicit disable was overwritten")
	}
}

func TestLiblibAdmissionRejectsMissingConfigurationBeforeExecution(t *testing.T) {
	s, _, _ := cloudAgentVisionFixture(t)
	input := map[string]any{"mode": "image", "prompt": "panda", "config": map[string]any{"interfaceType": protocol.LiblibImageProtocolID, "size": "1024x1024"}}
	if err := s.ValidateTaskCapability(input); err == nil {
		t.Fatal("Liblib task with missing template/config accepted")
	}
	options := map[string]any{"family": "f1", "templateUuid": "00000000000000000000000000000001", "steps": 20}
	input["metadata"] = map[string]any{"providerOptions": map[string]any{protocol.LiblibImageProtocolID: options}}
	if err := s.ValidateTaskCapability(input); err != nil {
		t.Fatalf("valid pre-upload config rejected: %v", err)
	}
	input["referenceImages"] = []any{map[string]any{"storageKey": "resource:ref-one"}}
	if err := s.ValidateTaskCapability(input); err == nil {
		t.Fatal("resource-only img2img silently admitted as txt2img without denoisingStrength")
	}
	options["denoisingStrength"] = .7
	if err := s.ValidateTaskCapability(input); err != nil {
		t.Fatalf("valid resource-only img2img rejected: %v", err)
	}
	options["family"], options["sampler"], options["cfgScale"] = "sd", 1, 7
	config := input["config"].(map[string]any)
	config["model"], config["providerModelKey"] = "friendly-name", "00000000000000000000000000000002"
	if err := s.ValidateTaskCapability(input); err != nil {
		t.Fatalf("resolved provider checkpoint incorrectly validated as logical model name: %v", err)
	}
}
