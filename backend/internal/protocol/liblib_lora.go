package protocol

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"strings"
)

const LiblibMaxAdditionalNetworks = 5

type LiblibAdditionalNetwork struct {
	ModelID string  `json:"modelId"`
	Weight  float64 `json:"weight"`
}

// NormalizeLiblibAdditionalNetworks accepts only the documented LoRA wire fields.
// Compatibility with the selected checkpoint is checked against channel metadata.
func NormalizeLiblibAdditionalNetworks(value any) ([]LiblibAdditionalNetwork, error) {
	if value == nil {
		return nil, nil
	}
	data, err := json.Marshal(value)
	if err != nil || bytes.Equal(bytes.TrimSpace(data), []byte("null")) {
		return nil, fmt.Errorf("Liblib additionalNetwork 必须是 LoRA 数组")
	}
	var entries []map[string]json.RawMessage
	if err := json.Unmarshal(data, &entries); err != nil || len(entries) > LiblibMaxAdditionalNetworks {
		return nil, fmt.Errorf("Liblib additionalNetwork 必须是最多 5 个 LoRA 的数组")
	}
	result := make([]LiblibAdditionalNetwork, 0, len(entries))
	seen := make(map[string]bool)
	for i, entry := range entries {
		for name := range entry {
			if name != "modelId" && name != "weight" {
				return nil, fmt.Errorf("LoRA %d 包含未声明参数 %s", i+1, name)
			}
		}
		var id string
		if json.Unmarshal(entry["modelId"], &id) != nil {
			return nil, fmt.Errorf("LoRA %d 需要模型版本 UUID", i+1)
		}
		id = CanonicalLiblibModelID(id)
		decoded, decodeErr := hex.DecodeString(id)
		if decodeErr != nil || len(decoded) != 16 || seen[id] {
			return nil, fmt.Errorf("LoRA 模型版本 UUID 必须为唯一的 32 位 UUID")
		}
		seen[id] = true
		weight := 0.8
		if raw, present := entry["weight"]; present {
			if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) || json.Unmarshal(raw, &weight) != nil || math.IsNaN(weight) || math.IsInf(weight, 0) || weight < -4 || weight > 4 {
				return nil, fmt.Errorf("LoRA %d 权重必须在 -4 到 4 之间", i+1)
			}
		}
		result = append(result, LiblibAdditionalNetwork{ModelID: strings.ToLower(id), Weight: weight})
	}
	return result, nil
}
