package repository

import (
	"gorm.io/gorm/clause"
	"yingce/backend/internal/model"
)

// 与资产保存共用同一事务，锁定被校验的版本，防止媒体调度在校验与写入之间修改资产。
func (r *Repository) DramaCastForUpdate(projectID, castID string) (*model.DramaCast, error) {
	var cast model.DramaCast
	err := r.db.Clauses(clause.Locking{Strength: "UPDATE"}).Where("project_id = ? AND id = ?", projectID, castID).First(&cast).Error
	return &cast, err
}
