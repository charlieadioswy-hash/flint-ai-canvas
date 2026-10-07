package repository

import (
	"errors"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"infinite-canvas/backend/internal/assets"
	"infinite-canvas/backend/internal/model"
)

const model3DPolicyID = "model3d"

var ErrModel3DConflict = errors.New("3D 配置或请求已变化")
var ErrModel3DUnavailable = errors.New("3D 生成服务未配置")
var ErrModel3DBudget = errors.New("今日 3D 生成任务额度已用完")
var ErrModel3DReferenced = errors.New("3D 生成任务正在使用资源")

func lockModel3DPolicy(tx *gorm.DB) (*model.Model3DPolicy, error) {
	policy := model.Model3DPolicy{ID: model3DPolicyID}
	if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&policy).Error; err != nil {
		return nil, err
	}
	if err := tx.Model(&model.Model3DPolicy{}).Where("id = ?", model3DPolicyID).UpdateColumn("revision", gorm.Expr("revision")).Error; err != nil {
		return nil, err
	}
	if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&policy, "id = ?", model3DPolicyID).Error; err != nil {
		return nil, err
	}
	return &policy, nil
}

func (r *Repository) Model3DState() ([]model.Model3DProvider, []model.Model3DConfig, model.Model3DPolicy, error) {
	providers := []model.Model3DProvider{}
	configs := []model.Model3DConfig{}
	policy := model.Model3DPolicy{}
	if err := r.db.Order("created_at asc").Find(&providers).Error; err != nil {
		return nil, nil, policy, err
	}
	if err := r.db.Order("version asc").Find(&configs).Error; err != nil {
		return nil, nil, policy, err
	}
	err := r.db.First(&policy, "id = ?", model3DPolicyID).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		err = nil
	}
	return providers, configs, policy, err
}

func (r *Repository) Model3DProvider(id string) (*model.Model3DProvider, error) {
	var value model.Model3DProvider
	err := r.db.First(&value, "id = ?", id).Error
	return &value, err
}
func (r *Repository) Model3DConfig(id string) (*model.Model3DConfig, error) {
	var value model.Model3DConfig
	err := r.db.First(&value, "id = ?", id).Error
	return &value, err
}

func (r *Repository) SaveModel3DProvider(provider *model.Model3DProvider, config *model.Model3DConfig, previous string, audit *model.AdminAuditEvent) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		policy, err := lockModel3DPolicy(tx)
		if err != nil {
			return err
		}
		if previous != "" {
			var current model.Model3DProvider
			if err := tx.First(&current, "id = ?", provider.ID).Error; err != nil {
				return err
			}
			if current.Archived || current.LatestConfigID != previous || (policy.ActiveProviderID == provider.ID && !provider.Enabled) {
				return ErrModel3DConflict
			}
		} else if err := tx.Create(provider).Error; err != nil {
			return err
		}
		if err := tx.Create(config).Error; err != nil {
			return err
		}
		if err := tx.Model(&model.Model3DProvider{}).Where("id = ?", provider.ID).Updates(map[string]any{"name": provider.Name, "enabled": provider.Enabled, "latest_config_id": config.ID, "updated_at": time.Now().UTC()}).Error; err != nil {
			return err
		}
		return tx.Create(audit).Error
	})
}

func (r *Repository) SetModel3DPolicy(providerID, configID string, expected int64, audit *model.AdminAuditEvent) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		policy, err := lockModel3DPolicy(tx)
		if err != nil {
			return err
		}
		if policy.Revision != expected {
			return ErrModel3DConflict
		}
		if providerID != "" {
			var provider model.Model3DProvider
			if err := tx.First(&provider, "id = ?", providerID).Error; err != nil {
				return err
			}
			if provider.Archived || !provider.Enabled || provider.LatestConfigID != configID {
				return ErrModel3DConflict
			}
			var count int64
			if err := tx.Model(&model.Model3DConfig{}).Where("id = ? AND provider_id = ?", configID, providerID).Count(&count).Error; err != nil {
				return err
			}
			if count != 1 {
				return ErrModel3DConflict
			}
		}
		if err := tx.Model(policy).Updates(map[string]any{"active_provider_id": providerID, "active_config_id": configID, "revision": policy.Revision + 1, "updated_at": time.Now().UTC()}).Error; err != nil {
			return err
		}
		return tx.Create(audit).Error
	})
}

