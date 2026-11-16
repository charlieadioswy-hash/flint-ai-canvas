package handler

import (
	"slices"
	"testing"

	"github.com/goccy/go-yaml"
	"yingce/backend/internal/production"
)

type dramaOpenAPIContractSchema struct {
	Ref        string                                `yaml:"$ref"`
	Type       string                                `yaml:"type"`
	Minimum    *int64                                `yaml:"minimum"`
	MaxLength  *int                                  `yaml:"maxLength"`
	Required   []string                              `yaml:"required"`
	Properties map[string]dramaOpenAPIContractSchema `yaml:"properties"`
	AllOf      []dramaOpenAPIContractSchema          `yaml:"allOf"`
}

type dramaOpenAPIContractContent struct {
	Schema dramaOpenAPIContractSchema `yaml:"schema"`
}

type dramaOpenAPIContractBody struct {
	Required bool                                   `yaml:"required"`
	Content  map[string]dramaOpenAPIContractContent `yaml:"content"`
}

func TestOpenAPIDramaEpisodeAppendContracts(t *testing.T) {
	var spec struct {
		Paths map[string]struct {
			Post struct {
				RequestBody dramaOpenAPIContractBody            `yaml:"requestBody"`
				Responses   map[string]dramaOpenAPIContractBody `yaml:"responses"`
			} `yaml:"post"`
		} `yaml:"paths"`
		Components struct {
			Schemas map[string]dramaOpenAPIContractSchema `yaml:"schemas"`
		} `yaml:"components"`
	}
	if err := yaml.Unmarshal(openAPISpec, &spec); err != nil {
		t.Fatalf("embedded OpenAPI YAML cannot be parsed: %v", err)
	}
	for _, tc := range []struct{ path, request, result string }{
		{"/dramas/{id}/episodes", "AddDramaEpisodeRequest", "DramaEpisodeDetail"},
		{"/dramas/{id}/chapters/produce", "ProduceDramaChaptersRequest", "ProduceDramaChaptersResult"},
	} {
		t.Run(tc.request, func(t *testing.T) {
			operation := spec.Paths[tc.path].Post
			body := operation.RequestBody
			if !body.Required || body.Content["application/json"].Schema.Ref != "#/components/schemas/"+tc.request {
				t.Fatalf("request contract missing from %s: %+v", tc.path, body)
			}
			request := spec.Components.Schemas[tc.request]
			revision := request.Properties["expectedRevision"]
			if !slices.Contains(request.Required, "expectedRevision") || revision.Type != "integer" || revision.Minimum == nil || *revision.Minimum != 0 {
				t.Fatalf("%s must require the current production revision and allow zero: %+v", tc.request, request)
			}
			response := operation.Responses["200"].Content["application/json"].Schema
			if !slices.ContainsFunc(response.AllOf, func(item dramaOpenAPIContractSchema) bool {
				return item.Properties["data"].Ref == "#/components/schemas/"+tc.result
			}) {
				t.Fatalf("success response must expose %s in envelope data: %+v", tc.result, response)
			}
			if _, exists := operation.Responses["409"]; !exists {
				t.Fatal("version-conflict response is missing")
			}
		})
	}
	result := spec.Components.Schemas["ProduceDramaChaptersResult"]
	if !slices.Contains(result.Required, "episodeIds") || !slices.Contains(result.Required, "revision") || result.Properties["revision"].Type != "integer" {
		t.Fatalf("chapter append must return new episode IDs and the production revision: %+v", result)
	}
}

func TestOpenAPIDramaStyleDrawingContracts(t *testing.T) {
	var spec struct {
		Paths map[string]struct {
			Patch struct {
				RequestBody dramaOpenAPIContractBody `yaml:"requestBody"`
			} `yaml:"patch"`
		} `yaml:"paths"`
		Components struct {
			Schemas map[string]dramaOpenAPIContractSchema `yaml:"schemas"`
		} `yaml:"components"`
	}
	if err := yaml.Unmarshal(openAPISpec, &spec); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ path, request string }{
		{"/dramas/{id}/workflow/style", "UpdateDramaWorkflowStyleRequest"},
	} {
		body := spec.Paths[tc.path].Patch.RequestBody
		if !body.Required || body.Content["application/json"].Schema.Ref != "#/components/schemas/"+tc.request {
			t.Fatalf("missing style request contract: %s", tc.path)
		}
		request := spec.Components.Schemas[tc.request]
		if request.Properties["drawing"].Ref != "#/components/schemas/DramaDrawingConfiguration" || slices.Contains(request.Required, "drawing") {
			t.Fatalf("%s must accept optional shared drawing configuration", tc.request)
		}
		prompt := request.Properties["stylePrompt"]
		if prompt.MaxLength == nil || *prompt.MaxLength != production.MaxStylePromptRunes {
			t.Fatalf("%s must use the same style prompt limit as saved and generated settings", tc.request)
		}
	}
	view := spec.Components.Schemas["DramaEpisodeStyle"]
	request := spec.Components.Schemas["UpdateDramaEpisodeStyleRequest"]
	if !slices.Contains(view.Required, "settings") || view.Properties["settings"].Ref != "#/components/schemas/DramaSettings" || !slices.Contains(request.Required, "settings") || request.Properties["settings"].Ref != "#/components/schemas/DramaSettings" {
		t.Fatal("episode settings must read and save a complete independent configuration")
	}
	if _, exists := request.Properties["mode"]; exists {
		t.Fatal("episode configuration must not require a user-selected inheritance mode")
	}
	drawing := spec.Components.Schemas["DramaDrawingConfiguration"]
	if !slices.Contains(drawing.Required, "assets") || !slices.Contains(drawing.Required, "models") {
		t.Fatal("drawing configuration must define the full shared scope")
	}
	models := drawing.Properties["models"]
	if len(models.Properties) != 3 || !slices.Contains(models.Required, "image") || !slices.Contains(models.Required, "characterImage") || !slices.Contains(models.Required, "sceneImage") {
		t.Fatal("drawing updates must expose only the three supported image model choices")
	}
}
