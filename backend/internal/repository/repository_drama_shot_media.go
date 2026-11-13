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
	if err := r.db.Where("project_id = ? AND task_id = ? AND kind IN ?", projectID, taskID, []string{"shot_image", "shot_video"}).First(&take).Error; err != nil {
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
		if !activate {
			return nil
		}
		return tx.Model(&model.DramaShotMedia{}).
			Where("id = ? AND revision = ? AND task_id = ? AND pending_take_id = ?", row.ID, revision, take.TaskID, take.ID).
			Where("EXISTS (SELECT 1 FROM drama_shots WHERE drama_shots.id = ? AND drama_shots.project_id = ? AND drama_shots.updated_at = ?)", row.ShotID, row.ProjectID, scriptUpdatedAt).
			Updates(map[string]any{"resource_id": take.ResourceID, "current_take_id": take.ID, "pending_take_id": "", "status": "ready", "updated_at": time.Now()}).Error
	})
}

func (r *Repository) AdoptDramaShotMediaTake(row *model.DramaShotMedia, take *model.DramaTake, expected int64) error {
	result := r.db.Model(&model.DramaShotMedia{}).Where("id = ? AND project_id = ? AND revision = ?", row.ID, row.ProjectID, expected).
		Updates(map[string]any{"revision": expected + 1, "current_take_id": take.ID, "pending_take_id": "", "resource_id": take.ResourceID, "task_id": "", "status": "ready", "script_hash": row.ScriptHash, "updated_at": time.Now()})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrDramaShotMediaChanged
	}
	return nil
}

func (r *Repository) DeleteDramaShotMediaForProject(projectID string) error {
	return r.db.Where("project_id = ?", projectID).Delete(&model.DramaShotMedia{}).Error
}
