package model3d

import "testing"

func TestModel3DDelightRequiresTextureVersion(t *testing.T) {
	flag := func(value bool) *bool { return &value }
	config := Config{AllowedModes: []string{"text", "image", "multiview"}}
	for _, model := range Models() {
		config.AllowedModels = append(config.AllowedModels, model.ID)
	}
	cases := []struct {
		name    string
		texture bool
		version string
		delight *bool
		wantErr bool
	}{
		{name: "omitted without texture"},
		{name: "omitted with default texture", texture: true},
		{name: "enabled with default version", texture: true, delight: flag(true), wantErr: true},
		{name: "disabled with default version", texture: true, delight: flag(false), wantErr: true},
		{name: "enabled with H2.5 texture", texture: true, version: "v2.5-20250123", delight: flag(true), wantErr: true},
		{name: "disabled with H2.5 texture", texture: true, version: "v2.5-20250123", delight: flag(false), wantErr: true},
		{name: "enabled with H3.0 texture", texture: true, version: "v3.0-20250812", delight: flag(true), wantErr: true},
		{name: "disabled with H3.0 texture", texture: true, version: "v3.0-20250812", delight: flag(false), wantErr: true},
		{name: "enabled with H3.5 texture", texture: true, version: "v3.5-20260815", delight: flag(true)},
		{name: "disabled with H3.5 texture", texture: true, version: "v3.5-20260815", delight: flag(false)},
		{name: "enabled without texture", delight: flag(true), wantErr: true},
		{name: "disabled without texture", delight: flag(false), wantErr: true},
		{name: "enabled version without texture", version: "v3.5-20260815", delight: flag(true), wantErr: true},
		{name: "disabled version without texture", version: "v3.5-20260815", delight: flag(false), wantErr: true},
	}
	for _, model := range Models() {
		for _, mode := range config.AllowedModes {
			for _, tc := range cases {
				t.Run(model.ID+"/"+mode+"/"+tc.name, func(t *testing.T) {
					prompt := ""
					if mode == "text" {
						prompt = "a ceramic vase"
					}
					parameters := Parameters{Model: model.ID, Texture: tc.texture, TextureVersion: tc.version, Delight: tc.delight}
					if err := ValidateParameters(mode, prompt, parameters, config); (err != nil) != tc.wantErr {
						t.Fatalf("ValidateParameters() = %v, want error %t", err, tc.wantErr)
					}
				})
			}
		}
	}
}
