package repository

import (
	"errors"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"infinite-canvas/backend/internal/model"
)

const imageModerationPolicyID = "image-content"

var ErrImageModerationConflict = errors.New("检测配置已变化，请刷新后重试")
var ErrImageModerationActive = errors.New("请先停用当前检测 Provider")
var ErrImageModerationUnavailable = errors.New("图片内容检测服务未配置")
var ErrImageModerationInterval = errors.New("检测操作过于频繁，请稍后重试")
var ErrImageModerationBudget = errors.New("今日图片检测调用额度已用完")
var ErrImageModerationReferenced = errors.New("图片内容检测正在执行，资源暂不可删除")

func lockImageModerationPolicy(tx *gorm.DB) (*model.ImageModerationPolicy, error) {
	policy := model.ImageModerationPolicy{ID: imageModerationPolicyID}
	if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&policy).Error; err != nil {
		return nil, err
	}
	// A write obtains the SQLite writer lock; PostgreSQL additionally locks the singleton row.
	if err := tx.Model(&model.ImageModerationPolicy{}).Where("id = ?", imageModerationPolicyID).UpdateColumn("revision", gorm.Expr("revision")).Error; err != nil {
		return nil, err
	}
	if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&policy, "id = ?", imageModerationPolicyID).Error; err != nil {
		return nil, err
	}
	return &policy, nil
}

func (r *Repository) ImageModerationState() ([]model.ImageModerationProvider, []model.ImageModerationConfig, model.ImageModerationPolicy, error) {
	providers := []model.ImageModerationProvider{}
	configs := []model.ImageModerationConfig{}
	policy := model.ImageModerationPolicy{ID: imageModerationPolicyID}
	err := r.db.Transaction(func(tx *gorm.DB) error {
		lockedPolicy, err := lockImageModerationPolicy(tx)
		if err != nil {
			return err
		}
		policy = *lockedPolicy
		if err := tx.Order("created_at asc, id asc").Find(&providers).Error; err != nil {
			return err
		}
		if err := tx.Find(&configs).Error; err != nil {
			return err
		}
		return nil
	})
	return providers, configs, policy, err
}

func (r *Repository) ImageModerationProvider(id string) (*model.ImageModerationProvider, error) {
	var value model.ImageModerationProvider
	err := r.db.First(&value, "id = ?", id).Error
	return &value, err
}

func (r *Repository) ImageModerationConfig(id string) (*model.ImageModerationConfig, error) {
	var value model.ImageModerationConfig
	err := r.db.First(&value, "id = ?", id).Error
	return &value, err
}

func (r *Repository) SaveImageModerationProvider(provider *model.ImageModerationProvider, config *model.ImageModerationConfig, previousConfigID string, audit *model.AdminAuditEvent) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		policy, err := lockImageModerationPolicy(tx)
		if err != nil {
			return err
		}
		if previousConfigID != "" {
			var current model.ImageModerationProvider
			if err := tx.First(&current, "id = ?", provider.ID).Error; err != nil {
				return err
			}
			if current.Archived || current.LatestConfigID != previousConfigID {
				return ErrImageModerationConflict
			}
			if policy.ActiveProviderID == provider.ID && !provider.Enabled {
				return ErrImageModerationActive
			}
		} else if err := tx.Create(provider).Error; err != nil {
			return err
		}
		if err := tx.Create(config).Error; err != nil {
			return err
		}
		if err := tx.Model(&model.ImageModerationProvider{}).Where("id = ?", provider.ID).Updates(map[string]any{"name": provider.Name, "enabled": provider.Enabled, "latest_config_id": config.ID, "updated_at": time.Now().UTC()}).Error; err != nil {
			return err
		}
		return tx.Create(audit).Error
	})
}

func (r *Repository) SetImageModerationPolicy(providerID, configID string, expectedRevision int64, audit *model.AdminAuditEvent) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		policy, err := lockImageModerationPolicy(tx)
		if err != nil {
			return err
		}
		if policy.Revision != expectedRevision {
			return ErrImageModerationConflict
		}
		if providerID != "" {
			var provider model.ImageModerationProvider
			if err := tx.First(&provider, "id = ?", providerID).Error; err != nil {
				return err
			}
			if provider.Archived || !provider.Enabled || provider.LatestConfigID != configID {
				return ErrImageModerationConflict
			}
			var count int64
			if err := tx.Model(&model.ImageModerationConfig{}).Where("id = ? AND provider_id = ?", configID, providerID).Count(&count).Error; err != nil {
				return err
			}
			if count != 1 {
				return ErrImageModerationConflict
			}
		}
		if err := tx.Model(policy).Updates(map[string]any{"active_provider_id": providerID, "active_config_id": configID, "revision": policy.Revision + 1, "updated_at": time.Now().UTC()}).Error; err != nil {
			return err
		}
		return tx.Create(audit).Error
	})
}

