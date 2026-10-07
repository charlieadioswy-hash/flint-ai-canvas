package database

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"infinite-canvas/backend/internal/model"

	"gorm.io/gorm"
)

func migrateModel3DAssetTimestamps(tx *gorm.DB) error {
	var assets []model.Asset
	return tx.Select("id", "payload_json").Where("kind = ?", "model").FindInBatches(&assets, 100, func(_ *gorm.DB, _ int) error {
		for _, asset := range assets {
			if !strings.HasPrefix(asset.ID, "model3d_") {
				continue
			}
			var payload map[string]json.RawMessage
			if err := json.Unmarshal([]byte(asset.PayloadJSON), &payload); err != nil {
				return fmt.Errorf("读取 3D 素材 %s：%w", asset.ID, err)
			}
			var metadata struct {
				Source string `json:"source"`
			}
			if err := json.Unmarshal(payload["metadata"], &metadata); err != nil || metadata.Source != "model3d" {
				continue
			}
			changed := false
			for _, key := range []string{"createdAt", "updatedAt"} {
				value := strings.TrimSpace(string(payload[key]))
				if value == "" || value[0] != '-' && (value[0] < '0' || value[0] > '9') {
					continue
				}
				var milliseconds int64
				if err := json.Unmarshal(payload[key], &milliseconds); err != nil {
					return fmt.Errorf("读取 3D 素材 %s 的 %s 毫秒时间：%w", asset.ID, key, err)
				}
				encoded, err := json.Marshal(time.UnixMilli(milliseconds).UTC().Format(time.RFC3339Nano))
				if err != nil {
					return err
				}
				payload[key] = encoded
				changed = true
			}
			if !changed {
				continue
			}
			encoded, err := json.Marshal(payload)
			if err != nil {
				return err
			}
			// Only repair the persisted payload; preserve row timestamps, ownership and concurrent user edits.
			result := tx.Model(&model.Asset{}).Where("id = ? AND payload_json = ?", asset.ID, asset.PayloadJSON).UpdateColumn("payload_json", string(encoded))
			if result.Error != nil {
				return result.Error
			}
			if result.RowsAffected != 1 {
				return fmt.Errorf("3D 素材 %s 在迁移期间发生变化", asset.ID)
			}
		}
		return nil
	}).Error
}
