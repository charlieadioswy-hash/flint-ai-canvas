package repository

import (
	"encoding/json"

	"yingce/backend/internal/model"
)

// MergeDramaEpisodeAssets 在持有作品行锁的事务内合并本集主体，不修改剧本版本；已删除的集不回建。
func (r *Repository) MergeDramaEpisodeAssets(projectID string, episodeIDs, assetIDs []string) error {
	if len(episodeIDs) == 0 || len(assetIDs) == 0 {
		return nil
	}
	var episodes []model.DramaEpisode
	if err := r.db.Select("id", "asset_ids_json").Where("project_id = ? AND id IN ?", projectID, episodeIDs).Find(&episodes).Error; err != nil {
		return err
	}
	for _, episode := range episodes {
		ids := decodeDramaIDs(episode.AssetIDsJSON)
		seen := make(map[string]bool, len(ids)+len(assetIDs))
		merged := make([]string, 0, len(ids)+len(assetIDs))
		for _, id := range append(ids, assetIDs...) {
			if id != "" && !seen[id] {
				seen[id] = true
				merged = append(merged, id)
			}
		}
		encoded, err := json.Marshal(merged)
		if err != nil {
			return err
		}
		if err := r.db.Model(&model.DramaEpisode{}).Where("project_id = ? AND id = ?", projectID, episode.ID).UpdateColumn("asset_ids_json", string(encoded)).Error; err != nil {
			return err
		}
	}
	return nil
}
