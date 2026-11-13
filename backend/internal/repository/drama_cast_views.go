package repository

import (
	"encoding/json"
	"errors"
	"slices"
	"time"

	"yingce/backend/internal/model"
)

var ErrDramaCastViewChanged = errors.New("资产视图已变化，请刷新后重试")

func (r *Repository) DramaCastViews(projectID, castID string) ([]model.DramaCastView, error) {
	var rows []model.DramaCastView
	err := r.db.Where("project_id = ? AND cast_id = ?", projectID, castID).Order("created_at, id").Find(&rows).Error
	return rows, err
}

func (r *Repository) DramaCastView(projectID, castID, viewID string) (*model.DramaCastView, error) {
	var row model.DramaCastView
	if err := r.db.Where("project_id = ? AND cast_id = ? AND id = ?", projectID, castID, viewID).First(&row).Error; err != nil {
		return nil, err
	}
	return &row, nil
}

func (r *Repository) SaveDramaCastView(row *model.DramaCastView, expected int64) error {
	if expected == 0 {
		return r.db.Create(row).Error
	}
	result := r.db.Model(&model.DramaCastView{}).Where("id = ? AND project_id = ? AND cast_id = ? AND revision = ?", row.ID, row.ProjectID, row.CastID, expected).
		Updates(map[string]any{"revision": expected + 1, "config_json": row.ConfigJSON, "task_id": "", "pending_take_id": "", "status": row.Status, "updated_at": time.Now()})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrDramaCastViewChanged
	}
	return nil
}

func (r *Repository) BindDramaCastViewTask(row *model.DramaCastView, take *model.DramaTake) error {
	if err := r.CreateDramaTake(take); err != nil {
		return err
	}
	result := r.db.Model(&model.DramaCastView{}).Where("id = ? AND revision = ?", row.ID, row.Revision).
		Updates(map[string]any{"revision": row.Revision + 1, "pending_take_id": take.ID, "task_id": take.TaskID, "source_hash": row.SourceHash, "status": "queued", "updated_at": time.Now()})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrDramaCastViewChanged
	}
	return nil
}

func (r *Repository) DramaCastViewTake(projectID, viewID, takeID string) (*model.DramaTake, error) {
	var take model.DramaTake
	if err := r.db.Where("project_id = ? AND owner_id = ? AND id = ? AND kind = ?", projectID, viewID, takeID, "cast_view").First(&take).Error; err != nil {
		return nil, err
	}
	return &take, nil
}

func (r *Repository) DramaCastViewTakeForTask(projectID, taskID string) (*model.DramaTake, error) {
	var take model.DramaTake
	if err := r.db.Where("project_id = ? AND task_id = ? AND kind = ?", projectID, taskID, "cast_view").First(&take).Error; err != nil {
		return nil, err
	}
	return &take, nil
}

func (r *Repository) CompleteDramaCastViewTask(take *model.DramaTake, row *model.DramaCastView, revision int64, activate bool) error {
	result := r.db.Model(&model.DramaTake{}).Where("id = ? AND task_id = ? AND (resource_id = '' OR resource_id = ?)", take.ID, take.TaskID, take.ResourceID).Update("resource_id", take.ResourceID)
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrDramaCastViewChanged
	}
	if !activate {
		return nil
	}
	return r.db.Model(&model.DramaCastView{}).Where("id = ? AND revision = ? AND task_id = ? AND pending_take_id = ?", row.ID, revision, take.TaskID, take.ID).
		Updates(map[string]any{"resource_id": take.ResourceID, "current_take_id": take.ID, "pending_take_id": "", "status": "ready", "updated_at": time.Now()}).Error
}

func (r *Repository) AdoptDramaCastViewTake(row *model.DramaCastView, take *model.DramaTake, expected int64) error {
	result := r.db.Model(&model.DramaCastView{}).Where("id = ? AND revision = ?", row.ID, expected).
		Updates(map[string]any{"revision": expected + 1, "resource_id": take.ResourceID, "current_take_id": take.ID, "pending_take_id": "", "task_id": "", "status": "ready", "source_hash": row.SourceHash, "updated_at": time.Now()})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrDramaCastViewChanged
	}
	return nil
}

func (r *Repository) DramaCastViewResourceReferences(userID string, ids []string) ([]ResourceDirectReference, error) {
	var rows []model.DramaCastView
	projects := r.db.Model(&model.DramaProduction{}).Select("project_id").Where("user_id = ?", userID)
	if err := r.db.Where("project_id IN (?)", projects).Find(&rows).Error; err != nil {
		return nil, err
	}
	refs := []ResourceDirectReference{}
	for _, row := range rows {
		for _, id := range ids {
			if row.ResourceID == id || dramaCastViewConfigReferences(row.ConfigJSON, id) {
				refs = append(refs, ResourceDirectReference{Kind: DramaResourceReferenceKind, ID: row.ID, Title: "资产多视图", ResourceID: id})
			}
		}
	}
	return refs, nil
}

func (r *Repository) DeleteDramaCastViews(projectID string) error {
	return r.db.Where("project_id = ?", projectID).Delete(&model.DramaCastView{}).Error
}

// 事务内供删除资产保护；已生成视图保持对原主体的归属，需显式处理。
func (r *Repository) RequireNoDramaCastViews(projectID, castID string) error {
	var count int64
	if err := r.db.Model(&model.DramaCastView{}).Where("project_id = ? AND cast_id = ?", projectID, castID).Count(&count).Error; err != nil {
		return err
	}
	if count > 0 {
		return ErrDramaCastViewChanged
	}
	return nil
}

func dramaCastViewConfigReferences(raw, id string) bool {
	var config struct {
		ImageOptions struct {
			Subject []string `json:"subjectReferenceIds"`
			Style   []string `json:"styleReferenceIds"`
		} `json:"imageOptions"`
	}
	if json.Unmarshal([]byte(raw), &config) != nil {
		return true
	}
	return slices.Contains(config.ImageOptions.Subject, id) || slices.Contains(config.ImageOptions.Style, id)
}

func (r *Repository) DeleteDramaCastView(row *model.DramaCastView, expected int64) error {
	result := r.db.Where("id = ? AND project_id = ? AND cast_id = ? AND revision = ?", row.ID, row.ProjectID, row.CastID, expected).Delete(&model.DramaCastView{})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrDramaCastViewChanged
	}
	return nil
}
