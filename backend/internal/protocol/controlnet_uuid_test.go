package protocol

import (
	"context"
	"strings"
	"testing"
)

func TestLiblibControlNetUUIDAliasesKeepOfficialCompatibility(t *testing.T) {
	for _, tc := range []struct {
		name, model, processor, controlType string
		parameters                          map[string]float64
	}{
		{"Canny cannot become depth", "b6806516962f4e1599a93ac4483c3d23", "depth_leres", "depth", map[string]float64{"resolution": 512, "removeNear": 0, "removeBackground": 0}},
		{"InstantID keypoints cannot become embedding", "3560664ad45c11ee9b5e00163e365853", "instant_id_face_embedding", "instant-id", map[string]float64{"resolution": 512}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			alias := " \t" + strings.ToUpper(tc.model) + "\n"
			entry, known := LookupLiblibControlNetModel(alias)
			if !known || entry.ID != tc.model {
				t.Fatalf("official UUID alias lost metadata: %+v, known=%v", entry, known)
			}
			r := liblibTestRequest()
			r.ControlNet[0].Parameters = ControlNetParameters{Model: alias, Preprocessor: tc.processor, ControlType: tc.controlType,
				Strength: .6, End: .6, ControlMode: "balanced", ResizeMode: "stretch", ProcessorParameters: tc.parameters}
			if err := ValidateLiblibRequest(r); err == nil {
				t.Fatal("UUID alias bypassed official compatibility")
			}
		})
	}
}

func TestLiblibCreateCanonicalizesModelUUIDs(t *testing.T) {
	for _, override := range []bool{false, true} {
		r := liblibTestRequest()
		r.Model = " \t" + strings.ToUpper(liblibTestUUID) + "\n"
		r.ControlNet[0].Parameters.Model = r.Model
		if override {
			r.ProviderOptions[LiblibImageProtocolID]["checkPointId"] = r.Model
		}
		spec, err := LiblibImageAdapter().BuildCreate(context.Background(), RequestContext{Request: r})
		if err != nil {
			t.Fatal(err)
		}
		params := spec.Body.(map[string]any)["generateParams"].(map[string]any)
		unit := params["controlNet"].([]any)[0].(map[string]any)
		if params["checkPointId"] != liblibTestUUID || unit["model"] != liblibTestUUID {
			t.Fatalf("UUID alias leaked into wire request: checkpoint=%v, control=%v", params["checkPointId"], unit["model"])
		}
	}
}
