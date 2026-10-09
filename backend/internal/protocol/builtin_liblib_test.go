package protocol

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

const liblibTestUUID = "0123456789abcdef0123456789abcdef"

func liblibTestRequest() GenerationRequest {
	return GenerationRequest{Model: liblibTestUUID, Prompt: "one coherent scene", AspectRatio: "1024x768", ImageCount: 1,
		ProviderOptions: map[string]map[string]any{LiblibImageProtocolID: {"family": "sd", "templateUuid": liblibTestUUID, "steps": 20, "sampler": 15, "cfgScale": 7.0}},
		ControlNet: []ControlNetUnit{{ID: "unit-one", Image: MediaReference{URL: "https://cdn.example.com/control.png", Metadata: map[string]any{"width": 1256, "height": 704}},
			Parameters: ControlNetParameters{Preprocessor: "canny", Model: liblibTestUUID, Strength: 0.7, Start: 0, End: 0.8, PixelPerfect: true, ControlMode: "balanced", ResizeMode: "fill", Canny: &CannyParameters{Resolution: 512, LowThreshold: 100, HighThreshold: 200}}}}}
}

func TestLiblibCreateMapsControlUnitsWithoutOrdinaryReferences(t *testing.T) {
	r := liblibTestRequest()
	a := LiblibImageAdapter()
	spec, err := a.BuildCreate(context.Background(), RequestContext{Request: r})
	if err != nil {
		t.Fatal(err)
	}
	if spec.Path != "/api/generate/webui/text2img" || !spec.OriginPath || spec.Auth.Type != "liblib-hmac-sha1" || !a.Metadata().SupportsControlNet {
		t.Fatalf("wrong protocol metadata/spec: %+v", spec)
	}
	body := spec.Body.(map[string]any)
	params := body["generateParams"].(map[string]any)
	for _, key := range []string{"sourceImage", "resizedWidth", "resizedHeight", "resizeMode", "mode"} {
		if _, ok := params[key]; ok {
			t.Fatalf("control image introduced img2img field %s into txt2img", key)
		}
	}
	unit := params["controlNet"].([]any)[0].(map[string]any)
	if unit["unitOrder"] != 1 || unit["width"] != 1256 || unit["height"] != 704 || unit["resizeMode"] != 2 || unit["preprocessor"] != 1 {
		t.Fatalf("wrong control mapping: %+v", unit)
	}
	if params["width"] != 1024 || params["height"] != 768 {
		t.Fatal("reference dimensions replaced output dimensions")
	}
	canny := unit["annotationParameters"].(map[string]any)["canny"].(map[string]any)
	if canny["lowThreshold"] != 100 || canny["highThreshold"] != 200 {
		t.Fatal("Canny thresholds lost")
	}
	r.Images = []MediaReference{{URL: "https://cdn.example.com/input.png", Role: "edit_source"}}
	r.ProviderOptions[LiblibImageProtocolID]["denoisingStrength"] = 0.4
	spec, err = a.BuildCreate(context.Background(), RequestContext{Request: r})
	if err != nil {
		t.Fatal(err)
	}
	if spec.Path != "/api/generate/webui/img2img" || spec.Body.(map[string]any)["generateParams"].(map[string]any)["sourceImage"] == nil {
		t.Fatal("ordinary reference missing img2img mapping")
	}
}

