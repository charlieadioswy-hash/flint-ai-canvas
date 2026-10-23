package app

import (
	"strings"
	"testing"

	"yingce/backend/internal/generation"
	"yingce/backend/internal/protocol"
)

func TestControlNetModelCatalogRequiresCanonicalUniqueUUIDs(t *testing.T) {
	custom := generation.ControlNetModelConfig{ID: controlNetCustomTestModel, Name: "Private depth", BaseModel: "sdxl", ControlTypes: []string{"depth"}}
	for _, tc := range []struct {
		name      string
		ids       []string
		wantError bool
	}{
		{"valid custom alias", []string{" \t" + strings.ToUpper(custom.ID) + "\n"}, false},
		{"blank ID", []string{" "}, true},
		{"non UUID", []string{"private-depth"}, true},
		{"non hex UUID", []string{"000000000000000000000000000000gz"}, true},
		{"short UUID", []string{"00000000000000000000000000000d1"}, true},
		{"hyphenated UUID", []string{"00000000-0000-0000-0000-0000000000d1"}, true},
		{"case duplicate", []string{custom.ID, strings.ToUpper(custom.ID)}, true},
		{"whitespace duplicate", []string{custom.ID, " " + custom.ID + " "}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			profile := DefaultModelCapabilityConfigForModel(protocol.LiblibImageProtocolID, verifiedLiblibSDCheckpoint)
			for _, id := range tc.ids {
				entry := custom
				entry.ID = id
				profile.Image.ControlNet.ModelCatalog = append(profile.Image.ControlNet.ModelCatalog, entry)
			}
			_, err := NormalizeModelCapabilityConfigForModel("image", protocol.LiblibImageProtocolID, verifiedLiblibSDCheckpoint, profile)
			if (err != nil) != tc.wantError {
				t.Fatalf("catalog save error=%v, wantError=%v", err, tc.wantError)
			}
		})
	}
}

func TestControlNetOfficialUUIDAliasesCannotOverrideMetadata(t *testing.T) {
	const canny = "b6806516962f4e1599a93ac4483c3d23"
	for _, tc := range []struct {
		name, base, controlType string
	}{
		{"base cannot change", "sd15", "canny"},
		{"type cannot change", "sdxl", "depth"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			capability := &generation.ControlNetCapability{ModelCatalog: []generation.ControlNetModelConfig{{
				ID: " " + strings.ToUpper(canny) + " ", Name: "Spoofed Canny", BaseModel: tc.base, ControlTypes: []string{tc.controlType},
			}}}
			if err := validateControlNetModelCatalog(capability); err == nil {
				t.Fatal("UUID alias overrode official metadata during save")
			}
			entry, known := configuredControlNetModel(capability, strings.ToUpper(canny))
			if !known || entry.ID != canny || entry.BaseModel != "sdxl" || len(entry.ControlTypes) != 1 || entry.ControlTypes[0] != "canny" {
				t.Fatalf("UUID alias did not resolve to official metadata: %+v", entry)
			}
		})
	}
	input := controlNetSelectionTestInput("instant_id_face_embedding", "instant-id", " 3560664AD45C11EE9B5E00163E365853 ", map[string]float64{"resolution": 512})
	profile := DefaultImageCapabilityConfig(protocol.LiblibImageProtocolID, verifiedLiblibSDCheckpoint)
	profile.ControlNet.ModelCatalog = []generation.ControlNetModelConfig{{ID: input.ControlNet[0].Parameters.Model, Name: "Keypoints", BaseModel: "sdxl", ControlTypes: []string{"instant-id"}}}
	if err := validateImageTask(profile, input); err == nil || !strings.Contains(err.Error(), "不兼容") {
		t.Fatalf("UUID alias lost InstantID processor restriction: %v", err)
	}
}

func TestLiblibControlNetUUIDAliasesPreserveWhitelistAndCustomSelection(t *testing.T) {
	for _, custom := range []bool{false, true} {
		id := controlNetDepthXLTestModel
		if custom {
			id = controlNetCustomTestModel
		}
		alias := " \t" + strings.ToUpper(id) + "\n"
		profile := DefaultImageCapabilityConfig(protocol.LiblibImageProtocolID, verifiedLiblibSDCheckpoint)
		profile.ControlNet.Models = []string{alias}
		if custom {
			profile.ControlNet.ModelCatalog = []generation.ControlNetModelConfig{{ID: alias, Name: "Private depth", BaseModel: "sdxl", ControlTypes: []string{"depth"}}}
		}
		for _, modelID := range []string{id, alias} {
			input := controlNetDepthSelectionTestInput(modelID)
			input.Config.Model = " " + strings.ToUpper(verifiedLiblibSDCheckpoint) + " "
			if err := validateImageTask(profile, input); err != nil {
				t.Fatalf("compatible UUID alias rejected: custom=%v, model=%q, error=%v", custom, modelID, err)
			}
		}
		for _, options := range []map[string]any{nil, {"controlNetModel": alias}} {
			got := defaultChannelControlNetModel(profile.ControlNet, options, strings.ToUpper(verifiedLiblibSDCheckpoint), map[string]any{"preprocessor": "depth_leres"})
			if got != id {
				t.Fatalf("default UUID alias selected %q, want %q", got, id)
			}
		}
		if profile.ControlNet.Models[0] != alias {
			t.Fatal("UUID comparison changed the declared whitelist")
		}
	}
}

func TestLiblibCheckpointUUIDAliasesPreserveKnownBaseAndPreset(t *testing.T) {
	profile := DefaultImageCapabilityConfig(protocol.LiblibImageProtocolID, verifiedLiblibSDCheckpoint)
	alias := " \t" + strings.ToUpper(verifiedLiblibSDCheckpoint) + "\n"
	if got := configuredControlNetBase(profile.ControlNet, nil, alias); got != "sdxl" {
		t.Fatalf("known checkpoint alias base=%q, want sdxl", got)
	}
	profile.ControlNet.BaseModel = "sd15"
	if got := configuredControlNetBase(profile.ControlNet, map[string]any{"checkPointId": alias}, "unknown"); got != "" {
		t.Fatalf("known checkpoint alias bypassed conflicting base: %q", got)
	}
	cm := verifiedLiblibChannelModel(t)
	cm.ProviderModelKey = alias
	capability := DefaultModelCapabilityConfigForModel(protocol.LiblibImageProtocolID, verifiedLiblibSDCheckpoint)
	capability.Image.ControlNet.Models = []string{" B6806516962F4E1599A93AC4483C3D23 "}
	cm.CapabilityConfigJSON = mustEncodeModelCapabilityConfig(t, capability)
	if defaults := channelModelProviderDefaults(cm); defaults["family"] != "sd" || defaults["controlNetModel"] != "b6806516962f4e1599a93ac4483c3d23" || defaults["textToImageTemplateUuid"] == nil {
		t.Fatalf("known checkpoint/whitelist aliases lost verified preset: %#v", defaults)
	}
}
