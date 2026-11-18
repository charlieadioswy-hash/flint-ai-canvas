package repository

import (
	"errors"
	"time"

	"gorm.io/gorm"
	"yingce/backend/internal/model"
)

var ErrDramaShotMediaChanged = errors.New("镜头媒体已改变，请刷新后重试")

func (r *Repository) DramaShotMedia(projectID, shotID, kind string) (*model.DramaShotMedia, error) {
	var row model.DramaShotMedia
	if err := r.db.Where("project_id = ? AND shot_id = ? AND kind = ?", projectID, shotID, kind).First(&row).Error; err != nil {
		return nil, err
	}
	return &row, nil
}

func (r *Repository) DramaEpisodeShotMedia(projectID, episodeID, kind string) ([]model.DramaShotMedia, error) {
	var rows []model.DramaShotMedia
	err := r.db.Where("project_id = ? AND episode_id = ? AND kind = ?", projectID, episodeID, kind).Find(&rows).Error
	return rows, err
}

type DramaSegmentShotMediaRow struct {
	ShotID       string
	Kind         string
	ResourceID   string
	TaskStatus   model.TaskStatus
	RepairTaskID string
}

func (r *Repository) DramaSegmentShotMediaRows(userID, projectID, episodeID string, segmentIndex int) ([]DramaSegmentShotMediaRow, error) {
	var rows []DramaSegmentShotMediaRow
	err := r.db.Table("drama_shots AS shot").
		Select(`shot.id AS shot_id, COALESCE(media.kind, '') AS kind,
			COALESCE(media.resource_id, '') AS resource_id, COALESCE(task.status, '') AS task_status,
			CASE WHEN task.status = ? AND take.resource_id = '' THEN task.id ELSE '' END AS repair_task_id`, model.TaskStatusSucceeded).
		Joins(`LEFT JOIN drama_shot_media AS media ON media.project_id = shot.project_id AND media.episode_id = shot.episode_id
			AND media.shot_id = shot.id AND media.kind IN ?`, []string{"image", "video"}).
		Joins(`LEFT JOIN tasks AS task ON task.id = media.task_id AND task.project_id = shot.project_id AND task.user_id = ?`, userID).
		Joins(`LEFT JOIN drama_takes AS take ON take.id = media.pending_take_id AND take.task_id = task.id
			AND take.project_id = shot.project_id AND take.owner_id = shot.id AND take.kind = ('shot_' || media.kind)`).
		Where("shot.project_id = ? AND shot.episode_id = ? AND shot.segment_index = ?", projectID, episodeID, segmentIndex).
		Order("shot.position, shot.id").Scan(&rows).Error
	return rows, err
}

func (r *Repository) SaveDramaShotMediaConfig(row *model.DramaShotMedia, expected int64) error {
	if expected == 0 {
		return r.db.Create(row).Error
	}
	result := r.db.Model(&model.DramaShotMedia{}).Where("id = ? AND project_id = ? AND revision = ?", row.ID, row.ProjectID, expected).
		Updates(map[string]any{"config_json": row.ConfigJSON, "revision": row.Revision, "task_id": "", "pending_take_id": "", "status": row.Status, "script_hash": row.ScriptHash, "updated_at": row.UpdatedAt})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrDramaShotMediaChanged
	}
	return nil
}

// Called in the same transaction as task admission and credit reservation.
func (r *Repository) BindDramaShotMediaTask(row *model.DramaShotMedia, take *model.DramaTake, expected int64) error {
	if err := r.CreateDramaTake(take); err != nil {
		return err
	}
	result := r.db.Model(&model.DramaShotMedia{}).Where("id = ? AND project_id = ? AND revision = ?", row.ID, row.ProjectID, expected).
		Updates(map[string]any{"revision": expected + 1, "pending_take_id": take.ID, "task_id": take.TaskID, "status": "queued", "script_hash": row.ScriptHash, "updated_at": row.UpdatedAt})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrDramaShotMediaChanged
	}
	return nil
}

func (r *Repository) DramaShotMediaTake(projectID, shotID, kind, takeID string) (*model.DramaTake, error) {
	var take model.DramaTake
	if err := r.db.Where("id = ? AND project_id = ? AND owner_id = ? AND kind = ?", takeID, projectID, shotID, "shot_"+kind).First(&take).Error; err != nil {
		return nil, err
	}
	return &take, nil
}

