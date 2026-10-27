package app

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"net/url"
	"strings"
	"unicode/utf8"

	"yingce/backend/internal/generation"
	"yingce/backend/internal/model"
	"yingce/backend/internal/protocol"
)

const liblibLoRASnapshotKey = "_liblibLoRASnapshot"

func validateLiblibLoRAQuoteOptions(intent ModelRequestIntent) error {
	for namespace, options := range intent.ProviderOptions {
		if intent.Capability != "image" || namespace != protocol.LiblibImageProtocolID {
			return BadAuthRequest("报价专有参数仅支持 Liblib 图片 LoRA")
		}
		for name, value := range options {
			if name != "additionalNetwork" {
				return BadAuthRequest("报价不支持专有参数：" + name)
			}
			if value == nil {
				return BadAuthRequest("报价 additionalNetwork 必须是 LoRA 数组")
			}
			if _, err := protocol.NormalizeLiblibAdditionalNetworks(value); err != nil {
				return BadAuthRequest(err.Error())
			}
		}
	}
	return nil
}

func (s *Service) validateLiblibLoRAQuote(raw map[string]any) error {
	// Quote reference arrays contain count placeholders, and quote options may
	// use numeric values where task execution uses strings. LoRA only needs the
	// resolved channel identity and provider options, so do not decode the quote
	// as a complete executable task.
	metadata, _ := raw["metadata"].(map[string]any)
	config, _ := raw["config"].(map[string]any)
	input := canvasGenerationInput{Mode: stringValue(raw["mode"]), Metadata: metadata, Config: providerConfig{
		ChannelID:        stringValue(config["channelId"]),
		ChannelModelKey:  stringValue(config["channelModelKey"]),
		ProviderModelKey: stringValue(config["providerModelKey"]),
		Model:            stringValue(config["model"]),
		InterfaceType:    stringValue(config["interfaceType"]),
	}}
	networks, err := protocol.NormalizeLiblibAdditionalNetworks(liblibLoRAOptions(input)["additionalNetwork"])
	if err != nil {
		return BadAuthRequest(err.Error())
	}
	if len(networks) == 0 {
		return nil
	}
	item, err := s.repo.ChannelModelByKey(input.Config.ChannelID, providerChannelModelKey(input.Config))
	if err != nil {
		return BadAuthRequest("报价渠道模型不可用")
	}
	profile, err := normalizedChannelModelCapability(item, s.protocolRegistry())
	if err != nil || profile == nil || profile.Image == nil {
		return BadAuthRequest("报价渠道模型尚未配置 LoRA 能力")
	}
	return prepareLiblibLoRATaskInput(raw, &input, profile.Image)
}

func (s *Service) validateLoRAIntentForRoute(item model.ChannelModel, intent ModelRequestIntent) error {
	if intent.Capability != "image" {
		return nil
	}
	options := channelModelProviderDefaults(item)
	if selected, ok := intent.ProviderOptions[protocol.LiblibImageProtocolID]; ok {
		if value, present := selected["additionalNetwork"]; present {
			options["additionalNetwork"] = value
		}
	}
	if options["additionalNetwork"] == nil && intent.styleProfileJSON == "" {
		return nil
	}
	profile, err := normalizedChannelModelCapability(&item, s.protocolRegistry())
	if err != nil || profile == nil || profile.Image == nil {
		return BadAuthRequest("当前供应线路不支持 LoRA")
	}
	providerModel := firstNonEmpty(item.ProviderModelKey, item.ModelKey)
	if tier := channelModelPriceTierForIntent(item, intent); tier != nil {
		providerModel = firstNonEmpty(tier.ProviderModelKey, providerModel)
	}
	input := canvasGenerationInput{Mode: "image", Config: providerConfig{ChannelID: item.ChannelID, Model: item.ModelKey, ProviderModelKey: providerModel, InterfaceType: string(item.Protocol)}, Metadata: map[string]any{"providerOptions": map[string]any{protocol.LiblibImageProtocolID: options}}}
	if intent.styleProfileJSON != "" {
		input.Metadata["styleProfileJson"] = intent.styleProfileJSON
	}
	if err := prepareLiblibLoRATaskInput(map[string]any{}, &input, profile.Image); err != nil {
		return err
	}
	if intent.styleProfileJSON != "" && item.Protocol != protocol.LiblibImageProtocolID {
		validated, err := validateStyleProfileJSON(intent.styleProfileJSON)
		if err != nil {
			return BadAuthRequest("项目画风执行配置无效：" + err.Error())
		}
		var style styleProfileDocument
		if err := json.Unmarshal([]byte(validated), &style); err != nil {
			return BadAuthRequest("项目画风执行配置解析失败")
		}
		if _, status, warnings := resolveGenerationStyleExecution(style, input.Config.Model, input.Config.InterfaceType); status == "blocked" {
			return BadAuthRequest("当前供应线路无法完整执行项目画风：" + strings.Join(warnings, "；"))
		}
	}
	return nil
}