func (r *Repository) ArchiveModel3DProvider(id string, audit *model.AdminAuditEvent) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		policy, err := lockModel3DPolicy(tx)
		if err != nil {
			return err
		}
		if policy.ActiveProviderID == id {
			return ErrModel3DConflict
		}
		result := tx.Model(&model.Model3DProvider{}).Where("id = ? AND archived = ?", id, false).Updates(map[string]any{"archived": true, "enabled": false, "updated_at": time.Now().UTC()})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return gorm.ErrRecordNotFound
		}
		return tx.Create(audit).Error
	})
}

func (r *Repository) ActiveModel3DConfig() (*model.Model3DConfig, int64, error) {
	var policy model.Model3DPolicy
	if err := r.db.First(&policy, "id = ?", model3DPolicyID).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, 0, ErrModel3DUnavailable
		}
		return nil, 0, err
	}
	if policy.ActiveProviderID == "" || policy.ActiveConfigID == "" {
		return nil, policy.Revision, ErrModel3DUnavailable
	}
	var config model.Model3DConfig
	err := r.db.Table("model3d_configs AS c").Select("c.*").Joins("JOIN model3d_providers AS p ON p.id = c.provider_id").Where("c.id = ? AND p.id = ? AND p.enabled = ? AND p.archived = ?", policy.ActiveConfigID, policy.ActiveProviderID, true, false).First(&config).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		err = ErrModel3DUnavailable
	}
	return &config, policy.Revision, err
}

func (r *Repository) Model3DSubmission(taskID string) (*model.Model3DSubmission, error) {
	var value model.Model3DSubmission
	err := r.db.First(&value, "task_id = ?", taskID).Error
	return &value, err
}
func (r *Repository) Model3DSubmissionForRequest(userID, requestID string) (*model.Model3DSubmission, error) {
	var value model.Model3DSubmission
	err := r.db.First(&value, "user_id = ? AND request_id = ?", userID, requestID).Error
	return &value, err
}

// Policy locking serializes admission with activation and resource deletion.
func (r *Repository) AdmitModel3D(task *model.Task, submission *model.Model3DSubmission, revision int64, inputs map[string]string, create func(*Repository) error) (*model.Task, error) {
	var admitted *model.Task
	err := r.db.Transaction(func(tx *gorm.DB) error {
		policy, err := lockModel3DPolicy(tx)
		if err != nil {
			return err
		}
		var existing model.Model3DSubmission
		err = tx.First(&existing, "user_id = ? AND request_id = ?", submission.UserID, submission.RequestID).Error
		if err == nil {
			if existing.RequestHash != submission.RequestHash {
				return ErrModel3DConflict
			}
			admitted, err = New(tx).TaskForUser(task.UserID, existing.TaskID)
			return err
		}
		if !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		if policy.Revision != revision || policy.ActiveConfigID != submission.ConfigID {
			return ErrModel3DConflict
		}
		for id, version := range inputs {
			var resource model.Resource
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&resource, "id = ? AND user_id = ? AND status = ?", id, task.UserID, model.ResourceStatusReady).Error; err != nil {
				return err
			}
			if model.ImageModerationResourceVersion(&resource) != version {
				return ErrModel3DConflict
			}
		}
		if err := create(New(tx)); err != nil {
			return err
		}
		if err := tx.Create(submission).Error; err != nil {
			return err
		}
		admitted = task
		return nil
	})
	return admitted, err
}

