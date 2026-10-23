package protocol

import (
	"math"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestLiblibMapsOfficialControlTypesAndSpecificParameters(t *testing.T) {
	tests := []struct {
		processor, controlType, key string
		wire                        int
		parameters                  map[string]float64
		want                        map[string]any
	}{
		{"hed_safe", "softedge", "hedSafe", 6, map[string]float64{"resolution": 512}, map[string]any{"preprocessorResolution": 512}},
		{"softedge_anyline", "softedge", "softedgeAnyline", 65, map[string]float64{"resolution": 768, "safeSteps": 0}, map[string]any{"preprocessorResolution": 768, "safeSteps": 0}},
		{"mlsd", "mlsd", "mlsd", 8, map[string]float64{"resolution": 512, "valueThreshold": .1, "distanceThreshold": .2}, map[string]any{"preprocessorResolution": 512, "valueThreshold": .1, "distanceThreshold": .2}},
		{"scribble_xdog", "scribble", "scribbleXdog", 21, map[string]float64{"resolution": 512, "XDoGThreshold": 32}, map[string]any{"preprocessorResolution": 512, "XDoGThreshold": 32}},
		{"lineart_anime", "lineart", "lineartAnime", 31, map[string]float64{"resolution": 512}, map[string]any{"preprocessorResolution": 512}},
		{"depth_leres++", "depth", "depthLeresPlus", 4, map[string]float64{"resolution": 512, "removeNear": 0, "removeBackground": 20.5}, map[string]any{"preprocessorResolution": 512, "removeNear": 0.0, "removeBackground": 20.5}},
		{"oneformer_ade20k", "segment", "oneformerAde20k", 28, map[string]float64{"resolution": 512}, map[string]any{"preprocessorResolution": 512}},
		{"normal_map", "normal", "normalMap", 9, map[string]float64{"resolution": 512, "backgroundThreshold": .4}, map[string]any{"preprocessorResolution": 512, "backgroundThreshold": .4}},
		{"mediapipe_face", "openpose", "mediapipeFace", 7, map[string]float64{"resolution": 512, "maxFaces": 2, "minConfidence": .5}, map[string]any{"preprocessorResolution": 512, "maxFaces": 2, "minConfidence": .5}},
		{"tile_colorfix+sharp", "tile", "tileColorfixSharp", 44, map[string]float64{"variation": 8, "sharpness": 1.5}, map[string]any{"variation": 8, "sharpness": 1.5}},
		{"reference_adain+attn", "reference", "referenceAdainAttn", 39, map[string]float64{"styleFidelity": .7}, map[string]any{"styleFidelity": .7}},
		{"ip-adapter_clip_sdxl_plus_vith", "ip-adapter", "ipAdapterClipSdxlPlusVith", 61, nil, map[string]any{}},
		{"clip_vision", "t2i-adapter", "clipVision", 15, map[string]float64{"resolution": 512}, map[string]any{"preprocessorResolution": 512}},
		{"shuffle", "shuffle", "shuffle", 33, map[string]float64{"resolution": 512}, map[string]any{"preprocessorResolution": 512}},
		{"recolor_luminance", "recolor", "recolorLuminance", 50, map[string]float64{"gammaCorrection": 1.25}, map[string]any{"gammaCorrection": 1.25}},
		{"instant_id_face_keypoints", "instant-id", "instantIdFaceKeypoints", 59, map[string]float64{"resolution": 512}, map[string]any{"preprocessorResolution": 512}},
		{"instant_id_face_embedding", "instant-id", "instantIdFaceEmbedding", 60, map[string]float64{"resolution": 512}, map[string]any{"preprocessorResolution": 512}},
		{"inpaint_only+lama", "inpaint", "inpaintOnlyLama", 42, nil, map[string]any{}},
		{"none", "pulid", "none", 0, nil, map[string]any{}},
		{"invert", "lineart", "invert", 35, nil, map[string]any{}},
	}
	for _, test := range tests {
		t.Run(test.processor, func(t *testing.T) {
			r := liblibTestRequest()
			p := &r.ControlNet[0].Parameters
			p.ControlType, p.Preprocessor, p.Canny, p.ProcessorParameters = test.controlType, test.processor, nil, test.parameters
			if test.controlType == "reference" {
				p.Model = ""
			}
			if test.controlType == "entity" {
				r.ProviderOptions[LiblibImageProtocolID]["family"] = "f1"
			}
			if test.controlType == "inpaint" {
				mask := r.ControlNet[0].Image
				r.ControlNet[0].Mask = &mask
			}
			spec, err := buildLiblibCreate(r)
			if err != nil {
				t.Fatal(err)
			}
			wire := spec.Body.(map[string]any)["generateParams"].(map[string]any)["controlNet"].([]any)[0].(map[string]any)
			if wire["preprocessor"] != test.wire || !reflect.DeepEqual(wire["annotationParameters"], map[string]any{test.key: test.want}) {
				t.Fatalf("wrong official wire mapping: %#v", wire)
			}
			if _, present := wire["model"]; present == (test.controlType == "reference") {
				t.Fatalf("Reference None model was not omitted: %#v", wire)
			}
		})
	}
}

func TestControlNetParametersRejectInvalidOrStaleProcessorSettings(t *testing.T) {
	valid := func() ControlNetParameters {
		return ControlNetParameters{ControlType: "depth", Preprocessor: "depth_leres", Model: liblibTestUUID, Strength: 1, End: 1, ControlMode: "balanced", ResizeMode: "stretch", ProcessorParameters: map[string]float64{"resolution": 512, "removeNear": 0, "removeBackground": 0}}
	}
	for name, mutate := range map[string]func(*ControlNetParameters){
		"unknown preprocessor": func(p *ControlNetParameters) { p.Preprocessor = "made-up" },
		"wrong control type":   func(p *ControlNetParameters) { p.ControlType = "canny" },
		"stale canny": func(p *ControlNetParameters) {
			p.Canny = &CannyParameters{Resolution: 512, LowThreshold: 100, HighThreshold: 200}
		},
		"missing parameter": func(p *ControlNetParameters) { delete(p.ProcessorParameters, "removeNear") },
		"unknown parameter": func(p *ControlNetParameters) { p.ProcessorParameters["lowThreshold"] = 100 },
		"wrong same size keys": func(p *ControlNetParameters) {
			delete(p.ProcessorParameters, "removeNear")
			p.ProcessorParameters["lowThreshold"] = 100
		},
		"nonfinite parameter": func(p *ControlNetParameters) { p.ProcessorParameters["removeNear"] = math.NaN() },
		"fractional integer":  func(p *ControlNetParameters) { p.ProcessorParameters["resolution"] = 512.5 },
		"above maximum":       func(p *ControlNetParameters) { p.ProcessorParameters["removeNear"] = 100.1 },
		"below minimum":       func(p *ControlNetParameters) { p.ProcessorParameters["removeNear"] = -.1 },
	} {
		t.Run(name, func(t *testing.T) {
			p := valid()
			mutate(&p)
			if p.Validate(false) == nil || p.Validate(true) == nil {
				t.Fatal("invalid processor settings accepted")
			}
		})
	}
	p := valid()
	p.Preprocessor, p.ControlType, p.ProcessorParameters = "none", "", nil
	if err := p.Validate(false); err == nil {
		t.Fatal("None silently guessed the control type")
	}
	p.ControlType = "depth"
	if err := p.Validate(false); err != nil {
		t.Fatalf("preprocessed depth input rejected: %v", err)
	}
	p.Preprocessor = "invert"
	if p.Validate(false) == nil {
		t.Fatal("invert was generalized from line drawings to depth maps")
	}
	p.Preprocessor, p.ControlType = "none", "reference"
	if p.Validate(false) == nil {
		t.Fatal("None was generalized to arbitrary Control Types")
	}
	canny := liblibTestRequest().ControlNet[0].Parameters
	canny.ProcessorParameters = map[string]float64{"resolution": 512}
	if canny.Validate(false) == nil {
		t.Fatal("Canny accepted mixed processor settings")
	}
	p = valid()
	p.ControlType, p.Preprocessor, p.Model, p.ProcessorParameters = "entity", "entity_control", "", nil
	if err := p.Validate(true); err != nil {
		t.Fatalf("disabled dedicated workflow cannot be preserved in a draft: %v", err)
	}
	p.Model = "6f1767b5f9eb47289525d06ae882a0e5"
	if p.Validate(false) == nil {
		t.Fatal("disabled dedicated workflow passed task admission")
	}
}

func TestLiblibModelCompatibilityAndSpecialFlowAdmission(t *testing.T) {
	r := liblibTestRequest()
	r.ControlNet[0].Parameters.Model = "6349e9dae8814084bd9c1585d335c24c"
	if err := ValidateLiblibRequest(r); err == nil || !strings.Contains(err.Error(), "Control Type") {
		t.Fatalf("Canny accepted a depth-only model: %v", err)
	}
	r.ControlNet[0].Parameters.Model = "017997cd6ba44c4dbe8f60e0a26cd0df"
	if err := ValidateLiblibRequest(r); err == nil || !strings.Contains(err.Error(), "基础算法") {
		t.Fatalf("SD accepted F.1 control model: %v", err)
	}
	r.ControlNet[0].Parameters.Model = "5b5f21d2b80445598db19e924bd3a409"
	if err := ValidateLiblibRequest(r); err == nil || !strings.Contains(err.Error(), "基础算法") {
		t.Fatalf("unsupported Qwen family accepted: %v", err)
	}
	r = liblibTestRequest()
	p := &r.ControlNet[0].Parameters
	p.ControlType, p.Preprocessor, p.Canny = "inpaint", "inpaint_only", nil
	if err := ValidateLiblibRequest(r); err == nil || !strings.Contains(err.Error(), "控制蒙版") {
		t.Fatalf("Inpaint accepted missing unit mask: %v", err)
	}
	r.Images = []MediaReference{{URL: "https://cdn.example.com/content.png"}, {Role: "mask", URL: "https://cdn.example.com/edit-mask.png"}}
	r.ProviderOptions[LiblibImageProtocolID]["denoisingStrength"] = .75
	if err := ValidateLiblibRequest(r); err == nil || !strings.Contains(err.Error(), "控制蒙版") {
		t.Fatalf("top-level repaint mask replaced ControlNet mask: %v", err)
	}
	r = liblibTestRequest()
	p = &r.ControlNet[0].Parameters
	p.ControlType, p.Preprocessor, p.Canny = "instant-id", "instant_id_face_embedding", nil
	p.ProcessorParameters = map[string]float64{"resolution": 512}
	p.Model = "3a8267c7d45c11ee9b5e00163e365853"
	if err := ValidateLiblibRequest(r); err != nil {
		t.Fatalf("official Instant ID generic processor rejected: %v", err)
	}
	p.Model = "3560664ad45c11ee9b5e00163e365853"
	if err := ValidateLiblibRequest(r); err == nil || !strings.Contains(err.Error(), "预处理器") {
		t.Fatalf("Instant ID embedding accepted the keypoint model: %v", err)
	}
	r = liblibTestRequest()
	p = &r.ControlNet[0].Parameters
	p.ControlType, p.Preprocessor, p.Canny = "entity", "entity_control", nil
	r.ProviderOptions[LiblibImageProtocolID]["family"] = "f1"
	r.ProviderOptions[LiblibImageProtocolID]["denoisingStrength"] = .75
	r.Images = []MediaReference{{URL: "https://cdn.example.com/content.png"}}
	if err := ValidateLiblibRequest(r); err == nil || !strings.Contains(err.Error(), "专用模板") {
		t.Fatalf("dedicated entity workflow ran through generic unit order: %v", err)
	}
}

func TestLiblibControlNetCatalogueIsCompleteAndGeneratedUIStaysInSync(t *testing.T) {
	seen := map[string]bool{}
	for _, processor := range ControlNetPreprocessors() {
		if seen[processor.ID] || processor.Source == "" || processor.AnnotationKey == "" {
			t.Fatalf("invalid catalogue processor: %#v", processor)
		}
		seen[processor.ID] = true
		p := liblibTestRequest().ControlNet[0].Parameters
		p.ControlType, p.Preprocessor = processor.ControlType, processor.ID
		if p.ControlType == "none" {
			p.ControlType = "canny"
		}
		if processor.ID != "canny" {
			p.Canny, p.ProcessorParameters = nil, map[string]float64{}
			for _, parameter := range processor.Parameters {
				p.ProcessorParameters[parameter.Name] = parameter.Default
			}
		}
		if p.ControlType == "reference" {
			p.Model = ""
		}
		if err := p.Validate(processor.ID == "entity_control"); err != nil {
			t.Fatalf("official defaults are invalid for %s: %v", processor.ID, err)
		}
	}
	if len(seen) != 65 {
		t.Fatalf("expected 64 official-table processors and entity example, got %d", len(seen))
	}
	union, ok := LookupLiblibControlNetModel("13c1e1b96ba64f9cbb2b54f89b5fe873")
	if !ok || !containsControlNetString(union.ControlTypes, "scribble") || !containsControlNetString(union.ControlTypes, "openpose") {
		t.Fatal("official cross-group Union recommendations lost")
	}
	union.ControlTypes[0] = "modified"
	again, _ := LookupLiblibControlNetModel(union.ID)
	if again.ControlTypes[0] == "modified" {
		t.Fatal("public catalogue mutation escaped into admission")
	}
	generated, err := os.ReadFile(filepath.Join("..", "..", "..", "web", "src", "lib", "canvas", "controlnet-catalog.generated.ts"))
	if err != nil || string(generated) != ControlNetCatalogTypeScript() {
		t.Fatalf("ControlNet frontend catalogue is stale; run go generate ./internal/canvas/contract: %v", err)
	}
}

func TestLiblibPluginPackageCarriesTheSameControlNetCatalogue(t *testing.T) {
	root := filepath.Join("..", "..", "..", "plugin-packages")
	data, err := os.ReadFile(filepath.Join(root, LiblibImageProtocolID+".yingce-plugin"))
	if err != nil {
		t.Fatal(err)
	}
	pkg, err := ParsePluginPackage(data)
	if err != nil {
		t.Fatal(err)
	}
	if pkg.Manifest.Metadata.Version != LiblibImageAdapter().Metadata().Version {
		t.Fatal("Liblib plugin and backend host versions differ")
	}
	if !reflect.DeepEqual(pkg.Files["docs/controlnet-catalog.json"], ControlNetCatalogDocument()) {
		t.Fatal("packaged Liblib ControlNet catalogue differs from the host")
	}
	for _, name := range []string{"manifest.json", "README.md", "docs/interface.md", "docs/controlnet-catalog.json"} {
		source, err := os.ReadFile(filepath.Join(root, LiblibImageProtocolID, name))
		if err != nil || !reflect.DeepEqual(source, pkg.Files[name]) {
			t.Fatalf("Liblib plugin artifact is stale for %s: %v", name, err)
		}
	}
}

func TestControlNetProcessorRecommendationsKeepSpecificModelChoices(t *testing.T) {
	for processor, expected := range map[string]string{
		"depth_hand_refiner":             "3497061cd45c11ee9b5e00163e365853",
		"animal_openpose":                "329f0073d45c11ee9b5e00163e365853",
		"densepose":                      "3b4e0830d45c11ee9b5e00163e365853",
		"ip-adapter_clip_sdxl_plus_vith": "38ee73f1d45c11ee9b5e00163e365853",
	} {
		definition, ok := ControlNetPreprocessor(processor)
		if !ok || !containsControlNetString(definition.RecommendedModels, expected) {
			t.Fatalf("specific official recommendation lost for %s", processor)
		}
	}
	for _, processor := range ControlNetPreprocessors() {
		for _, id := range processor.RecommendedModels {
			model, known := LookupLiblibControlNetModel(id)
			if !known || !containsControlNetString(model.ControlTypes, processor.ControlType) {
				t.Fatalf("recommendation %s for %s is missing its documented compatibility", id, processor.ID)
			}
		}
	}
	model, _ := LookupLiblibControlNetModel("f936bf22cb8e4dcfa6b0f3b96cdd8eb7")
	if !containsControlNetString(model.ControlTypes, "lineart") {
		t.Fatal("Lineart's official xinsir_anime_painter recommendation was lost")
	}
}
