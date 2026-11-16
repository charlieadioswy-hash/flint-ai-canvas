package repository

import (
	"time"

	"yingce/backend/internal/model"
)

// 风格只推进制作控制版本；保留集内容版本，避免让已有媒体或异步结果失效。
func (r *Repository) UpdateDramaEpisodeStyle(projectID, episodeID string, revision int64, mode, name, prompt string) error {
	result := r.db.Model(&model.DramaEpisode{}).Where("project_id = ? AND id = ? AND revision = ?", projectID, episodeID, revision).
		Updates(map[string]any{"style_mode": mode, "style_name": name, "style_prompt": prompt, "updated_at": time.Now()})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrDramaGuideChanged
	}
	return nil
}
