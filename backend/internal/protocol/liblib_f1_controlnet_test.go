package protocol

import (
	"context"
	"strings"
	"testing"
)

const (
	liblibF1CheckpointTestModel = "412b427ddb674b4dbab9e5abd5ae6057"
	liblibF1UnionTestModel      = "13c1e1b96ba64f9cbb2b54f89b5fe873"
	liblibF1InpaintTestModel    = "31df01fc271d484ca4d496179d69a665"
)

func liblibF1ControlNetTestRequest(withReference bool, inpaintProcessor string) GenerationRequest {
	r := liblibTestRequest()
	r.Model = liblibF1CheckpointTestModel
	o := r.ProviderOptions[LiblibImageProtocolID]
	o["family"], o["templateUuid"] = "f1", "6f7c4652458d4802969f8d089cf5b91f"
	o["steps"], o["sampler"], o["cfgScale"] = 25, 1, 3.5
	o["additionalNetwork"] = []any{map[string]any{"modelId": liblibTestUUID, "weight": 0.6}}
	if withReference {
		o["templateUuid"], o["denoisingStrength"] = "63b72710c9574457ba303d9d9b8df8bd", 0.5
		r.Images = []MediaReference{{Role: "edit_source", URL: "https://cdn.example.com/content.png", Metadata: map[string]any{"width": 640, "height": 960}}}
	}
	r.ControlNet[0].Parameters.Model = liblibF1UnionTestModel
	mask := MediaReference{URL: "https://cdn.example.com/control-mask.png", Metadata: map[string]any{"width": 1256, "height": 704}}
	r.ControlNet = append(r.ControlNet, ControlNetUnit{
		ID: "inpaint", Image: r.ControlNet[0].Image, Mask: &mask,
		Parameters: ControlNetParameters{ControlType: "inpaint", Preprocessor: inpaintProcessor, Model: liblibF1InpaintTestModel,
			Strength: 0.6, End: 0.6, PixelPerfect: true, ControlMode: "balanced", ResizeMode: "crop"},
	})
	return r
}

func TestLiblibF1FullTemplatesKeepLoRAAndControlMasksIndependent(t *testing.T) {
	for _, withReference := range []bool{false, true} {
		for _, processor := range []string{"inpaint_global_harmonious", "inpaint_only", "inpaint_only+lama"} {
			mode := "text2img"
			if withReference {
				mode = "img2img"
			}
			t.Run(mode+"/"+processor, func(t *testing.T) {
				r := liblibF1ControlNetTestRequest(withReference, processor)
				spec, err := LiblibImageAdapter().BuildCreate(context.Background(), RequestContext{Request: r})
				if err != nil {
					t.Fatal(err)
				}
				body := spec.Body.(map[string]any)
				params := body["generateParams"].(map[string]any)
				if spec.Path != "/api/generate/webui/"+mode || body["templateUuid"] != r.ProviderOptions[LiblibImageProtocolID]["templateUuid"] {
					t.Fatalf("F.1 template or route changed: %#v", spec)
				}
				if params["checkPointId"] != r.Model || params["sampler"] != 1 || params["steps"] != 25 || params["cfgScale"] != 3.5 {
					t.Fatalf("F.1 full-template sampling settings lost: %#v", params)
				}
				networks := params["additionalNetwork"].([]LiblibAdditionalNetwork)
				if len(networks) != 1 || networks[0].ModelID != liblibTestUUID || networks[0].Weight != 0.6 {
					t.Fatalf("F.1 ControlNet changed LoRA selection: %#v", networks)
				}
				units := params["controlNet"].([]any)
				if len(units) != 2 {
					t.Fatalf("F.1 ControlNet units lost: %#v", units)
				}
				canny, inpaint := units[0].(map[string]any), units[1].(map[string]any)
				if canny["model"] != liblibF1UnionTestModel || canny["preprocessor"] != 1 || canny["maskImage"] != nil {
					t.Fatalf("inpaint mask leaked into independent Canny unit: %#v", canny)
				}
				definition, _ := ControlNetPreprocessor(processor)
				annotation := inpaint["annotationParameters"].(map[string]any)
				if inpaint["model"] != liblibF1InpaintTestModel || inpaint["preprocessor"] != definition.WireValue || annotation[definition.AnnotationKey] == nil || inpaint["maskImage"] != r.ControlNet[1].Mask.URL {
					t.Fatalf("F.1 inpaint control mapping lost: %#v", inpaint)
				}
				if inpaint["sourceImage"] != r.ControlNet[1].Image.URL || inpaint["width"] != 1256 || inpaint["height"] != 704 || inpaint["controlWeight"] != 0.6 || inpaint["endingControlStep"] != 0.6 {
					t.Fatalf("F.1 control geometry or explicit strength changed: %#v", inpaint)
				}
				if params["inpaintParam"] != nil || params["maskImage"] != nil {
					t.Fatalf("control mask became a top-level editing mask: %#v", params)
				}
				if withReference {
					if params["mode"] != 0 || params["sourceImage"] != r.Images[0].URL || params["resizedWidth"] != 1024 || params["resizedHeight"] != 768 || params["width"] != nil || params["height"] != nil {
						t.Fatalf("F.1 ControlNet altered ordinary img2img mode or geometry: %#v", params)
					}
				} else if params["sourceImage"] != nil || params["mode"] != nil || params["width"] != 1024 || params["height"] != 768 {
					t.Fatalf("F.1 control image changed text-to-image mode: %#v", params)
				}
			})
		}
	}
}