func validateChannelLoRADefaults(item model.ChannelModel, capability *ModelCapabilityConfig) error {
	if string(item.Protocol) != protocol.LiblibImageProtocolID {
		return nil
	}
	defaults := channelModelProviderDefaults(item)
	networks, err := protocol.NormalizeLiblibAdditionalNetworks(defaults["additionalNetwork"])
	if err != nil {
		return BadAuthRequest(err.Error())
	}
	if len(networks) == 0 {
		return nil
	}
	if capability == nil || capability.Image == nil {
		return BadAuthRequest("请先配置 LoRA 兼容模型目录")
	}
	input := canvasGenerationInput{Mode: "image", Config: providerConfig{Model: firstNonEmpty(item.ProviderModelKey, item.ModelKey), InterfaceType: string(item.Protocol)}, Metadata: map[string]any{"providerOptions": map[string]any{string(item.Protocol): defaults}}}
	_, err = validateLiblibLoRASelection(capability.Image, input, networks)
	return err
}

// Admission replaces this internal snapshot, even if a client supplies one.
// Workers reuse it so queued tasks keep their validated IDs and trigger words.
type liblibLoRASnapshot struct {
	ChannelID    string                             `json:"channelId"`
	Model        string                             `json:"model"`
	Checkpoint   string                             `json:"checkpoint"`
	Networks     []protocol.LiblibAdditionalNetwork `json:"networks"`
	TriggerWords []string                           `json:"triggerWords"`
	// A pointer also freezes the absence of a project style. Nil preserves the
	// execution behavior of tasks admitted before style snapshots were added.
	StyleProfileJSON *string `json:"styleProfileJson,omitempty"`
}

func validateLoRACapability(value *generation.LoRACapability) error {
	if value == nil {
		return nil
	}
	validBase := func(base string) bool { return base == "sd15" || base == "sdxl" || base == "f1" }
	if value.Supported && (value.MaxNetworks < 1 || value.MaxNetworks > protocol.LiblibMaxAdditionalNetworks || !validBase(value.BaseModel) || len(value.Models) == 0) {
		return BadAuthRequest("LoRA 必须配置 1–5 个组合上限、基础算法及兼容模型目录")
	}
	if len(value.Models) > 256 {
		return BadAuthRequest("LoRA 模型目录最多 256 项")
	}
	seen := make(map[string]bool)
	for i := range value.Models {
		entry := &value.Models[i]
		entry.ID = protocol.CanonicalLiblibModelID(entry.ID)
		decoded, err := hex.DecodeString(entry.ID)
		if err != nil || len(decoded) != 16 || seen[entry.ID] || strings.TrimSpace(entry.Name) == "" || len(entry.Name) > 500 || !validBase(entry.BaseModel) {
			return BadAuthRequest("LoRA 目录须提供唯一的 32 位版本 UUID、名称及基础算法")
		}
		seen[entry.ID] = true
		if entry.DefaultWeight != nil && (math.IsNaN(*entry.DefaultWeight) || math.IsInf(*entry.DefaultWeight, 0) || *entry.DefaultWeight < -4 || *entry.DefaultWeight > 4) {
			return BadAuthRequest("LoRA 默认权重必须在 -4 到 4 之间")
		}
		if len(entry.TriggerWords) > 50 {
			return BadAuthRequest("单个 LoRA 最多声明 50 个触发词")
		}
		for _, word := range entry.TriggerWords {
			if strings.TrimSpace(word) == "" || len(word) > 2000 {
				return BadAuthRequest("LoRA 触发词不能为空且不能超过 2000 字节")
			}
		}
		if entry.SourceURL != "" {
			source, err := url.Parse(entry.SourceURL)
			if err != nil || (source.Scheme != "https" && source.Scheme != "http") || source.Host == "" || source.User != nil || len(entry.SourceURL) > 4096 {
				return BadAuthRequest("LoRA 来源须为有效的公开网页 URL")
			}
		}
	}
	return nil
}

func liblibLoRAOptions(input canvasGenerationInput) map[string]any {
	namespaces, _ := input.Metadata["providerOptions"].(map[string]any)
	options, _ := namespaces[protocol.LiblibImageProtocolID].(map[string]any)
	return options
}

func liblibLoRAIdentity(input canvasGenerationInput) (string, string, string) {
	options := liblibLoRAOptions(input)
	model := protocol.CanonicalLiblibModelID(firstNonEmpty(input.Config.ProviderModelKey, input.Config.Model))
	checkpoint := protocol.CanonicalLiblibModelID(firstNonEmpty(metadataString(options, "checkPointId"), model))
	return firstNonEmpty(input.Config.ChannelID, systemChannelIDFromBaseURL(input.Config.BaseURL)), model, checkpoint
}

