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
	return r.dramaSettingsBusy(projectID, episodeID)
}

func (r *Repository) DramaGenerationSettingsBusy(projectID string) (bool, error) {
	return r.dramaSettingsBusy(projectID, "")
}

func (r *Repository) dramaSettingsBusy(projectID, episodeID string) (bool, error) {
	statuses := []string{model.DramaMediaQueued, model.DramaMediaRunning}
	rows := []any{&model.DramaJob{}, &model.DramaShotMedia{}, &model.DramaStoryboardBoard{}}
	if episodeID == "" {
		rows = append(rows, &model.DramaCastView{})
	}
	for _, row := range rows {
		var count int64
		query := r.db.Model(row).Where("project_id = ? AND status IN ?", projectID, statuses)
		if _, shotMedia := row.(*model.DramaShotMedia); shotMedia {
			// 失败和取消不走产物登记；历史槽位可能仍是 queued，以当前绑定任务的终态解除配置限制。
			finished := r.db.Model(&model.Task{}).Select("id").Where("project_id = ? AND status IN ?", projectID, []model.TaskStatus{model.TaskStatusFailed, model.TaskStatusCancelled})
			query = query.Where("task_id NOT IN (?)", finished)
		}
		if episodeID != "" {
			query = query.Where("episode_id = ?", episodeID)
		}
		if err := query.Count(&count).Error; err != nil {
			return false, err
		}
		if count > 0 {
			return true, nil
		}
	}
	for _, item := range []struct {
		row          any
		field        string
		episodeField string
	}{{&model.DramaSegment{}, "video_status", "episode_id"}, {&model.DramaCast{}, "image_status", "image_episode_id"}} {
		var count int64
		query := r.db.Model(item.row).Where("project_id = ?", projectID).Where(item.field+" IN ?", statuses)
		if episodeID != "" {
			query = query.Where(item.episodeField+" = ?", episodeID)
		}
		if err := query.Count(&count).Error; err != nil {
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
