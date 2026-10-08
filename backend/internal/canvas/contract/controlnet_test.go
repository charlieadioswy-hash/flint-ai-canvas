package contract

import (
	"encoding/json"
	"reflect"
	"testing"

	"infinite-canvas/backend/internal/protocol"
)

func controlSpec() GenerationSpec {
	units := []ControlNetBinding{{ID: "unit-1", ImageBindingID: "source", Parameters: protocol.ControlNetParameters{Preprocessor: "canny", Model: "model", Strength: .6, Start: 0, End: .6, PixelPerfect: true, ControlMode: "balanced", ResizeMode: "stretch", Canny: &protocol.CannyParameters{Resolution: 512, LowThreshold: 100, HighThreshold: 200}}}}
	return GenerationSpec{Version: 1, Mode: "image", Prompt: "panda", TextInputMode: "prompt-only", Options: Options{ControlNet: &units, OutputMask: &OutputMaskBinding{BindingID: "output", Mode: "non-black", ResizeMode: "stretch"}}, ReferenceBindings: []ReferenceBinding{{ID: "source", ResourceID: "source-id", MediaType: "image", Role: "control-image", Order: 0, Resolution: "snapshot"}, {ID: "output", ResourceID: "mask-id", MediaType: "image", Role: "output-mask", Order: 1, Resolution: "snapshot"}}}
}

func TestControlContractRoundTripKeepsStructuredOptions(t *testing.T) {
	spec := controlSpec()
	if err := spec.Validate(); err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(spec)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := Decode(data)
	if err != nil || !reflect.DeepEqual(spec, decoded) {
		t.Fatalf("round trip: %v", err)
	}
	metadata, err := spec.NodeMetadata()
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := metadata["controlNet"].([]ControlNetBinding); !ok {
		t.Fatal("control units were stringified")
	}
	options, err := OptionsFromTaskConfig("image", spec.Options.TaskConfig())
	if err != nil || !reflect.DeepEqual(options, spec.Options) {
		t.Fatalf("option projection lost controls: %v", err)
	}
}

func TestControlContractAllowsDraftButRejectsWrongRolesAndMode(t *testing.T) {
	draft := controlSpec()
	(*draft.Options.ControlNet)[0].Parameters.Model = ""
	(*draft.Options.ControlNet)[0].ImageBindingID = ""
	if err := draft.Validate(); err != nil {
		t.Fatalf("draft cannot save: %v", err)
	}
	for name, change := range map[string]func(*GenerationSpec){
		"wrong role":      func(s *GenerationSpec) { s.ReferenceBindings[0].Role = "reference" },
		"missing binding": func(s *GenerationSpec) { (*s.Options.ControlNet)[0].ImageBindingID = "missing" },
		"video":           func(s *GenerationSpec) { s.Mode = "video" },
		"reverse steps":   func(s *GenerationSpec) { (*s.Options.ControlNet)[0].Parameters.Start = .8 },
		"zero threshold":  func(s *GenerationSpec) { (*s.Options.ControlNet)[0].Parameters.Canny.LowThreshold = 0 },
	} {
		t.Run(name, func(t *testing.T) {
			s := controlSpec()
			change(&s)
			if s.Validate() == nil {
				t.Fatal("invalid contract accepted")
			}
		})
	}
}
