package protocol

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"strings"
)

type ControlNetTypeDefinition struct {
	ID          string `json:"id"`
	Label       string `json:"label"`
	Direction   string `json:"direction"`
	Supported   bool   `json:"supported"`
	Description string `json:"description,omitempty"`
}

type ControlNetProcessorParameterDefinition struct {
	Name     string  `json:"name"`
	WireName string  `json:"wireName"`
	Label    string  `json:"label"`
	Type     string  `json:"type"`
	Min      float64 `json:"min"`
	Max      float64 `json:"max"`
	Default  float64 `json:"default"`
	Step     float64 `json:"step"`
}

type ControlNetPreprocessorDefinition struct {
	ID                string                                   `json:"id"`
	Label             string                                   `json:"label"`
	ControlType       string                                   `json:"controlType"`
	ControlTypes      []string                                 `json:"controlTypes,omitempty"`
	Description       string                                   `json:"description,omitempty"`
	Parameters        []ControlNetProcessorParameterDefinition `json:"parameters"`
	WireValue         int                                      `json:"wireValue"`
	AnnotationKey     string                                   `json:"annotationKey"`
	Source            string                                   `json:"source"`
	Modes             []string                                 `json:"modes,omitempty"`
	RecommendedModels []string                                 `json:"recommendedModels,omitempty"`
}

type LiblibControlNetModelDefinition struct {
	ID            string   `json:"id"`
	Name          string   `json:"name"`
	BaseModel     string   `json:"baseModel"`
	ControlTypes  []string `json:"controlTypes"`
	Preprocessors []string `json:"preprocessors,omitempty"`
	Source        string   `json:"source"`
}

type controlNetCatalogData struct {
	Source        string                             `json:"source"`
	Types         []ControlNetTypeDefinition         `json:"types"`
	Preprocessors []ControlNetPreprocessorDefinition `json:"preprocessors"`
	Models        []LiblibControlNetModelDefinition  `json:"models"`
	Notes         []string                           `json:"notes"`
}

//go:embed controlnet_catalog.json
var controlNetCatalogJSON []byte

var controlNetCatalog = func() controlNetCatalogData {
	var catalog controlNetCatalogData
	if err := json.Unmarshal(controlNetCatalogJSON, &catalog); err != nil {
		panic(fmt.Errorf("decode bundled ControlNet catalogue: %w", err))
	}
	return catalog
}()

func ControlNetCatalogDocument() []byte {
	return append([]byte(nil), controlNetCatalogJSON...)
}

func ControlNetTypes() []ControlNetTypeDefinition {
	return append([]ControlNetTypeDefinition(nil), controlNetCatalog.Types...)
}

func ControlNetPreprocessors() []ControlNetPreprocessorDefinition {
	var result []ControlNetPreprocessorDefinition
	for _, item := range controlNetCatalog.Preprocessors {
		item.Parameters = append([]ControlNetProcessorParameterDefinition{}, item.Parameters...)
		item.ControlTypes = append([]string(nil), item.ControlTypes...)
		item.Modes = append([]string(nil), item.Modes...)
		item.RecommendedModels = append([]string(nil), item.RecommendedModels...)
		result = append(result, item)
	}
	return result
}

func ControlNetPreprocessor(id string) (ControlNetPreprocessorDefinition, bool) {
	for _, item := range controlNetCatalog.Preprocessors {
		if item.ID == id {
			item.Parameters = append([]ControlNetProcessorParameterDefinition{}, item.Parameters...)
			item.ControlTypes = append([]string(nil), item.ControlTypes...)
			item.Modes = append([]string(nil), item.Modes...)
			item.RecommendedModels = append([]string(nil), item.RecommendedModels...)
			return item, true
		}
	}
	return ControlNetPreprocessorDefinition{}, false
}

func LiblibControlNetModels() []LiblibControlNetModelDefinition {
	var result []LiblibControlNetModelDefinition
	for _, item := range controlNetCatalog.Models {
		item.ControlTypes = append([]string(nil), item.ControlTypes...)
		item.Preprocessors = append([]string(nil), item.Preprocessors...)
		result = append(result, item)
	}
	return result
}

// CanonicalLiblibModelID gives UUID-based model identifiers one comparison form.
func CanonicalLiblibModelID(id string) string {
	return strings.ToLower(strings.TrimSpace(id))
}

