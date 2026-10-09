package app

import (
	"encoding/hex"
	"encoding/json"
	"math"
	"strings"

	"yingce/backend/internal/model"
	"yingce/backend/internal/protocol"
)

const verifiedLiblibSDCheckpoint = "0ea388c7eb854be3ba3c6f65aac6bfd3"
const channelProviderDefaultsSnapshotKey = "channelProviderDefaultsSnapshot"

// This preset is verified only for this checkpoint and Canny XL combination.
// Other models must have explicit administrator defaults.
func channelModelProviderDefaults(cm model.ChannelModel) map[string]any {
	defaults := make(map[string]any)
	checkpoint := firstNonEmpty(metadataString(cm.ProviderDefaults, "checkPointId"), cm.ProviderModelKey, cm.ModelKey)
	if string(cm.Protocol) == protocol.LiblibImageProtocolID && checkpoint == verifiedLiblibSDCheckpoint && (metadataString(cm.ProviderDefaults, "family") == "" || metadataString(cm.ProviderDefaults, "family") == "sd") {
		capability, err := normalizedChannelModelCapability(&cm)
		if err == nil && capability != nil && capability.Image != nil && capability.Image.ControlNet != nil && capability.Image.ControlNet.Supported {
			control := "b6806516962f4e1599a93ac4483c3d23"
			if len(capability.Image.ControlNet.Models) == 0 || containsCapabilityString(capability.Image.ControlNet.Models, control) {
				defaults = map[string]any{"family": "sd", "textToImageTemplateUuid": "e10adc3949ba59abbe56e057f20f883e", "imageToImageTemplateUuid": "9c7d531dc75f476aa833b3d452b8f7ad", "controlNetModel": control, "steps": 20, "sampler": 15, "cfgScale": 7, "seed": -1, "denoisingStrength": 0.75}
			}
		}
	}
	for key, value := range cm.ProviderDefaults {
		defaults[key] = value
	}
	return defaults
}

func normalizeChannelProviderDefaults(registry *protocol.Registry, protocolID string, input map[string]any) (map[string]any, error) {
	result := make(map[string]any)
	if len(input) == 0 {
		return result, nil
	}
	adapter, ok := registry.Resolve(protocolID)
	if !ok {
		return nil, BadAuthRequest("默认参数所属协议不可用")
	}
	parameters := adapter.Metadata().Parameters
	if protocolID == protocol.LiblibImageProtocolID {
		parameters = append(parameters, protocol.LiblibImageAdapter().Metadata().Parameters...)
	}
	allowed := make(map[string]protocol.Parameter)
	for _, parameter := range parameters {
		if parameter.Mapping == "providerOptions."+protocolID+"."+parameter.Name {
			allowed[parameter.Name] = parameter
		}
	}
	for name, value := range input {
		if value == nil {
			continue
		}
		if text, ok := value.(string); ok && strings.TrimSpace(text) == "" {
			continue
		}
		parameter, ok := allowed[name]
		if !ok {
			return nil, BadAuthRequest("协议未声明默认参数：" + name)
		}
		switch strings.ToLower(strings.ReplaceAll(name, "_", "")) {
		case "apikey", "secretkey", "accesskey", "accesstoken", "refreshtoken", "authorization", "cookie", "password":
			return nil, BadAuthRequest("凭据不能保存为公开生成默认参数")
		}
		valid := false
		switch parameter.Type {
		case "string":
			text, isString := value.(string)
			valid = isString && len(text) <= 4000
			if valid && len(parameter.Values) > 0 {
				valid = containsCapabilityString(parameter.Values, text)
			}
		case "boolean":
			_, valid = value.(bool)
		case "integer", "number":
			encoded, err := json.Marshal(value)
			var number float64
			valid = err == nil && json.Unmarshal(encoded, &number) == nil && !math.IsNaN(number) && !math.IsInf(number, 0)
			if valid && parameter.Type == "integer" {
				valid = math.Trunc(number) == number
			}
		}
		if !valid {
			return nil, BadAuthRequest("默认参数类型或取值无效：" + name)
		}
		if protocolID == protocol.LiblibImageProtocolID {
			if strings.Contains(strings.ToLower(name), "uuid") || name == "checkPointId" || name == "controlNetModel" {
				text, _ := value.(string)
				decoded, err := hex.DecodeString(text)
				if err != nil || len(decoded) != 16 {
					return nil, BadAuthRequest("默认参数需要 32 位 UUID：" + name)
				}
			}
			if parameter.Type == "number" || parameter.Type == "integer" {
				encoded, _ := json.Marshal(value)
				var number float64
				_ = json.Unmarshal(encoded, &number)
				if (name == "steps" && number < 1) || (name == "sampler" || name == "cfgScale") && number < 0 || name == "seed" && number < -1 || name == "denoisingStrength" && (number < 0 || number > 1) || (name == "width" || name == "height") && (number < 1 || number > 4096) {
					return nil, BadAuthRequest("默认参数超出允许范围：" + name)
				}
			}
		}
		result[name] = value
	}
	return result, nil
}

