package database

import (
	"gorm.io/gorm"
	"yingce/backend/internal/model"
)

func migrateDramaStoryboard(tx *gorm.DB) error {
	return tx.AutoMigrate(&model.DramaStoryboardBoard{}, &model.DramaStoryboardCell{})
}
