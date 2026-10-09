package canvas

import (
	"encoding/json"

	"yingce/backend/internal/assets"
)

type publicCanvasModerationTag struct {
	Code  string `json:"code"`
	Label string `json:"label"`
	Level string `json:"level"`
}

type publicCanvasModerationReport struct {
	Status      string                      `json:"status"`
	OverallRisk string                      `json:"overallRisk"`
	RiskTags    []publicCanvasModerationTag `json:"riskTags"`
	Summary     string                      `json:"summary"`
	CreatedAt   string                      `json:"createdAt"`
	CompletedAt string                      `json:"completedAt,omitempty"`
	IsCurrent   bool                        `json:"isCurrent"`
}

type publicCanvasModerationState struct {
	SourceIdentity string                       `json:"sourceIdentity"`
	Report         publicCanvasModerationReport `json:"report"`
}

// Project only the saved display snapshot. A report cannot grant access to a
// resource or carry private check IDs, provider settings or diagnostics.
func publicCanvasImageModeration(metadata map[string]any, resourceID string) *publicCanvasModerationState {
	storageKey, _ := metadata["storageKey"].(string)
	if resourceID == "" || assets.ResourceID(storageKey) != resourceID {
		return nil
	}
	var saved struct {
		SourceIdentity string `json:"sourceIdentity"`
		Report         struct {
			publicCanvasModerationReport
			ResourceID string `json:"resourceId"`
		} `json:"report"`
	}
	payload, err := json.Marshal(metadata["imageModeration"])
	if err != nil || json.Unmarshal(payload, &saved) != nil || saved.SourceIdentity != storageKey || saved.Report.ResourceID != resourceID {
		return nil
	}
	report := saved.Report.publicCanvasModerationReport
	switch report.Status {
	case "queued", "running", "completed", "partial", "failed":
	default:
		return nil
	}
	if !publicCanvasModerationRisk(report.OverallRisk) {
		return nil
	}
	for _, tag := range report.RiskTags {
		if !publicCanvasModerationRisk(tag.Level) {
			return nil
		}
	}
	if report.RiskTags == nil {
		report.RiskTags = []publicCanvasModerationTag{}
	}
	return &publicCanvasModerationState{SourceIdentity: "resource:" + resourceID, Report: report}
}

func publicCanvasModerationRisk(risk string) bool {
	switch risk {
	case "none", "low", "medium", "high", "unknown":
		return true
	default:
		return false
	}
}