func requireModel3DLease(tx *gorm.DB, taskID, owner string) error {
	result := taskLeaseWriter(tx.Model(&model.Task{}), owner).Where("id = ? AND type = ? AND status = ?", taskID, model.TaskTypeCanvasModel3D, model.TaskStatusRunning).UpdateColumn("updated_at", time.Now())
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrTaskStateConflict
	}
	return nil
}

func (r *Repository) SaveModel3DTokens(taskID, owner, encrypted string) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if err := requireModel3DLease(tx, taskID, owner); err != nil {
			return err
		}
		result := tx.Model(&model.Model3DSubmission{}).Where("task_id = ? AND state IN ?", taskID, []string{"prepared", "uploading"}).Updates(map[string]any{"tokens_encrypted": encrypted, "state": "uploading", "updated_at": time.Now()})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return ErrTaskStateConflict
		}
		return nil
	})
}

func (r *Repository) BeginModel3DSubmission(taskID, owner string, dailyLimit int) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if _, err := lockModel3DPolicy(tx); err != nil {
			return err
		}
		if err := requireModel3DLease(tx, taskID, owner); err != nil {
			return err
		}
		day := time.Now().UTC().Format("2006-01-02")
		usage := model.Model3DDailyUsage{Day: day}
		if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&usage).Error; err != nil {
			return err
		}
		result := tx.Model(&usage).Where("day = ? AND tasks < ?", day, dailyLimit).Updates(map[string]any{"tasks": gorm.Expr("tasks + 1"), "updated_at": time.Now()})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return ErrModel3DBudget
		}
		result = tx.Model(&model.Model3DSubmission{}).Where("task_id = ? AND state IN ?", taskID, []string{"prepared", "uploading"}).Updates(map[string]any{"state": "inflight", "updated_at": time.Now()})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return ErrTaskStateConflict
		}
		return nil
	})
}

func (r *Repository) AcceptModel3DSubmission(taskID, owner, providerID string) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if err := requireModel3DLease(tx, taskID, owner); err != nil {
			return err
		}
		result := tx.Model(&model.Model3DSubmission{}).Where("task_id = ? AND state = ?", taskID, "inflight").Updates(map[string]any{"state": "accepted", "tokens_encrypted": "", "updated_at": time.Now()})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return ErrTaskStateConflict
		}
		return tx.Model(&model.Task{}).Where("id = ?", taskID).Updates(map[string]any{"provider_request_id": providerID, "poll_stage": "model3d_generating", "stage": "3D 模型生成中", "progress": 0}).Error
	})
}

func (r *Repository) SaveModel3DDelivery(taskID, owner, encrypted string) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if err := requireModel3DLease(tx, taskID, owner); err != nil {
			return err
		}
		return tx.Model(&model.Model3DSubmission{}).Where("task_id = ?", taskID).Updates(map[string]any{"state": "storing", "delivery_encrypted": encrypted, "error_code": "", "updated_at": time.Now()}).Error
	})
}

func (r *Repository) SaveModel3DResourceCheckpoint(taskID, owner, resultJSON string) error {
	result := taskLeaseWriter(r.db.Model(&model.Task{}), owner).Where("id = ? AND type = ? AND status = ?", taskID, model.TaskTypeCanvasModel3D, model.TaskStatusRunning).Updates(map[string]any{"result_json": resultJSON, "updated_at": time.Now()})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrTaskStateConflict
	}
	return nil
}

func (r *Repository) FailModel3DTask(taskID, owner, code, message, state string) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if err := requireModel3DLease(tx, taskID, owner); err != nil {
			return err
		}
		updates := map[string]any{"error_code": code, "updated_at": time.Now()}
		if state != "" {
			updates["state"] = state
		}
		if state == "rejected" || state == "unknown" || state == "finished" {
			updates["tokens_encrypted"] = ""
		}
		if err := tx.Model(&model.Model3DSubmission{}).Where("task_id = ?", taskID).Updates(updates).Error; err != nil {
			return err
		}
		return tx.Model(&model.Task{}).Where("id = ?", taskID).Updates(map[string]any{"status": model.TaskStatusFailed, "stage": "3D 生成失败", "error": message, "completed_at": time.Now(), "lease_owner": "", "lease_expires_at": nil}).Error
	})
}