func (r *Repository) ArchiveImageModerationProvider(id string, audit *model.AdminAuditEvent) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		policy, err := lockImageModerationPolicy(tx)
		if err != nil {
			return err
		}
		if policy.ActiveProviderID == id {
			return ErrImageModerationActive
		}
		result := tx.Model(&model.ImageModerationProvider{}).Where("id = ?", id).Updates(map[string]any{"archived": true, "enabled": false, "updated_at": time.Now().UTC()})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected == 0 {
			return gorm.ErrRecordNotFound
		}
		return tx.Create(audit).Error
	})
}

func (r *Repository) ActiveImageModerationConfig() (*model.ImageModerationConfig, error) {
	var config model.ImageModerationConfig
	err := r.db.Table("image_moderation_configs AS c").Select("c.*").Joins("JOIN image_moderation_policies p ON p.active_config_id = c.id").Joins("JOIN image_moderation_providers v ON v.id = p.active_provider_id").Where("p.id = ? AND v.enabled = ? AND v.archived = ?", imageModerationPolicyID, true, false).Take(&config).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, ErrImageModerationUnavailable
	}
	return &config, err
}

func (r *Repository) AdmitImageModerationCheck(check *model.ImageModerationCheck, items []model.ImageModerationItem, intervalSeconds int) (*model.ImageModerationCheck, bool, error) {
	var existing model.ImageModerationCheck
	reused := false
	err := r.db.Transaction(func(tx *gorm.DB) error {
		policy, err := lockImageModerationPolicy(tx)
		if err != nil {
			return err
		}
		if policy.ActiveConfigID != check.ConfigID || policy.ActiveProviderID != check.ProviderID {
			return ErrImageModerationConflict
		}
		var provider model.ImageModerationProvider
		if err := tx.First(&provider, "id = ? AND enabled = ? AND archived = ?", check.ProviderID, true, false).Error; err != nil {
			return ErrImageModerationUnavailable
		}
		if err := tx.Where("active_key = ?", *check.ActiveKey).Take(&existing).Error; err == nil {
			reused = true
			return nil
		} else if !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		var resource model.Resource
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&resource, "id = ? AND user_id = ? AND status = ?", check.ResourceID, check.UserID, model.ResourceStatusReady).Error; err != nil {
			return err
		}
		if model.ImageModerationResourceVersion(&resource) != check.ResourceVersion {
			return ErrImageModerationConflict
		}
		// The acceptance instant follows both locks; time spent waiting must not relax the interval.
		check.CreatedAt = time.Now().UTC()
		for index := range items {
			items[index].CreatedAt = check.CreatedAt
		}
		var count int64
		if err := tx.Model(&model.ImageModerationCheck{}).Where("user_id = ? AND created_at > ?", check.UserID, check.CreatedAt.Add(-time.Duration(intervalSeconds)*time.Second)).Count(&count).Error; err != nil {
			return err
		}
		if count > 0 {
			return ErrImageModerationInterval
		}
		if err := tx.Create(check).Error; err != nil {
			return err
		}
		return tx.Create(&items).Error
	})
	if reused {
		return &existing, true, err
	}
	return check, false, err
}

func (r *Repository) ImageModerationCheckForUser(userID, id string) (*model.ImageModerationCheck, error) {
	var value model.ImageModerationCheck
	err := r.db.First(&value, "id = ? AND user_id = ?", id, userID).Error
	return &value, err
}

func (r *Repository) LatestImageModerationCheck(userID, resourceID string) (*model.ImageModerationCheck, error) {
	var value model.ImageModerationCheck
	err := r.db.Where("user_id = ? AND resource_id = ?", userID, resourceID).Order("created_at desc, id desc").Take(&value).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	return &value, err
}

