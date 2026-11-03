package repository

import (
	"errors"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"yingce/backend/internal/model"
)

const Model3DExportCancelledHash = "cancelled-before-admission"

// Only a live task lease may publish the reusable output checkpoint. Each
// worker uploads to its own resource so a reclaimed task never overwrites an
// object that the previous worker may still be writing.
func (r *Repository) PublishModel3DExportOutput(task *model.Task, output *model.Resource, uploadKey string) (*model.Resource, error) {
	var published *model.Resource
	err := r.Transaction(func(repo *Repository) error {
		locked := taskLeaseWriter(repo.db.Model(&model.Task{}), task.LeaseOwner).
			Where("id = ? AND user_id = ? AND type = ? AND status = ?", task.ID, task.UserID, model.TaskTypeModel3DExport, model.TaskStatusRunning).
			UpdateColumn("updated_at", time.Now())
		if locked.Error != nil {
			return locked.Error
		}
		if locked.RowsAffected != 1 {
			return ErrTaskStateConflict
		}
		var checkpoint model.Resource
		err := repo.db.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("user_id = ? AND upload_key = ?", task.UserID, uploadKey).First(&checkpoint).Error
		if err == nil {
			if checkpoint.Status == model.ResourceStatusReady {
				published = &checkpoint
				return nil
			}
			// Keep the old row and object for normal orphan cleanup. Reusing its
			// object key would race a previous worker's unfinished upload.
			if err := repo.db.Model(&checkpoint).UpdateColumn("upload_key", nil).Error; err != nil {
				return err
			}
		} else if !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		var stored model.Resource
		if err := repo.db.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("id = ? AND user_id = ? AND status = ? AND upload_key = ?", output.ID, task.UserID, model.ResourceStatusReady, output.UploadKey).
			First(&stored).Error; err != nil {
			return err
		}
		if err := repo.db.Model(&stored).UpdateColumn("upload_key", uploadKey).Error; err != nil {
			return err
		}
		stored.UploadKey = &uploadKey
		published = &stored
		return nil
	})
	return published, err
}

func (r *Repository) CreateModel3DExportTerminalTask(task *model.Task) error {
	if task.Type != model.TaskTypeModel3DExport || (task.Status != model.TaskStatusSucceeded && task.Status != model.TaskStatusCancelled) {
		return ErrTaskStateConflict
	}
	return r.db.Create(task).Error
}

// Export admission shares the resource deletion lock, but requires no provider
// configuration or paid submission record.
func (r *Repository) AdmitModel3DExport(task *model.Task, request *model.Model3DRequest, resourceID, version string, create func(*Repository) error) (*model.Task, error) {
	var admitted *model.Task
	err := r.Transaction(func(repo *Repository) error {
		if _, err := lockModel3DPolicy(repo.db); err != nil {
			return err
		}
		existing, err := repo.Model3DRequestForUser(request.UserID, request.RequestID)
		if err == nil {
			if existing.RequestHash != request.RequestHash && existing.RequestHash != Model3DExportCancelledHash {
				return ErrModel3DConflict
			}
			admitted, err = repo.TaskForUser(request.UserID, existing.TaskID)
			if err == nil && admitted.Type != model.TaskTypeModel3DExport {
				return ErrModel3DConflict
			}
			return err
		}
		if !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		var source model.Resource
		if err := repo.db.Clauses(clause.Locking{Strength: "UPDATE"}).First(&source, "id = ? AND user_id = ? AND status = ?", resourceID, task.UserID, model.ResourceStatusReady).Error; err != nil {
			return err
		}
		if model.ImageModerationResourceVersion(&source) != version {
			return ErrModel3DConflict
		}
		if err := create(repo); err != nil {
			return err
		}
		if err := repo.db.Create(request).Error; err != nil {
			return err
		}
		admitted = task
		return nil
	})
	return admitted, err
}

func cancelModel3DExport(repo *Repository, task *model.Task) error {
	if task.Type != model.TaskTypeModel3DExport {
		return gorm.ErrRecordNotFound
	}
	if task.Status != model.TaskStatusQueued && task.Status != model.TaskStatusRunning {
		return nil
	}
	now := time.Now()
	return repo.db.Model(task).Where("status IN ?", []model.TaskStatus{model.TaskStatusQueued, model.TaskStatusRunning}).Updates(map[string]any{
		"status": model.TaskStatusCancelled, "stage": "导出已取消", "error": "导出已取消", "completed_at": now,
		"cancellation_source": model.TaskCancellationUserRequest, "cancellation_actor_id": task.UserID, "cancellation_requested_at": now,
		"lease_owner": "", "lease_expires_at": nil, "next_poll_at": nil,
	}).Error
}

func (r *Repository) CancelModel3DExport(userID, id string) (*model.Task, error) {
	var task *model.Task
	err := r.Transaction(func(repo *Repository) error {
		if _, err := lockModel3DPolicy(repo.db); err != nil {
			return err
		}
		var err error
		task, err = repo.TaskForUser(userID, id)
		if err != nil {
			return err
		}
		if err := cancelModel3DExport(repo, task); err != nil {
			return err
		}
		task, err = repo.TaskForUser(userID, id)
		return err
	})
	return task, err
}

// A cancelled request is persisted even when its upload/POST is still in flight.
// A late admission then returns this terminal task without starting Blender.
func (r *Repository) CancelModel3DExportByRequest(request *model.Model3DRequest, tombstone *model.Task, create func(*Repository) error) (*model.Task, error) {
	var task *model.Task
	err := r.Transaction(func(repo *Repository) error {
		if _, err := lockModel3DPolicy(repo.db); err != nil {
			return err
		}
		existing, err := repo.Model3DRequestForUser(request.UserID, request.RequestID)
		if errors.Is(err, gorm.ErrRecordNotFound) {
			if err := create(repo); err != nil {
				return err
			}
			if err := repo.db.Create(request).Error; err != nil {
				return err
			}
			task = tombstone
			return nil
		}
		if err != nil {
			return err
		}
		task, err = repo.TaskForUser(request.UserID, existing.TaskID)
		if err != nil {
			return err
		}
		if err := cancelModel3DExport(repo, task); err != nil {
			return err
		}
		task, err = repo.TaskForUser(request.UserID, existing.TaskID)
		return err
	})
	return task, err
}
