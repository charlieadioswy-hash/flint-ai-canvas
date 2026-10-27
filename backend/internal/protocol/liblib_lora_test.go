package protocol

import (
	"context"
	"math"
	"strings"
	"testing"
)

func TestLiblibLoRAWirePreservesInpaintAndControlNet(t *testing.T) {
	for _, inpaint := range []bool{false, true} {
		r := liblibTestRequest()
		if inpaint {
			r = liblibInpaintTestRequest()
		}
		r.ProviderOptions[LiblibImageProtocolID]["additionalNetwork"] = []any{
			map[string]any{"modelId": " AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA ", "weight": -4},
			map[string]any{"modelId": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},
			map[string]any{"modelId": "cccccccccccccccccccccccccccccccc", "weight": 0},
		}
		spec, err := LiblibImageAdapter().BuildCreate(context.Background(), RequestContext{Request: r})
		if err != nil {
			t.Fatal(err)
		}
		params := spec.Body.(map[string]any)["generateParams"].(map[string]any)
		networks := params["additionalNetwork"].([]LiblibAdditionalNetwork)
		if networks[0].ModelID != strings.Repeat("a", 32) || networks[0].Weight != -4 || networks[1].Weight != 0.8 || networks[2].Weight != 0 {
			t.Fatalf("LoRA values were altered: %#v", networks)
		}
		if len(params["controlNet"].([]any)) != 1 {
			t.Fatal("LoRA replaced independent ControlNet units")
		}
		if inpaint && (params["mode"] != 4 || params["inpaintParam"] == nil || spec.Path != "/api/generate/webui/img2img") {
			t.Fatal("LoRA disabled inpainting")
		}
		if !inpaint && (spec.Path != "/api/generate/webui/text2img" || params["sourceImage"] != nil) {
			t.Fatal("LoRA changed text-to-image mode")
		}
	}
}

func TestLiblibLoRARejectsInvalidStructuredOptions(t *testing.T) {
	valid := map[string]any{"modelId": liblibTestUUID, "weight": 0.8}
	cases := map[string]any{
		"object":          valid,
		"string":          "[]",
		"missing-version": []any{map[string]any{"weight": 0.8}},
		"invalid-version": []any{map[string]any{"modelId": "page-id"}},
		"null-weight":     []any{map[string]any{"modelId": liblibTestUUID, "weight": nil}},
		"string-weight":   []any{map[string]any{"modelId": liblibTestUUID, "weight": "0.8"}},
		"underflow":       []any{map[string]any{"modelId": liblibTestUUID, "weight": -4.01}},
		"overflow":        []any{map[string]any{"modelId": liblibTestUUID, "weight": 4.01}},
		"nan":             []any{map[string]any{"modelId": liblibTestUUID, "weight": math.NaN()}},
		"unknown-field":   []any{map[string]any{"modelId": liblibTestUUID, "baseModel": "sdxl"}},
		"duplicate":       []any{valid, valid},
		"too-many":        []any{valid, valid, valid, valid, valid, valid},
		"null-entry":      []any{nil},
	}
	for name, value := range cases {
		t.Run(name, func(t *testing.T) {
			r := liblibTestRequest()
			r.ProviderOptions[LiblibImageProtocolID]["additionalNetwork"] = value
			if err := ValidateLiblibRequest(r); err == nil {
				t.Fatal("invalid LoRA was accepted before upload/billing")
			}
		})
	}
}

func TestLiblibF1FullTemplatesSendConfiguredCheckpointAndSampling(t *testing.T) {
	for _, withReference := range []bool{false, true} {
		r := liblibTestRequest()
		r.ControlNet = nil
		r.Model = "412b427ddb674b4dbab9e5abd5ae6057"
		options := r.ProviderOptions[LiblibImageProtocolID]
		options["family"], options["templateUuid"] = "f1", "6f7c4652458d4802969f8d089cf5b91f"
		options["sampler"], options["steps"], options["cfgScale"] = 1, 25, 3.5
		options["additionalNetwork"] = []any{map[string]any{"modelId": liblibTestUUID}}
		if withReference {
			options["templateUuid"], options["denoisingStrength"] = "63b72710c9574457ba303d9d9b8df8bd", 0.5
			r.Images = []MediaReference{{Role: "edit_source", URL: "https://cdn.example.com/input.png"}}
		}
		spec, err := buildLiblibCreate(r)
		if err != nil {
			t.Fatal(err)
		}
		params := spec.Body.(map[string]any)["generateParams"].(map[string]any)
		if params["checkPointId"] != r.Model || params["sampler"] != 1 || params["steps"] != 25 || params["cfgScale"] != 3.5 || params["additionalNetwork"] == nil {
			t.Fatalf("F.1 full template discarded configured fields: %#v", params)
		}
		delete(options, "sampler")
		if err := ValidateLiblibRequest(r); err == nil {
			t.Fatal("F.1 full template accepted missing sampler")
		}
	}
}
