package repository

import (
	"time"
	"yingce/backend/internal/model"
)

// Prepared upload URLs are committed before generation submission and fenced by
// the same task lease as execution, so retries can reuse uploads safely.
func (r *Repository) SaveTaskProviderPreparation(task *model.Task, inputJSON string) error {
	result := taskLeaseWriter(r.db.Model(&model.Task{}), task.LeaseOwner).
		Where("id = ? AND user_id = ? AND status = ? AND route_run = ?", task.ID, task.UserID, model.TaskStatusRunning, task.RouteRun).
		Updates(map[string]any{"input_json": inputJSON, "updated_at": time.Now()})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrTaskStateConflict
	}
	task.InputJSON = inputJSON
	return nil
}
