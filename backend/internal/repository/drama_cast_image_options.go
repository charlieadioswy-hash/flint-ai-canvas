package repository

import (
	"slices"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"yingce/backend/internal/model"
)

// 在保存配置的事务中持有资源锁，与孤儿清理串行化。
func (r *Repository) LockDramaCastImageReferences(userID string, resourceIDs []string) error {
	if len(resourceIDs) == 0 {
		return nil
	}
	ids := slices.Clone(resourceIDs)
	slices.Sort(ids)
	ids = slices.Compact(ids)
	var resources []model.Resource
	query := r.db.Select("id").Where("user_id = ? AND id IN ?", userID, ids).Order("id")
	if r.Dialect() == "postgres" {
		query = query.Clauses(clause.Locking{Strength: "UPDATE"})
	}
	if err := query.Find(&resources).Error; err != nil {
		return err
	}
	if len(resources) != len(ids) {
		return gorm.ErrRecordNotFound
	}
	return nil
}
