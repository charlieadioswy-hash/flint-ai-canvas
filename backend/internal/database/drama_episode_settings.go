package database

import (
	"encoding/json"
	"fmt"
	"strings"

	"yingce/backend/internal/model"

	"gorm.io/gorm"
)

func migrateDramaEpisodeSettings(tx *gorm.DB) error {
	if tx.Migrator().HasTable(&model.DramaCast{}) && !tx.Migrator().HasColumn(&model.DramaCast{}, "ImageEpisodeID") {
		if err := tx.Migrator().AddColumn(&model.DramaCast{}, "ImageEpisodeID"); err != nil {
			return err
		}
	}
	hasProduction := tx.Migrator().HasTable(&model.DramaProduction{})
	if hasProduction && !tx.Migrator().HasColumn(&model.DramaProduction{}, "InitialSettingsJSON") {
		if err := tx.Migrator().AddColumn(&model.DramaProduction{}, "InitialSettingsJSON"); err != nil {
			return err
		}
	}
	hasEpisodes := tx.Migrator().HasTable(&model.DramaEpisode{})
	if hasEpisodes && !tx.Migrator().HasColumn(&model.DramaEpisode{}, "SettingsJSON") {
		if err := tx.Migrator().AddColumn(&model.DramaEpisode{}, "SettingsJSON"); err != nil {
			return err
		}
	}
	if hasProduction {
		if err := tx.Exec("UPDATE drama_productions SET initial_settings_json = COALESCE(settings_json, '') WHERE initial_settings_json = '' OR initial_settings_json IS NULL").Error; err != nil {
			return err
		}
	}
	if !hasEpisodes {
		return nil
	}
	var rows []model.DramaEpisode
	return tx.Where("settings_json = '' OR settings_json IS NULL").FindInBatches(&rows, 200, func(batch *gorm.DB, _ int) error {
		defaults := make(map[string]string)
		for _, episode := range rows {
			settings, found := defaults[episode.ProjectID]
			if !found {
				var p model.DramaProduction
				if hasProduction {
					result := batch.Select("project_id", "initial_settings_json").Find(&p, "project_id = ?", episode.ProjectID)
					if result.Error != nil {
						return result.Error
					}
				}
				settings = p.InitialSettingsJSON
				if strings.TrimSpace(settings) == "" {
					settings = "{}"
				}
				defaults[episode.ProjectID] = settings
			}
			if episode.StyleMode == "independent" {
				var value map[string]json.RawMessage
				if err := json.Unmarshal([]byte(settings), &value); err != nil || value == nil {
					return fmt.Errorf("单集 %s 的制作配置无法迁移", episode.ID)
				}
				value["styleName"], _ = json.Marshal(episode.StyleName)
				value["stylePrompt"], _ = json.Marshal(episode.StylePrompt)
				encoded, err := json.Marshal(value)
				if err != nil {
					return err
				}
				settings = string(encoded)
			}
			if err := batch.Model(&model.DramaEpisode{}).Where("id = ? AND (settings_json = '' OR settings_json IS NULL)", episode.ID).UpdateColumn("settings_json", settings).Error; err != nil {
				return err
			}
		}
		return nil
	}).Error
}