func (r *Repository) ClaimImageModerationCheck(owner string, lease time.Duration) (*model.ImageModerationCheck, error) {
	var check model.ImageModerationCheck
	now := time.Now().UTC()
	err := r.db.Transaction(func(tx *gorm.DB) error {
		// Serialize claims with admission and policy changes across both SQLite and PostgreSQL.
		if _, err := lockImageModerationPolicy(tx); err != nil {
			return err
		}
		condition := "status = ? OR (status = ? AND lease_expires_at <= ?)"
		if err := tx.Where(condition, "queued", "running", now).Order("created_at asc, id asc").Take(&check).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return nil
			}
			return err
		}
		if check.Status == "running" {
			// A started request may already have been billed; never replay it after a crash.
			if err := tx.Model(&model.ImageModerationItem{}).Where("check_id = ? AND status = ?", check.ID, "running").Updates(map[string]any{"status": "failed", "error_code": "execution_uncertain", "completed_at": now, "updated_at": now}).Error; err != nil {
				return err
			}
		}
		return tx.Model(&check).Updates(map[string]any{"status": "running", "lease_owner": owner, "lease_expires_at": now.Add(lease), "updated_at": now}).Error
	})
	if err != nil || check.ID == "" {
		return nil, err
	}
	check.Status = "running"
	check.LeaseOwner = owner
	return &check, nil
}

func (r *Repository) ImageModerationItems(checkID string) ([]model.ImageModerationItem, error) {
	items := []model.ImageModerationItem{}
	err := r.db.Where("check_id = ?", checkID).Order("created_at asc, service asc").Find(&items).Error
	return items, err
}

func (r *Repository) BeginImageModerationItem(checkID, itemID, owner string, maxCalls int, lease time.Duration) error {
	now := time.Now().UTC()
	return r.db.Transaction(func(tx *gorm.DB) error {
		if _, err := lockImageModerationPolicy(tx); err != nil {
			return err
		}
		var check model.ImageModerationCheck
		if err := tx.First(&check, "id = ? AND lease_owner = ? AND status = ? AND lease_expires_at > ?", checkID, owner, "running", now).Error; err != nil {
			return ErrImageModerationConflict
		}
		usage := model.ImageModerationDailyUsage{Day: now.Format("2006-01-02")}
		if err := tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&usage).Error; err != nil {
			return err
		}
		reserved := tx.Model(&model.ImageModerationDailyUsage{}).Where("day = ? AND calls < ?", usage.Day, maxCalls).Updates(map[string]any{"calls": gorm.Expr("calls + 1"), "updated_at": now})
		if reserved.Error != nil {
			return reserved.Error
		}
		if reserved.RowsAffected == 0 {
			return ErrImageModerationBudget
		}
		result := tx.Model(&model.ImageModerationItem{}).Where("id = ? AND check_id = ? AND status = ?", itemID, checkID, "queued").Updates(map[string]any{"status": "running", "started_at": now, "updated_at": now})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected == 0 {
			return ErrImageModerationConflict
		}
		return tx.Model(&check).Update("lease_expires_at", now.Add(lease)).Error
	})
}

func (r *Repository) CompleteImageModerationItem(checkID, owner string, item *model.ImageModerationItem) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if _, err := lockImageModerationPolicy(tx); err != nil {
			return err
		}
		var check model.ImageModerationCheck
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&check, "id = ? AND lease_owner = ? AND status = ?", checkID, owner, "running").Error; err != nil {
			return ErrImageModerationConflict
		}
		return tx.Model(&model.ImageModerationItem{}).Where("id = ? AND check_id = ?", item.ID, checkID).Updates(map[string]any{"status": item.Status, "risk_level": item.RiskLevel, "risk_tags_json": item.RiskTagsJSON, "request_id": item.RequestID, "error_code": item.ErrorCode, "completed_at": time.Now().UTC(), "updated_at": time.Now().UTC()}).Error
	})
}

func (r *Repository) CompleteImageModerationCheck(checkID, owner, status, risk, tags, summary string) error {
	now := time.Now().UTC()
	result := r.db.Model(&model.ImageModerationCheck{}).Where("id = ? AND status = ? AND lease_owner = ?", checkID, "running", owner).Updates(map[string]any{"status": status, "overall_risk": risk, "risk_tags_json": tags, "summary": summary, "active_key": nil, "lease_owner": "", "lease_expires_at": nil, "completed_at": now, "updated_at": now})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected == 0 {
		return ErrImageModerationConflict
	}
	return nil
}

func (r *Repository) RequireNoImageModerationReferences(resourceIDs []string) error {
	if len(resourceIDs) == 0 {
		return nil
	}
	if _, err := lockImageModerationPolicy(r.db); err != nil {
		return err
	}
	var count int64
	if err := r.db.Model(&model.ImageModerationCheck{}).Where("resource_id IN ? AND status IN ?", resourceIDs, []string{"queued", "running"}).Count(&count).Error; err != nil {
		return err
	}
	if count > 0 {
		return ErrImageModerationReferenced
	}
	return nil
}
