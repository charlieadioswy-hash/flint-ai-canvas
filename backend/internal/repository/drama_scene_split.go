package repository

import (
	"encoding/json"
	"time"

	"gorm.io/gorm"
	"yingce/backend/internal/model"
)

func (r *Repository) DramaSceneSplitTakes(projectID, episodeID string) ([]model.DramaTake, error) {
	var rows []model.DramaTake
	err := r.db.Model(&model.DramaTake{}).Joins("JOIN tasks ON tasks.id = drama_takes.task_id").Where("drama_takes.project_id = ? AND drama_takes.kind = ? AND tasks.project_id = ?", projectID, "scene_split", projectID).Order("drama_takes.created_at DESC").Find(&rows).Error
	if err != nil {
		return nil, err
	}
	result := []model.DramaTake{}
	for _, row := range rows {
		var task model.Task
		if err := r.db.First(&task, "id = ?", row.TaskID).Error; err != nil {
			return nil, err
		}
		var input struct {
			Metadata struct {
				EpisodeID string `json:"episodeId"`
			} `json:"metadata"`
		}
		if err := json.Unmarshal([]byte(task.InputJSON), &input); err != nil {
			return nil, err
		}
		if input.Metadata.EpisodeID == episodeID {
			result = append(result, row)
		}
	}
	return result, nil
}

func (r *Repository) DramaSceneRevision(projectID, taskID string) (*model.DramaSceneRevision, error) {
	var row model.DramaSceneRevision
	err := r.db.First(&row, "project_id = ? AND task_id = ?", projectID, taskID).Error
	return &row, err
}

func (r *Repository) DramaSceneSplitActive(projectID, episodeID string) (bool, error) {
	jobs, err := r.DramaJobsByStatus(projectID, model.DramaJobQueued, model.DramaJobRunning)
	if err != nil {
		return false, err
	}
	for _, job := range jobs {
		if job.EpisodeID == episodeID || job.Kind == model.DramaJobBible || job.Kind == model.DramaJobPlan {
			return true, nil
		}
	}
	// Standalone shot, board and asset tasks do not all have a DramaJob. Block
	// active project tasks as well so an in-flight paid result cannot be adopted
	// against an owner that this explicit operation is replacing.
	var count int64
	err = r.db.Model(&model.Task{}).Where("project_id = ? AND status NOT IN ?", projectID, []model.TaskStatus{model.TaskStatusSucceeded, model.TaskStatusFailed, model.TaskStatusCancelled}).Count(&count).Error
	return count > 0, err
}

func (r *Repository) ReplaceDramaScene(episode model.DramaEpisode, before []model.DramaShot, after []model.DramaShot, segments []model.DramaSegment, snapshot model.DramaSceneRevision) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		ids := []string{}
		for _, shot := range before {
			ids = append(ids, shot.ID)
		}
		var media []model.DramaShotMedia
		if err := tx.Where("project_id = ? AND shot_id IN ?", episode.ProjectID, ids).Find(&media).Error; err != nil {
			return err
		}
		encode := func(v any) string { raw, _ := json.Marshal(v); return string(raw) }
		snapshot.ShotsJSON, snapshot.SegmentsJSON, snapshot.MediaJSON = encode(before), encode(segments), encode(media)
		owners := append([]string{}, ids...)
		for _, segment := range segments {
			owners = append(owners, segment.ID)
		}
		var takes []model.DramaTake
		if err := tx.Where("project_id = ? AND owner_id IN ? AND kind IN ?", episode.ProjectID, owners, []string{"shot_image", "shot_video", "shot_audio", "video"}).Order("created_at DESC").Find(&takes).Error; err != nil {
			return err
		}
		snapshot.TakesJSON = encode(takes)
		newIDs := []string{}
		for _, shot := range after {
			newIDs = append(newIDs, shot.ID)
		}
		snapshot.NewShotIDsJSON = encode(newIDs)
		if err := tx.Create(&snapshot).Error; err != nil {
			return err
		}
		// Preserve selected and paid history; only invalidate the current slots.
		if err := tx.Model(&model.DramaShotMedia{}).Where("project_id = ? AND shot_id IN ?", episode.ProjectID, ids).Updates(map[string]any{"status": model.DramaMediaStale, "revision": gorm.Expr("revision + 1"), "pending_take_id": "", "task_id": "", "updated_at": time.Now()}).Error; err != nil {
			return err
		}
		if err := tx.Where("project_id = ? AND id IN ?", episode.ProjectID, ids).Delete(&model.DramaShot{}).Error; err != nil {
			return err
		}
		delta := len(after) - len(before)
		if delta != 0 {
			if err := tx.Model(&model.DramaShot{}).Where("episode_id = ? AND position > ?", episode.ID, before[len(before)-1].Position).UpdateColumn("position", gorm.Expr("position + ?", delta)).Error; err != nil {
				return err
			}
		}
		if err := tx.Create(&after).Error; err != nil {
			return err
		}
		for _, segment := range segments {
			fields := map[string]any{"prompt_status": model.DramaMediaStale, "video_prompt_override": "", "revision": gorm.Expr("revision + 1"), "updated_at": time.Now()}
			if segment.VideoStatus != "" {
				fields["video_status"] = model.DramaMediaStale
			}
			if err := tx.Model(&model.DramaSegment{}).Where("id = ?", segment.ID).Updates(fields).Error; err != nil {
				return err
			}
		}
		result := tx.Model(&model.DramaEpisode{}).Where("id = ? AND revision = ?", episode.ID, episode.Revision).Updates(map[string]any{"revision": episode.Revision + 1, "shot_count": tx.Model(&model.DramaShot{}).Select("COUNT(*)").Where("episode_id = ?", episode.ID), "duration_ms": tx.Model(&model.DramaShot{}).Select("COALESCE(SUM(duration_ms),0)").Where("episode_id = ?", episode.ID), "approved": false, "final_stale": true, "stage": model.DramaEpisodePrompts, "updated_at": time.Now()})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return ErrDramaGuideChanged
		}
		return nil
	})
}
