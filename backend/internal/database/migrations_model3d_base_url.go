package database

import (
	"infinite-canvas/backend/internal/model"

	"gorm.io/gorm"
)

func migrateModel3DBaseURL(tx *gorm.DB) error {
	if !tx.Migrator().HasColumn(&model.Model3DConfig{}, "BaseURL") {
		if err := tx.Migrator().AddColumn(&model.Model3DConfig{}, "BaseURL"); err != nil {
			return err
		}
	}
	// Freeze the historical endpoint into every existing configuration version.
	// Runtime code requires the stored value and never supplies a fallback.
	return tx.Model(&model.Model3DConfig{}).Where("base_url IS NULL OR base_url = ?", "").UpdateColumn("base_url", "https://openapi.tripo3d.ai/v3").Error
}
