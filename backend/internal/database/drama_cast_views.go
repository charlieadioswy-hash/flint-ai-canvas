package database

import (
	"gorm.io/gorm"
	"yingce/backend/internal/model"
)

func migrateDramaCastViews(tx *gorm.DB) error {
	return tx.AutoMigrate(&model.DramaCastView{})
}