func LiblibControlNetModel(id string) (LiblibControlNetModelDefinition, bool) {
	id = CanonicalLiblibModelID(id)
	for _, item := range controlNetCatalog.Models {
		if item.ID == id {
			item.ControlTypes = append([]string(nil), item.ControlTypes...)
			item.Preprocessors = append([]string(nil), item.Preprocessors...)
			return item, true
		}
	}
	return LiblibControlNetModelDefinition{}, false
}

func LookupLiblibControlNetModel(id string) (LiblibControlNetModelDefinition, bool) {
	return LiblibControlNetModel(id)
}

func GetControlNetType(preprocessor, explicitType string) (string, error) {
	processor, known := ControlNetPreprocessor(preprocessor)
	if !known {
		return "", fmt.Errorf("未知 ControlNet 预处理器")
	}
	if explicitType == "" {
		return processor.ControlType, nil
	}
	if explicitType != processor.ControlType && !containsControlNetString(processor.ControlTypes, explicitType) {
		return "", fmt.Errorf("Control Type 与预处理器不匹配")
	}
	return explicitType, nil
}

func (p ControlNetParameters) ResolvedControlType() string {
	controlType, _ := GetControlNetType(p.Preprocessor, p.ControlType)
	return controlType
}

// Known provider models carry their official compatibility. Task admission
// requires administrator-registered type/base metadata for an unknown UUID.
func ValidateLiblibControlNetModel(p ControlNetParameters, family string) error {
	controlType := p.ResolvedControlType()
	if controlType == "reference" {
		if CanonicalLiblibModelID(p.Model) != "" {
			return fmt.Errorf("Reference 使用 None 模型，不接受控制模型 UUID")
		}
		if family != "sd" {
			return fmt.Errorf("Reference 官方目录仅支持 SD 1.5 基础算法")
		}
		return nil
	}
	if !liblibUUID(p.Model) {
		return fmt.Errorf("ControlNet 需要有效的平台控制模型 UUID")
	}
	model, known := LiblibControlNetModel(p.Model)
	if !known {
		return nil
	}
	if !containsControlNetString(model.ControlTypes, controlType) {
		return fmt.Errorf("控制模型 %s 不支持所选 Control Type", model.Name)
	}
	if len(model.Preprocessors) > 0 && !containsControlNetString(model.Preprocessors, p.Preprocessor) {
		return fmt.Errorf("控制模型 %s 不支持所选预处理器", model.Name)
	}
	modelFamily := "sd"
	if model.BaseModel == "f1" {
		modelFamily = "f1"
	}
	if model.BaseModel == "qwen-image" || modelFamily != family {
		return fmt.Errorf("控制模型 %s 与当前基础算法 %s 不兼容", model.Name, family)
	}
	return nil
}

func containsControlNetString(values []string, value string) bool {
	for _, item := range values {
		if item == value {
			return true
		}
	}
	return false
}

// ControlNetCatalogTypeScript is generated from the same embedded data used by
// admission and the Liblib wire adapter.
func ControlNetCatalogTypeScript() string {
	var out strings.Builder
	out.WriteString("// Generated by go generate ./internal/canvas/contract. Do not edit.\n")
	out.WriteString(`export type ControlNetTypeDefinition = { id: string; label: string; direction: string; supported: boolean; description?: string };
export type ControlNetProcessorParameterDefinition = { name: string; wireName: string; label: string; type: 'integer' | 'number'; min: number; max: number; default: number; step: number };
export type ControlNetPreprocessorDefinition = { id: string; label: string; controlType: string; controlTypes?: string[]; description?: string; parameters: ControlNetProcessorParameterDefinition[]; wireValue: number; annotationKey: string; source: string; modes?: string[]; recommendedModels?: string[] };
export type LiblibControlNetModelDefinition = { id: string; name: string; baseModel: 'sd15' | 'sdxl' | 'f1' | 'qwen-image'; controlTypes: string[]; preprocessors?: string[]; source: string };

`)
	for _, entry := range []struct {
		name, kind string
		value      any
	}{
		{"CONTROLNET_TYPES", "ControlNetTypeDefinition", controlNetCatalog.Types},
		{"CONTROLNET_PREPROCESSORS", "ControlNetPreprocessorDefinition", controlNetCatalog.Preprocessors},
		{"LIBLIB_CONTROLNET_MODELS", "LiblibControlNetModelDefinition", controlNetCatalog.Models},
	} {
		encoded, _ := json.MarshalIndent(entry.value, "", "    ")
		fmt.Fprintf(&out, "export const %s: readonly %s[] = %s;\n\n", entry.name, entry.kind, encoded)
	}
	return strings.TrimRight(out.String(), "\n") + "\n"
}
