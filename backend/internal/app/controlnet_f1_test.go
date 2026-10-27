package app

import (
	"strings"
	"testing"

	"yingce/backend/internal/generation"
	"yingce/backend/internal/protocol"
)

func TestLiblibF1ControlNetDefaultsAndAdmissionUseCompatibleModels(t *testing.T) {
	const checkpoint = "412b427ddb674b4dbab9e5abd5ae6057"
	for _, tc := range []struct {
		processor, controlType, wantModel string
		parameters                        map[string]float64
	}{
		{"canny", "canny", "13c1e1b96ba64f9cbb2b54f89b5fe873", nil},
		{"depth_midas", "depth", "13c1e1b96ba64f9cbb2b54f89b5fe873", map[string]float64{"resolution": 512}},
		{"inpaint_global_harmonious", "inpaint", "31df01fc271d484ca4d496179d69a665", nil},
		{"inpaint_only", "inpaint", "31df01fc271d484ca4d496179d69a665", nil},
		{"inpaint_only+lama", "inpaint", "31df01fc271d484ca4d496179d69a665", nil},
		{"ip-adapter-siglip", "ip-adapter", "c6ed70879cf011ef96d600163e37ec70", map[string]float64{"resolution": 1024}},
		{"none", "pulid", "405836d1ae2646b4ba2716ed6bd5453a", nil},
	} {
		t.Run(tc.processor+"/"+tc.controlType, func(t *testing.T) {
			profile := DefaultImageCapabilityConfig(protocol.LiblibImageProtocolID, checkpoint)
			options := map[string]any{"family": "f1", "controlNetModel": "b6806516962f4e1599a93ac4483c3d23"}
			values := map[string]any{"preprocessor": tc.processor, "controlType": tc.controlType}
			modelID := defaultChannelControlNetModel(profile.ControlNet, options, checkpoint, values)
			if modelID != tc.wantModel {
				t.Fatalf("F.1 default = %q; want %q", modelID, tc.wantModel)
			}
			input := controlNetSelectionTestInput(tc.processor, tc.controlType, modelID, tc.parameters)
			input.Config.Model = checkpoint
			input.Metadata = map[string]any{"providerOptions": map[string]any{protocol.LiblibImageProtocolID: options}}
			if tc.processor == "canny" {
				input.ControlNet[0].Parameters.Canny = &generation.CannyParameters{Resolution: 512, LowThreshold: 100, HighThreshold: 200}
			}
			if tc.controlType == "inpaint" {
				mask := input.ControlNet[0].Image
				mask.StorageKey = "resource:f1-control-mask"
				input.ControlNet[0].Mask = &mask
				profile.References.MaskSupported = false
			}
			if err := validateImageTask(profile, input); err != nil {
				t.Fatalf("compatible F.1 selection rejected: %v", err)
			}
			input.ControlNet[0].Parameters.Model = controlNetDepthXLTestModel
			if err := validateImageTask(profile, input); err == nil || !strings.Contains(err.Error(), "不兼容") {
				t.Fatalf("F.1 request accepted SDXL control model: %v", err)
			}
			profile.ControlNet.Models = []string{controlNetDepthXLTestModel}
			if modelID := defaultChannelControlNetModel(profile.ControlNet, options, checkpoint, values); modelID != "" {
				t.Fatalf("SDXL-only allowlist selected an F.1 control model: %q", modelID)
			}
		})
	}
}

func TestLiblibF1IPAdapterAdmissionRejectsSDAndSDXLPreprocessors(t *testing.T) {
	const checkpoint = "412b427ddb674b4dbab9e5abd5ae6057"
	for _, processor := range protocol.ControlNetPreprocessors() {
		if processor.ControlType != "ip-adapter" {
			continue
		}
		t.Run(processor.ID, func(t *testing.T) {
			parameters := map[string]float64{}
			for _, parameter := range processor.Parameters {
				parameters[parameter.Name] = parameter.Default
			}
			input := controlNetSelectionTestInput(processor.ID, "ip-adapter", "c6ed70879cf011ef96d600163e37ec70", parameters)
			input.Config.Model = checkpoint
			input.Metadata = map[string]any{"providerOptions": map[string]any{protocol.LiblibImageProtocolID: map[string]any{"family": "f1"}}}
			profile := DefaultImageCapabilityConfig(protocol.LiblibImageProtocolID, checkpoint)
			err := validateImageTask(profile, input)
			if processor.ID == "ip-adapter-siglip" {
				if err != nil {
					t.Fatalf("official F.1 Siglip preprocessor rejected: %v", err)
				}
			} else if err == nil || !strings.Contains(err.Error(), "不兼容") {
				t.Fatalf("F.1 IPAdapter accepted %s: %v", processor.ID, err)
			}
		})
	}
}
