package app

import (
	"encoding/hex"
	"fmt"
	"strings"

	"yingce/backend/internal/generation"
	"yingce/backend/internal/protocol"
)

func validControlNetBaseModel(value string) bool {
	return value == "sd15" || value == "sdxl" || value == "f1" || value == "qwen-image"
}

func validateControlNetModelCatalog(capability *generation.ControlNetCapability) error {
	if capability.BaseModel != "" && !validControlNetBaseModel(capability.BaseModel) {
		return BadAuthRequest("未知 ControlNet 基础算法")
	}
	if len(capability.ModelCatalog) > 256 {
		return BadAuthRequest("自定义 ControlNet 模型目录最多 256 项")
	}
	types := map[string]bool{}
	for _, entry := range protocol.ControlNetTypes() {
		types[entry.ID] = true
	}
	seen := map[string]bool{}
	for _, entry := range capability.ModelCatalog {
		id := protocol.CanonicalLiblibModelID(entry.ID)
		decoded, err := hex.DecodeString(id)
		if err != nil || len(decoded) != 16 {
			return BadAuthRequest("ControlNet 模型目录标识必须使用有效的 32 位 UUID")
		}
		if strings.TrimSpace(entry.Name) == "" || seen[id] || !validControlNetBaseModel(entry.BaseModel) || len(entry.ControlTypes) == 0 {
			return BadAuthRequest("ControlNet 模型目录须提供唯一标识、名称、基础算法和 Control Type")
		}
		seen[id] = true
		for _, controlType := range entry.ControlTypes {
			if !types[controlType] {
				return BadAuthRequest("模型目录包含未知 Control Type")
			}
		}
		if official, ok := protocol.LookupLiblibControlNetModel(entry.ID); ok {
			if official.BaseModel != entry.BaseModel {
				return BadAuthRequest("不能覆盖官方控制模型的基础算法")
			}
			for _, controlType := range entry.ControlTypes {
				if !containsCapabilityString(official.ControlTypes, controlType) {
					return BadAuthRequest("不能覆盖官方控制模型的 Control Type")
				}
			}
		}
	}
	return nil
}

func configuredControlNetModel(capability *generation.ControlNetCapability, id string) (protocol.LiblibControlNetModelDefinition, bool) {
	id = protocol.CanonicalLiblibModelID(id)
	if official, ok := protocol.LookupLiblibControlNetModel(id); ok {
		return official, true
	}
	for _, entry := range capability.ModelCatalog {
		if protocol.CanonicalLiblibModelID(entry.ID) == id {
			return protocol.LiblibControlNetModelDefinition{ID: id, Name: entry.Name, BaseModel: entry.BaseModel, ControlTypes: entry.ControlTypes}, true
		}
	}
	return protocol.LiblibControlNetModelDefinition{}, false
}

func configuredControlNetBase(capability *generation.ControlNetCapability, options map[string]any, checkpoint string) string {
	family := metadataString(options, "family")
	knownBase := ""
	if family == "f1" {
		knownBase = "f1"
	} else if protocol.CanonicalLiblibModelID(firstNonEmpty(metadataString(options, "checkPointId"), checkpoint)) == verifiedLiblibSDCheckpoint {
		knownBase = "sdxl"
	}
	if capability.BaseModel != "" {
		if knownBase != "" && capability.BaseModel != knownBase || family == "sd" && capability.BaseModel == "f1" {
			return ""
		}
		return capability.BaseModel
	}
	if knownBase != "" {
		return knownBase
	}
	ids := append([]string{}, capability.Models...)
	if preset := metadataString(options, "controlNetModel"); preset != "" {
		ids = append(ids, preset)
	}
	base := ""
	for _, id := range ids {
		entry, known := configuredControlNetModel(capability, id)
		if !known {
			continue
		}
		if base != "" && base != entry.BaseModel {
			return ""
		}
		base = entry.BaseModel
	}
	if family == "sd" && base == "f1" {
		return ""
	}
	return base
}