func liblibLoRASnapshotMatches(input canvasGenerationInput, networks []protocol.LiblibAdditionalNetwork) bool {
	snapshot := input.LiblibLoRA
	if snapshot == nil || input.Mode != "image" || input.Config.InterfaceType != protocol.LiblibImageProtocolID || len(snapshot.Networks) != len(networks) {
		return false
	}
	channel, model, checkpoint := liblibLoRAIdentity(input)
	if snapshot.ChannelID != channel || snapshot.Model != model || snapshot.Checkpoint != checkpoint {
		return false
	}
	for i, network := range networks {
		if snapshot.Networks[i] != network {
			return false
		}
	}
	return true
}

func validateLiblibLoRASelection(profile *ImageCapabilityConfig, input canvasGenerationInput, networks []protocol.LiblibAdditionalNetwork) ([]string, error) {
	if len(networks) == 0 {
		return nil, nil
	}
	if input.Mode != "image" || input.Config.InterfaceType != protocol.LiblibImageProtocolID || profile == nil || profile.LoRA == nil || !profile.LoRA.Supported {
		return nil, BadAuthRequest("当前渠道模型未启用 Liblib LoRA")
	}
	capability := profile.LoRA
	if len(networks) > capability.MaxNetworks {
		return nil, BadAuthRequest("LoRA 组合超过当前模型支持上限")
	}
	_, model, checkpoint := liblibLoRAIdentity(input)
	options := liblibLoRAOptions(input)
	family := metadataString(options, "family")
	base := capability.BaseModel
	if checkpoint != model || family == "f1" && base != "f1" || family == "sd" && base != "sd15" && base != "sdxl" || family != "sd" && family != "f1" || model == verifiedLiblibSDCheckpoint && base != "sdxl" {
		return nil, BadAuthRequest("LoRA 基础算法与当前 family 或 Checkpoint 不兼容；不能覆盖已登记的 Checkpoint")
	}
	if profile.ControlNet != nil && profile.ControlNet.BaseModel != "" && profile.ControlNet.BaseModel != base {
		return nil, BadAuthRequest("LoRA 与 ControlNet 声明的基础算法不一致")
	}
	models := make(map[string]generation.LoRAModelConfig, len(capability.Models))
	for _, entry := range capability.Models {
		models[protocol.CanonicalLiblibModelID(entry.ID)] = entry
	}
	words := make([]string, 0)
	seenWords := make(map[string]bool)
	for _, network := range networks {
		entry, found := models[network.ModelID]
		if !found {
			return nil, BadAuthRequest("LoRA 未在当前渠道模型的兼容目录登记：" + network.ModelID)
		}
		if entry.BaseModel != base {
			return nil, BadAuthRequest(fmt.Sprintf("LoRA %s 的基础算法与当前 Checkpoint 不兼容", entry.Name))
		}
		for _, word := range entry.TriggerWords {
			word = strings.TrimSpace(word)
			if !seenWords[word] && word != "" {
				seenWords[word] = true
				words = append(words, word)
			}
		}
	}
	return words, nil
}

func prepareLiblibLoRATaskInput(raw map[string]any, input *canvasGenerationInput, profile *ImageCapabilityConfig) error {
	options := liblibLoRAOptions(*input)
	networks, err := protocol.NormalizeLiblibAdditionalNetworks(options["additionalNetwork"])
	if err != nil {
		return BadAuthRequest(err.Error())
	}
	// Only saved task execution can reuse a snapshot. Public admission and quote
	// requests always rebuild it from the selected channel's authoritative profile.
	if raw == nil && liblibLoRASnapshotMatches(*input, networks) {
		return nil
	}
	input.LiblibLoRA = nil
	if raw != nil {
		delete(raw, liblibLoRASnapshotKey)
	}
	networks, err = compileLiblibStyleLoRA(profile, *input, networks)
	if err != nil {
		return err
	}
	words, err := validateLiblibLoRASelection(profile, *input, networks)
	if err != nil {
		return err
	}
	if len(networks) == 0 && (input.Mode != "image" || input.Config.InterfaceType != protocol.LiblibImageProtocolID) {
		return nil
	}
	channel, model, checkpoint := liblibLoRAIdentity(*input)
	styleProfileJSON := metadataString(input.Metadata, "styleProfileJson")
	input.LiblibLoRA = &liblibLoRASnapshot{ChannelID: channel, Model: model, Checkpoint: checkpoint, Networks: networks, TriggerWords: words, StyleProfileJSON: &styleProfileJSON}
	if len(networks) == 0 {
		if raw != nil {
			raw[liblibLoRASnapshotKey] = input.LiblibLoRA
		}
		return nil
	}
	if input.Metadata == nil {
		input.Metadata = make(map[string]any)
	}
	namespaces, _ := input.Metadata["providerOptions"].(map[string]any)
	if namespaces == nil {
		namespaces = make(map[string]any)
		input.Metadata["providerOptions"] = namespaces
	}
	if options == nil {
		options = make(map[string]any)
		namespaces[protocol.LiblibImageProtocolID] = options
	}
	options["additionalNetwork"] = networks
	if profile.References.PromptMaxChars > 0 && utf8.RuneCountInString(liblibLoRAPrompt(*input, input.Prompt)) > profile.References.PromptMaxChars {
		return BadAuthRequest("包含 LoRA 触发词的完整提示词超过当前模型长度限制")
	}
	if raw != nil {
		raw[liblibLoRASnapshotKey] = input.LiblibLoRA
		raw["metadata"] = input.Metadata
	}
	return nil
}

