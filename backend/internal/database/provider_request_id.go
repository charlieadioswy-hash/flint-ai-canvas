package database

import (
	"fmt"

	"yingce/backend/internal/model"

	"gorm.io/gorm"
)

func migrateProviderRequestIDText(tx *gorm.DB) error {
	// SQLite does not enforce varchar lengths. PostgreSQL must also upgrade
	// existing columns: gateway task IDs can encode multiple routing layers.
	if tx.Dialector.Name() != "postgres" {
		return nil
	}
	for _, entity := range []any{&model.Task{}, &model.ApiCallLog{}, &model.BillingOrder{}, &model.RouteAttempt{}} {
		if !tx.Migrator().HasColumn(entity, "ProviderRequestID") {
			continue
		}
		if err := tx.Migrator().AlterColumn(entity, "ProviderRequestID"); err != nil {
			return fmt.Errorf("扩展 %T 上游任务编号字段：%w", entity, err)
		}
	}
	return nil
}
