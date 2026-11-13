package database

import (
	"gorm.io/gorm"
	"yingce/backend/internal/model"
)

func migrateDramaShotMedia(tx *gorm.DB) error {
	return tx.AutoMigrate(&model.DramaShotMedia{})
}