func compileLiblibStyleLoRA(profile *ImageCapabilityConfig, input canvasGenerationInput, selected []protocol.LiblibAdditionalNetwork) ([]protocol.LiblibAdditionalNetwork, error) {
	if input.Mode != "image" || input.Config.InterfaceType != protocol.LiblibImageProtocolID {
		return selected, nil
	}
	raw := metadataString(input.Metadata, "styleProfileJson")
	if raw == "" {
		return selected, nil
	}
	validated, err := validateStyleProfileJSON(raw)
	if err != nil {
		return nil, BadAuthRequest("项目画风执行配置无效：" + err.Error())
	}
	var style styleProfileDocument
	if err := json.Unmarshal([]byte(validated), &style); err != nil {
		return nil, BadAuthRequest("项目画风执行配置解析失败")
	}
	models := make(map[string]generation.LoRAModelConfig)
	if profile != nil && profile.LoRA != nil && profile.LoRA.Supported {
		for _, model := range profile.LoRA.Models {
			if model.BaseModel == profile.LoRA.BaseModel {
				models[protocol.CanonicalLiblibModelID(model.ID)] = model
			}
		}
	}
	seen := make(map[string]bool)
	result := append([]protocol.LiblibAdditionalNetwork(nil), selected...)
	for _, network := range selected {
		seen[network.ModelID] = true
	}
	for _, asset := range style.Assets {
		if asset.Kind != "lora" || asset.Status != "validated" || asset.Enabled != nil && !*asset.Enabled || !liblibStyleAssetProvider(asset.Provider) || len(asset.BaseModels) > 0 && !styleAssetSupportsModel(asset.BaseModels, input.Config.Model) {
			continue
		}
		id := liblibStyleAssetModelID(asset)
		model, found := models[id]
		if !found || seen[id] {
			continue
		}
		weight := 0.8
		if model.DefaultWeight != nil {
			weight = *model.DefaultWeight
		}
		if asset.Weight != nil {
			weight = *asset.Weight
		}
		if math.IsNaN(weight) || math.IsInf(weight, 0) || weight < -4 || weight > 4 {
			return nil, BadAuthRequest("项目 LoRA 权重必须在 -4 到 4 之间")
		}
		seen[id] = true
		result = append(result, protocol.LiblibAdditionalNetwork{ModelID: id, Weight: weight})
	}
	if len(result) > protocol.LiblibMaxAdditionalNetworks {
		return nil, BadAuthRequest("项目画风与手工选择合计最多 5 个 LoRA")
	}
	if _, status, warnings := resolveGenerationStyleExecutionWithLoRA(style, input.Config.Model, input.Config.InterfaceType, seen); status == "blocked" {
		return nil, BadAuthRequest("当前图片模型无法完整执行项目画风：" + strings.Join(warnings, "；"))
	}
	return result, nil
}

func liblibStyleAssetProvider(provider string) bool {
	return strings.EqualFold(strings.TrimSpace(provider), "liblib") || strings.EqualFold(strings.TrimSpace(provider), protocol.LiblibImageProtocolID)
}

func liblibStyleAssetModelID(asset styleProfileAsset) string {
	for _, candidate := range []string{asset.Version, asset.SourceID} {
		id := protocol.CanonicalLiblibModelID(candidate)
		if decoded, err := hex.DecodeString(id); err == nil && len(decoded) == 16 {
			return id
		}
	}
	return ""
}

func liblibLoRAPrompt(input canvasGenerationInput, prompt string) string {
	networks, err := protocol.NormalizeLiblibAdditionalNetworks(liblibLoRAOptions(input)["additionalNetwork"])
	if err != nil || !liblibLoRASnapshotMatches(input, networks) {
		return prompt
	}
	result := prompt
	for _, word := range input.LiblibLoRA.TriggerWords {
		if word = strings.TrimSpace(word); word != "" && !strings.Contains(result, word) {
			result += "\n" + word
		}
	}
	return result
}
