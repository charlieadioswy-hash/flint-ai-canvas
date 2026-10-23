package app

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"yingce/backend/internal/protocol"
)

func TestDefaultPixelImageCapabilitiesPassAdmissionAndEncodePixels(t *testing.T) {
	for _, tc := range []struct{ protocol, packageID, model, size string }{
		{"openai-image", "openai-images", "gpt-image-1.5", "1024x1024"},
		{"openai-image", "openai-images", "gpt-image-2", "1024x1024"},
		{"openai-image", "openai-images", "gpt-image-2.5-sunburst", "1024x1024"},
		{"volcengine-ark-image", "volcengine-ark-seedream", "doubao-seedream-5-0-pro-260628", "2048x2048"},
	} {
		t.Run(tc.protocol+"/"+tc.model, func(t *testing.T) {
			profile := DefaultModelCapabilityConfigForModel(tc.protocol, tc.model)
			if profile.Image.Size.Default != tc.size || len(profile.Image.Size.Values) != 31 || len(profile.Image.Size.Presets) != 0 || profile.Image.Resolution.Supported {
				t.Fatalf("default must use existing pixels without inferred resolution: %+v", profile.Image)
			}
			for _, size := range profile.Image.Size.Values {
				if strings.Contains(size, ":") {
					t.Fatalf("unmapped ratio in pixel defaults: %s", size)
				}
			}
			adapter := imageParameterTestAdapter(t, tc.packageID, tc.protocol)
			service := &Service{}
			for _, size := range []string{tc.size, "2048x878", "3840x2160"} {
				quality := ""
				if profile.Image.Quality.Supported {
					quality = "high"
				}
				input := map[string]any{"mode": "image", "prompt": "offline payload check", "config": map[string]any{
					"interfaceType": tc.protocol, "model": tc.model, "size": size, "quality": quality, "count": "1", "capabilityConfig": profile,
				}}
				if err := service.ValidateTaskCapability(input); err != nil {
					t.Fatalf("admission rejected declared pixels %s: %v", size, err)
				}
				encoded, err := json.Marshal(input)
				if err != nil {
					t.Fatal(err)
				}
				var task canvasGenerationInput
				if err := json.Unmarshal(encoded, &task); err != nil {
					t.Fatal(err)
				}
				if err := service.validateResolvedImageCapability(&task); err != nil {
					t.Fatalf("worker preflight rejected admitted pixels %s: %v", size, err)
				}
				spec, err := adapter.BuildCreate(context.Background(), protocol.RequestContext{Request: protocolRequestFromInput(task)})
				if err != nil {
					t.Fatal(err)
				}
				encoded, err = json.Marshal(spec.Body)
				if err != nil {
					t.Fatal(err)
				}
				var body map[string]any
				if err := json.Unmarshal(encoded, &body); err != nil {
					t.Fatal(err)
				}
				if body["size"] != size || body["resolution"] != nil || quality != "" && body["quality"] != quality {
					t.Fatalf("pixel or ordinary quality changed in provider payload: %#v", body)
				}
			}
			for _, ratio := range []string{"1:1", "16:9"} {
				input := map[string]any{"mode": "image", "config": map[string]any{
					"interfaceType": tc.protocol, "model": tc.model, "size": ratio, "capabilityConfig": profile,
				}}
				if err := service.ValidateTaskCapability(input); err == nil {
					t.Fatalf("unmapped ratio reached provider path: %s", ratio)
				}
			}
		})
	}
}
