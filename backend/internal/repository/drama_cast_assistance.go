package repository

import (
	"yingce/backend/internal/model"
)

// Assistance results must originate from a durable cast-owned take, not client metadata.
func (r *Repository) DramaCastAssistanceTake(projectID, castID, takeID string) (*model.DramaTake, error) {
	var take model.DramaTake
	err := r.db.Where("id = ? AND project_id = ? AND owner_id = ? AND kind IN ?", takeID, projectID, castID, []string{"cast_voice", "cast_desc", "cast_prompt"}).First(&take).Error
	return &take, err
}

func (r *Repository) ActiveDramaCastAssistance(projectID, castID, kind string) (bool, error) {
	var count int64
	err := r.db.Model(&model.DramaTake{}).
		Joins("JOIN tasks ON tasks.id = drama_takes.task_id AND tasks.project_id = drama_takes.project_id").
		Where("drama_takes.project_id = ? AND drama_takes.owner_id = ? AND drama_takes.kind = ? AND tasks.status NOT IN ?", projectID, castID, kind, []model.TaskStatus{model.TaskStatusSucceeded, model.TaskStatusFailed, model.TaskStatusCancelled}).Count(&count).Error
	return count > 0, err
}

func (r *Repository) BindDramaCastAssistanceResource(projectID, castID, taskID, resourceID string) error {
	result := r.db.Model(&model.DramaTake{}).
		Where("project_id = ? AND owner_id = ? AND task_id = ? AND kind = ? AND (resource_id = '' OR resource_id = ?)", projectID, castID, taskID, "cast_voice", resourceID).
		Update("resource_id", resourceID)
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrDramaGuideChanged
	}
	return nil
}