func TestLiblibImg2ImgMapsResizedOutputAndOrdinaryEditingMode(t *testing.T) {
	for _, family := range []string{"sd", "f1"} {
		for _, sizeSource := range []string{"output", "provider-options", "aspect-ratio"} {
			t.Run(family+"/"+sizeSource, func(t *testing.T) {
				r := liblibTestRequest()
				r.Images = []MediaReference{{URL: "https://cdn.example.com/content.png", Role: "edit_source", Metadata: map[string]any{"width": 640, "height": 960}}}
				o := r.ProviderOptions[LiblibImageProtocolID]
				o["family"], o["denoisingStrength"], o["seed"] = family, 0.0, 42
				switch sizeSource {
				case "output":
					r.Output.Width, r.Output.Height = 1824, 1024
					o["width"], o["height"] = 512, 512
				case "provider-options":
					o["width"], o["height"] = 1824, 1024
				case "aspect-ratio":
					r.AspectRatio = "1824x1024"
				}
				spec, err := LiblibImageAdapter().BuildCreate(context.Background(), RequestContext{Request: r})
				if err != nil {
					t.Fatal(err)
				}
				params := spec.Body.(map[string]any)["generateParams"].(map[string]any)
				if spec.Path != "/api/generate/webui/img2img" || params["sourceImage"] != r.Images[0].URL || params["resizedWidth"] != 1824 || params["resizedHeight"] != 1024 || params["resizeMode"] != 0 || params["mode"] != 0 {
					t.Fatalf("incomplete img2img geometry: %+v", params)
				}
				if params["denoisingStrength"] != 0.0 || params["seed"] != 42 {
					t.Fatalf("explicit image settings changed: %+v", params)
				}
				for _, key := range []string{"width", "height", "inpaintParam"} {
					if _, ok := params[key]; ok {
						t.Fatalf("ordinary img2img received unrelated field %s", key)
					}
				}
				unit := params["controlNet"].([]any)[0].(map[string]any)
				if unit["sourceImage"] != r.ControlNet[0].Image.URL || unit["width"] != 1256 || unit["height"] != 704 || unit["resizeMode"] != 2 {
					t.Fatalf("content reference replaced independent control geometry: %+v", unit)
				}
				_, hasCheckpoint := params["checkPointId"]
				if hasCheckpoint != (family == "sd") {
					t.Fatal("family checkpoint behavior changed")
				}
			})
		}
	}
}

func TestLiblibConfigValidationRunsBeforeURLPreparation(t *testing.T) {
	r := liblibTestRequest()
	r.ControlNet[0].Image = MediaReference{ID: "persistent-resource"}
	if err := ValidateLiblibRequest(r); err != nil {
		t.Fatalf("preparation-free validation rejected resource: %v", err)
	}
	if _, err := buildLiblibCreate(r); err == nil {
		t.Fatal("create accepted unresolved resource")
	}
	r.ProviderOptions[LiblibImageProtocolID]["templateUuid"] = ""
	if err := ValidateLiblibRequest(r); err == nil || !strings.Contains(err.Error(), "templateUuid") {
		t.Fatal("missing template accepted")
	}
	r = liblibTestRequest()
	r.ProviderOptions[LiblibImageProtocolID]["family"] = "f1"
	r.Model = "F.1"
	delete(r.ProviderOptions[LiblibImageProtocolID], "sampler")
	delete(r.ProviderOptions[LiblibImageProtocolID], "cfgScale")
	spec, err := buildLiblibCreate(r)
	if err != nil {
		t.Fatal(err)
	}
	params := spec.Body.(map[string]any)["generateParams"].(map[string]any)
	if _, ok := params["checkPointId"]; ok {
		t.Fatal("F.1 fixed-base template received SD checkpoint field")
	}
}

func TestLiblibPollWaitsForAuditAndRejectsUnknownOrWrongTasks(t *testing.T) {
	a := LiblibImageAdapter()
	ctx := context.Background()
	poll := PollContext{TaskID: "original"}
	for _, state := range []int{1, 2, 3, 4, 5, 6, 7} {
		payload, _ := json.Marshal(map[string]any{"code": 0, "data": map[string]any{"generateUuid": "original", "generateStatus": state, "images": []any{map[string]any{"imageUrl": "https://cdn.example.com/result.png", "auditStatus": 3, "seed": 42}}}})
		result, err := a.ParsePoll(ctx, poll, payload)
		if err != nil {
			t.Fatal(err)
		}
		if (result.Status == StatusSucceeded) != (state == 5) {
			t.Fatalf("state %d became %s", state, result.Status)
		}
		if state == 5 && (result.Result == nil || len(result.Result.Images) != 1) {
			t.Fatal("success output missing")
		}
	}
	for _, raw := range []string{
		`{"code":0,"data":{"generateUuid":"other","generateStatus":5}}`,
		`{"code":0,"data":{"generateUuid":"original","generateStatus":8}}`,
		`{"code":0,"data":{"generateUuid":"original","generateStatus":5,"images":[]}}`,
		`{"code":0,"data":{"generateUuid":"original","generateStatus":5,"images":[{"imageUrl":"https://cdn.example.com/a.png","auditStatus":2}]}}`,
		`{"code":403,"msg":"denied"}`,
		`{"data":{"generateUuid":"original"}}`,
	} {
		if _, err := a.ParsePoll(ctx, poll, []byte(raw)); err == nil {
			t.Fatalf("invalid response accepted: %s", raw)
		}
	}
	if _, err := a.ParseCreate(ctx, []byte(`{"code":0,"data":{}}`)); err == nil {
		t.Fatal("missing create task ID accepted")
	}
}
