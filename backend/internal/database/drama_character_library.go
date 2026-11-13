package database

import (
	"yingce/backend/internal/model"

	"gorm.io/gorm"
)

func migrateDramaCharacterLibrary(tx *gorm.DB) error {
	if !tx.Migrator().HasTable(&model.DramaCast{}) {
		return nil
	}
	for _, field := range []string{"DefinitionJSON", "LibraryAssetID", "LibraryVersionID"} {
		if !tx.Migrator().HasColumn(&model.DramaCast{}, field) {
			if err := tx.Migrator().AddColumn(&model.DramaCast{}, field); err != nil {
				return err
			}
		}
	}
	for _, column := range []string{"definition_json", "library_asset_id", "library_version_id"} {
		if err := tx.Model(&model.DramaCast{}).Where(column+" IS NULL").UpdateColumn(column, "").Error; err != nil {
			return err
		}
	}
	return nil
}
