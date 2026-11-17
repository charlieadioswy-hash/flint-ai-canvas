package database

import (
	"yingce/backend/internal/model"

	"gorm.io/gorm"
)

func migrateDramaEpisodeAssets(tx *gorm.DB) error {
	if !tx.Migrator().HasTable(&model.DramaEpisode{}) || tx.Migrator().HasColumn(&model.DramaEpisode{}, "AssetIDsJSON") {
		return nil
	}
	return tx.Migrator().AddColumn(&model.DramaEpisode{}, "AssetIDsJSON")
}
