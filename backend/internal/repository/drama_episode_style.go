package repository

import (
	"time"

	"yingce/backend/internal/model"
)

// 配置只推进制作控制版本；保留集内容版本，避免让已有媒体或异步结果失效。
func (r *Repository) UpdateDramaEpisodeSettings(projectID, episodeID string, revision int64, settingsJSON string) error {
	result := r.db.Model(&model.DramaEpisode{}).Where("project_id = ? AND id = ? AND revision = ?", projectID, episodeID, revision).
		Updates(map[string]any{"settings_json": settingsJSON, "updated_at": time.Now()})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrDramaGuideChanged
	}
	return nil
}

func (r *Repository) DramaEpisodeSettingsBusy(projectID, episodeID string) (bool, error) {
	statuses := []string{model.DramaMediaQueued, model.DramaMediaRunning}
	for _, row := range []any{&model.DramaJob{}, &model.DramaShotMedia{}, &model.DramaStoryboardBoard{}} {
		var count int64
		if err := r.db.Model(row).Where("project_id = ? AND episode_id = ? AND status IN ?", projectID, episodeID, statuses).Count(&count).Error; err != nil {
			return false, err
		}
		if count > 0 {
			return true, nil
		}
	}
	for _, item := range []struct {
		row   any
		where string
	}{{&model.DramaSegment{}, "episode_id = ? AND video_status IN ?"}, {&model.DramaCast{}, "image_episode_id = ? AND image_status IN ?"}} {
		var count int64
		if err := r.db.Model(item.row).Where("project_id = ?", projectID).Where(item.where, episodeID, statuses).Count(&count).Error; err != nil {
			return false, err
		}
		if count > 0 {
			return true, nil
		}
	}
	return false, nil
}

func (r *Repository) DramaHasProductionContent(projectID string) (bool, error) {
	for _, row := range []any{&model.DramaJob{}, &model.DramaCast{}, &model.DramaShot{}, &model.DramaSegment{}} {
		var count int64
		if err := r.db.Model(row).Where("project_id = ?", projectID).Count(&count).Error; err != nil {
			return false, err
		}
		if count > 0 {
			return true, nil
		}
	}
	var count int64
	err := r.db.Model(&model.DramaEpisode{}).Where("project_id = ? AND (stage <> ? OR final_resource_id <> '' OR synopsis <> '' OR hook <> '' OR cliffhanger <> '')", projectID, model.DramaEpisodeQueued).Count(&count).Error
	return count > 0, err
}
