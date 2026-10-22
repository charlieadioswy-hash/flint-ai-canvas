package protocol

import (
	"math"
	"strconv"
	"strings"
)

func responseProgress(payload map[string]any, mapping *ManifestProgress) *int {
	if mapping == nil || (mapping.Scale != 1 && mapping.Scale != 100) {
		return nil
	}
	value := pathValue(payload, mapping.Path)
	var number float64
	switch v := value.(type) {
	case float64:
		number = v
	case string:
		text := strings.TrimSpace(v)
		if mapping.Scale == 100 {
			text = strings.TrimSpace(strings.TrimSuffix(text, "%"))
		}
		parsed, err := strconv.ParseFloat(text, 64)
		if err != nil {
			return nil
		}
		number = parsed
	default:
		return nil
	}
	if math.IsNaN(number) || math.IsInf(number, 0) || number < 0 || number > float64(mapping.Scale) {
		return nil
	}
	percent := int(math.Round(number * 100 / float64(mapping.Scale)))
	return &percent
}