func (r *Repository) DramaShotMediaTakeForTask(projectID, taskID string) (*model.DramaTake, error) {
	var take model.DramaTake
	if err := r.db.Where("project_id = ? AND task_id = ? AND kind IN ?", projectID, taskID, []string{"shot_image", "shot_video", "shot_audio"}).First(&take).Error; err != nil {
		return nil, err
	}
	return &take, nil
}

// Always preserve the paid result; only the matching current request may select
// it. An adopted take or an edited script must never be replaced by a late task.
func (r *Repository) CompleteDramaShotMediaTask(take *model.DramaTake, row *model.DramaShotMedia, revision int64, scriptUpdatedAt time.Time, activate bool) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		stored := tx.Model(&model.DramaTake{}).Where("id = ? AND task_id = ? AND (resource_id = '' OR resource_id = ?)", take.ID, take.TaskID, take.ResourceID).
			Updates(map[string]any{"resource_id": take.ResourceID, "duration_ms": take.DurationMs})
		if stored.Error != nil {
			return stored.Error
		}
		if stored.RowsAffected != 1 {
			return ErrDramaShotMediaChanged
		}
		if take.Kind == "shot_audio" {
			// Audio always waits for an explicit audition/adoption. The queued slot
			// still leaves its pending state when the paid result is preserved.
			return tx.Model(&model.DramaShotMedia{}).
				Where("id = ? AND revision = ? AND task_id = ? AND pending_take_id = ?", row.ID, revision, take.TaskID, take.ID).
				Updates(map[string]any{"pending_take_id": "", "status": "awaiting_adoption", "updated_at": time.Now()}).Error
		}
		if !activate {
			return nil
		}
		selected := tx.Model(&model.DramaShotMedia{}).
			Where("id = ? AND revision = ? AND task_id = ? AND pending_take_id = ?", row.ID, revision, take.TaskID, take.ID).
			Where("EXISTS (SELECT 1 FROM drama_shots WHERE drama_shots.id = ? AND drama_shots.project_id = ? AND drama_shots.updated_at = ?)", row.ShotID, row.ProjectID, scriptUpdatedAt).
			Updates(map[string]any{"resource_id": take.ResourceID, "current_take_id": take.ID, "pending_take_id": "", "status": "ready", "updated_at": time.Now()})
		if selected.Error != nil {
			return selected.Error
		}
		if selected.RowsAffected == 1 && row.Kind == "video" && (row.ResourceID != take.ResourceID || row.CurrentTakeID != take.ID) {
			return markDramaShotVideoChanged(tx, row)
		}
		return nil
	})
}

func (r *Repository) AdoptDramaShotMediaTake(row *model.DramaShotMedia, take *model.DramaTake, expected int64) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		result := tx.Model(&model.DramaShotMedia{}).Where("id = ? AND project_id = ? AND revision = ?", row.ID, row.ProjectID, expected).
			Updates(map[string]any{"revision": expected + 1, "current_take_id": take.ID, "pending_take_id": "", "resource_id": take.ResourceID, "task_id": "", "status": "ready", "script_hash": row.ScriptHash, "updated_at": time.Now()})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return ErrDramaShotMediaChanged
		}
		if row.Kind == "video" && (row.ResourceID != take.ResourceID || row.CurrentTakeID != take.ID) {
			return markDramaShotVideoChanged(tx, row)
		}
		return nil
	})
}

func markDramaShotVideoChanged(tx *gorm.DB, row *model.DramaShotMedia) error {
	return tx.Model(&model.DramaEpisode{}).Where("id = ? AND project_id = ?", row.EpisodeID, row.ProjectID).
		Updates(map[string]any{"revision": gorm.Expr("revision + 1"), "final_stale": gorm.Expr("final_resource_id <> ''"), "stage": model.DramaEpisodeReview, "video_requests_only": true, "error": "", "updated_at": time.Now()}).Error
}

func (r *Repository) DeleteDramaShotMediaForProject(projectID string) error {
	return r.db.Where("project_id = ?", projectID).Delete(&model.DramaShotMedia{}).Error
}