func TestLiblibF1ControlNetRejectsIncompatibleSelectionsBeforeExecution(t *testing.T) {
	for _, tc := range []struct {
		name, wantError string
		change          func(*GenerationRequest)
	}{
		{"SDXL control model", "基础算法", func(r *GenerationRequest) { r.ControlNet[0].Parameters.Model = "b6806516962f4e1599a93ac4483c3d23" }},
		{"inpaint model used for Canny", "Control Type", func(r *GenerationRequest) { r.ControlNet[0].Parameters.Model = liblibF1InpaintTestModel }},
		{"missing independent control mask", "独立控制蒙版", func(r *GenerationRequest) { r.ControlNet[1].Mask = nil }},
		{"top-level F1 editing mask", "仅支持已核实", func(r *GenerationRequest) {
			r.Images = append(r.Images, *r.ControlNet[1].Mask)
			r.Images[1].Role = "mask"
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := liblibF1ControlNetTestRequest(true, "inpaint_only")
			tc.change(&r)
			if _, err := LiblibImageAdapter().BuildCreate(context.Background(), RequestContext{Request: r}); err == nil || !strings.Contains(err.Error(), tc.wantError) {
				t.Fatalf("error = %v; want rejection containing %q", err, tc.wantError)
			}
		})
	}
}

func TestLiblibF1IPAdapterRequiresSiglipPreprocessor(t *testing.T) {
	for _, processor := range ControlNetPreprocessors() {
		if processor.ControlType != "ip-adapter" {
			continue
		}
		t.Run(processor.ID, func(t *testing.T) {
			r := liblibF1ControlNetTestRequest(false, "inpaint_only")
			r.ControlNet = r.ControlNet[:1]
			p := &r.ControlNet[0].Parameters
			p.ControlType, p.Preprocessor, p.Model, p.Canny = "ip-adapter", processor.ID, "c6ed70879cf011ef96d600163e37ec70", nil
			p.ProcessorParameters = map[string]float64{}
			for _, parameter := range processor.Parameters {
				p.ProcessorParameters[parameter.Name] = parameter.Default
			}
			spec, err := LiblibImageAdapter().BuildCreate(context.Background(), RequestContext{Request: r})
			if processor.ID != "ip-adapter-siglip" {
				if err == nil || !strings.Contains(err.Error(), "预处理器") {
					t.Fatalf("F.1 IPAdapter accepted SD/SDXL preprocessor %s: %v", processor.ID, err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			params := spec.Body.(map[string]any)["generateParams"].(map[string]any)
			unit := params["controlNet"].([]any)[0].(map[string]any)
			if unit["preprocessor"] != 66 || unit["annotationParameters"].(map[string]any)["ipAdapterSiglip"] == nil || params["additionalNetwork"] == nil {
				t.Fatalf("F.1 IPAdapter with LoRA lost official Siglip mapping: %#v", params)
			}
		})
	}
}