func controlNetModelSupports(entry protocol.LiblibControlNetModelDefinition, parameters protocol.ControlNetParameters, base string) bool {
	return entry.BaseModel == base && containsCapabilityString(entry.ControlTypes, parameters.ResolvedControlType()) &&
		(len(entry.Preprocessors) == 0 || containsCapabilityString(entry.Preprocessors, parameters.Preprocessor))
}

func defaultChannelControlNetModel(capability *generation.ControlNetCapability, options map[string]any, checkpoint string, values map[string]any) string {
	parameters := protocol.ControlNetParameters{Preprocessor: metadataString(values, "preprocessor"), ControlType: metadataString(values, "controlType")}
	controlType := parameters.ResolvedControlType()
	if controlType == "" || controlType == "reference" || controlType == "none" {
		return ""
	}
	base := configuredControlNetBase(capability, options, checkpoint)
	allowed := func(id string) bool {
		if len(capability.Models) > 0 && !containsCapabilityString(capability.Models, id) {
			return false
		}
		entry, known := configuredControlNetModel(capability, id)
		return known && controlNetModelSupports(entry, parameters, base)
	}
	preferred := metadataString(options, "controlNetModel")
	if preferred != "" {
		if allowed(preferred) {
			return protocol.CanonicalLiblibModelID(preferred)
		}
		if _, known := configuredControlNetModel(capability, preferred); !known && controlType == "canny" {
			// This legacy field is explicitly a Canny default, never another type.
			return protocol.CanonicalLiblibModelID(preferred)
		}
	}
	if processor, ok := protocol.ControlNetPreprocessor(parameters.Preprocessor); ok {
		for _, id := range processor.RecommendedModels {
			if allowed(id) {
				return id
			}
		}
	}
	for _, entry := range protocol.LiblibControlNetModels() {
		if allowed(entry.ID) {
			return protocol.CanonicalLiblibModelID(entry.ID)
		}
	}
	for _, entry := range capability.ModelCatalog {
		if allowed(entry.ID) {
			return protocol.CanonicalLiblibModelID(entry.ID)
		}
	}
	return ""
}

func validateLiblibControlNetSelection(capability *generation.ControlNetCapability, input canvasGenerationInput, unit generation.ControlNetUnit) error {
	namespaces, _ := input.Metadata["providerOptions"].(map[string]any)
	options, _ := namespaces[protocol.LiblibImageProtocolID].(map[string]any)
	base := configuredControlNetBase(capability, options, firstNonEmpty(input.Config.ProviderModelKey, input.Config.Model))
	if base == "" {
		return BadAuthRequest("请配置 ControlNet 基础算法（SD 1.5、SDXL 或 F.1），并核对与当前模型 family、checkpoint 的兼容性")
	}
	if base == "qwen-image" {
		return BadAuthRequest("当前 Liblib SD / F.1 调用协议尚未接入 Qwen Image 模板")
	}
	parameters := unit.Parameters
	modelID := protocol.CanonicalLiblibModelID(parameters.Model)
	if parameters.ResolvedControlType() == "reference" {
		if modelID != "" || base != "sd15" {
			return BadAuthRequest("Reference 使用 SD 1.5 基础算法及 None 模型")
		}
		return nil
	}
	decoded, err := hex.DecodeString(modelID)
	if err != nil || len(decoded) != 16 {
		return BadAuthRequest("Liblib 控制模型必须使用有效的 32 位 UUID")
	}
	entry, known := configuredControlNetModel(capability, parameters.Model)
	if !known {
		return BadAuthRequest("请管理员先在 ControlNet 目录登记该模型的 Control Type 与基础算法")
	}
	if !controlNetModelSupports(entry, parameters, base) {
		return BadAuthRequest(fmt.Sprintf("控制模型 %s 与所选 Control Type、预处理器或基础算法不兼容", entry.Name))
	}
	if parameters.ResolvedControlType() == "inpaint" && unit.Mask == nil {
		return BadAuthRequest("ControlNet Inpaint 需要选择独立的控制区域蒙版")
	}
	return nil
}
