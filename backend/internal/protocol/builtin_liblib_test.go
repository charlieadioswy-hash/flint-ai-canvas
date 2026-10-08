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
	if _, ok := params["sourceImage"]; ok {
		t.Fatal("control image turned txt2img into img2img")
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
