package database

import (
	"yingce/backend/internal/model"

	"gorm.io/gorm"
)

func migrateDramaEpisodeStyle(tx *gorm.DB) error {
	if !tx.Migrator().HasTable(&model.DramaEpisode{}) {
		return nil
	}
	for _, field := range []string{"StyleMode", "StyleName", "StylePrompt"} {
		if !tx.Migrator().HasColumn(&model.DramaEpisode{}, field) {
			if err := tx.Migrator().AddColumn(&model.DramaEpisode{}, field); err != nil {
				return err
			}
		}
	}
	return nil
}