// Admission freezes effective values into metadata. Route failover reuses only
// the original user overrides, so another channel cannot inherit this preset.
func applyChannelProviderDefaults(input map[string]any, cm model.ChannelModel) {
	selected := cm
	if config, ok := input["config"].(map[string]any); ok {
		selected.ProviderModelKey = firstNonEmpty(metadataString(config, "providerModelKey"), cm.ProviderModelKey)
	}
	selectedModelKey := firstNonEmpty(selected.ProviderModelKey, selected.ModelKey)
	options := channelModelProviderDefaults(selected)
	metadata, _ := input["metadata"].(map[string]any)
	overrides, _ := metadata["providerOptions"].(map[string]any)
	if len(options) == 0 && overrides[string(cm.Protocol)] == nil && input[channelProviderDefaultsSnapshotKey] == nil {
		return
	}
	if metadata == nil {
		metadata = make(map[string]any)
		input["metadata"] = metadata
	}
	controlModels := make(map[string]any)
	controls, _ := input["controlNet"].([]any)
	for _, value := range controls {
		unit, _ := value.(map[string]any)
		parameters, _ := unit["parameters"].(map[string]any)
		controlModels[metadataString(unit, "id")] = parameters["model"]
	}
	if snapshot, ok := input[channelProviderDefaultsSnapshotKey].(map[string]any); ok {
		if snapshot["channelModelId"] == cm.ID && snapshot["providerModelKey"] == selectedModelKey {
			return
		}
		overrides, _ = snapshot["overrides"].(map[string]any)
		controlModels, _ = snapshot["controlModels"].(map[string]any)
	}
	input[channelProviderDefaultsSnapshotKey] = map[string]any{"channelModelId": cm.ID, "providerModelKey": selectedModelKey, "overrides": overrides, "controlModels": controlModels}
	namespaces := make(map[string]any, len(overrides)+1)
	for key, value := range overrides {
		namespaces[key] = value
	}
	if values, ok := overrides[string(cm.Protocol)].(map[string]any); ok {
		for key, value := range values {
			if value != nil {
				options[key] = value
			}
		}
	}
	if string(cm.Protocol) == protocol.LiblibImageProtocolID {
		if metadataString(options, "templateUuid") == "" {
			key := "textToImageTemplateUuid"
			if references, ok := input["referenceImages"].([]any); ok && len(references) > 0 {
				key = "imageToImageTemplateUuid"
			}
			if template := metadataString(options, key); template != "" {
				options["templateUuid"] = template
			}
		}
		for _, value := range controls {
			unit, _ := value.(map[string]any)
			parameters, _ := unit["parameters"].(map[string]any)
			if parameters == nil {
				continue
			}
			controlModel := firstNonEmpty(stringValue(controlModels[metadataString(unit, "id")]), metadataString(options, "controlNetModel"))
			parameters["model"] = controlModel
		}
	}
	if len(options) > 0 {
		namespaces[string(cm.Protocol)] = options
	}
	metadata["providerOptions"] = namespaces
}
