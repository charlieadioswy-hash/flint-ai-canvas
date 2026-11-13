package repository

import (
	"yingce/backend/internal/model"

	"gorm.io/gorm/clause"
)

// 调用方在事务内校验角色库当前版本，再复制该版本，不导入旧请求对应的新版本。
func (r *Repository) UserCharacterAssetForUpdate(userID, assetID string) (*model.Asset, error) {
	var asset model.Asset
	err := r.db.Clauses(clause.Locking{Strength: "UPDATE"}).Where("id = ? AND user_id = ? AND category = ? AND kind = ? AND status <> ?", assetID, userID, model.AssetCategoryCharacter, "entity", model.AssetVersionStatusArchived).First(&asset).Error
	return &asset, err
}

func (r *Repository) DramaCharacterUsageShots(projectID string) ([]model.DramaShot, error) {
	var shots []model.DramaShot
	err := r.db.Where("project_id = ?", projectID).Order("episode_id, position, id").Find(&shots).Error
	return shots, err
}