func (r *Repository) CompleteModel3DSubmission(taskID string) error {
	if err := r.db.Model(&model.Model3DSubmission{}).Where("task_id = ? AND state = ?", taskID, "storing").Updates(map[string]any{"state": "completed", "delivery_encrypted": "", "tokens_encrypted": "", "error_code": "", "updated_at": time.Now()}).Error; err != nil {
		return err
	}
	return r.db.Model(&model.Task{}).Where("id = ? AND status = ?", taskID, model.TaskStatusSucceeded).Updates(map[string]any{"lease_owner": "", "lease_expires_at": nil}).Error
}

func (r *Repository) RecoverModel3DTask(userID, taskID string, activeLimit int) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if _, err := lockModel3DPolicy(tx); err != nil {
			return err
		}
		var task model.Task
		var submission model.Model3DSubmission
		if err := tx.First(&task, "id = ? AND user_id = ? AND type = ?", taskID, userID, model.TaskTypeCanvasModel3D).Error; err != nil {
			return err
		}
		if err := tx.First(&submission, "task_id = ?", taskID).Error; err != nil {
			return err
		}
		if task.Status != model.TaskStatusFailed || task.ProviderRequestID == "" || (submission.State != "accepted" && submission.State != "storing") {
			return ErrModel3DConflict
		}
		if err := enforceActiveTaskLimit(tx, userID, activeLimit); err != nil {
			return err
		}
		return tx.Model(&task).Updates(map[string]any{"status": model.TaskStatusQueued, "stage": "恢复原 3D 任务", "error": "", "completed_at": nil, "next_poll_at": nil, "lease_owner": "", "lease_expires_at": nil}).Error
	})
}

func (r *Repository) CancelModel3DTask(userID, taskID string) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if _, err := lockModel3DPolicy(tx); err != nil {
			return err
		}
		var submission model.Model3DSubmission
		if err := tx.First(&submission, "task_id = ? AND user_id = ?", taskID, userID).Error; err != nil {
			return err
		}
		if submission.State != "prepared" && submission.State != "uploading" {
			return ErrModel3DConflict
		}
		result := tx.Model(&model.Task{}).Where("id = ? AND user_id = ? AND provider_request_id = '' AND status IN ?", taskID, userID, []model.TaskStatus{model.TaskStatusQueued, model.TaskStatusRunning}).Updates(map[string]any{"status": model.TaskStatusCancelled, "stage": "任务已取消", "error": "任务已取消", "completed_at": time.Now(), "lease_owner": "", "lease_expires_at": nil})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return ErrModel3DConflict
		}
		return tx.Model(&submission).Updates(map[string]any{"state": "cancelled", "tokens_encrypted": "", "updated_at": time.Now()}).Error
	})
}

// Direct deletion paths must share admission's lock, not rely on an earlier UI reference scan.
func (r *Repository) RequireNoModel3DReferences(ids []string) error {
	if len(ids) == 0 || !r.db.Migrator().HasTable(&model.Model3DSubmission{}) {
		return nil
	}
	if _, err := lockModel3DPolicy(r.db); err != nil {
		return err
	}
	set := map[string]struct{}{}
	for _, id := range ids {
		set[id] = struct{}{}
	}
	var tasks []model.Task
	if err := r.db.Where("type = ? AND status IN ?", model.TaskTypeCanvasModel3D, []model.TaskStatus{model.TaskStatusQueued, model.TaskStatusRunning}).Find(&tasks).Error; err != nil {
		return err
	}
	for _, task := range tasks {
		if assets.DocumentReferences(task.InputJSON, set) || assets.DocumentReferences(task.ResultJSON, set) {
			return ErrModel3DReferenced
		}
	}
	return nil
}
