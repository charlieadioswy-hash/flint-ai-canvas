package repository

import (
	"encoding/json"

	"yingce/backend/internal/model"
)

// Current frames and explicit references must survive library deletion just as
// the output versions do. Completed output history is already held by DramaTake.
func (r *Repository) DramaShotMediaResourceReferences(userID string, resourceIDs []string) ([]ResourceDirectReference, error) {
	references := []ResourceDirectReference{}
	if len(resourceIDs) == 0 {
		return references, nil
	}
	wanted := make(map[string]bool, len(resourceIDs))
	for _, id := range resourceIDs {
		wanted[id] = true
	}
	projects := r.db.Model(&model.DramaProduction{}).Select("project_id").Where("user_id = ?", userID)
	var slots []model.DramaShotMedia
	if err := r.db.Where("project_id IN (?)", projects).Find(&slots).Error; err != nil {
		return nil, err
	}
	for _, slot := range slots {
		var config struct {
			ReferenceResourceIDs []string `json:"referenceResourceIds"`
			FirstFrameResourceID string   `json:"firstFrameResourceId"`
			LastFrameResourceID  string   `json:"lastFrameResourceId"`
		}
		if err := json.Unmarshal([]byte(slot.ConfigJSON), &config); err != nil {
			return nil, err
		}
		ids := append(append([]string{}, config.ReferenceResourceIDs...), config.FirstFrameResourceID, config.LastFrameResourceID, slot.ResourceID)
		seen := map[string]bool{}
		for _, id := range ids {
			if id != "" && wanted[id] && !seen[id] {
				seen[id] = true
				references = append(references, ResourceDirectReference{Kind: DramaResourceReferenceKind, ID: slot.ID, Title: "镜头媒体与首尾帧", ResourceID: id})
			}
		}
	}
	return references, nil
}
