package database

import (
	"reflect"
	"testing"
	"time"

	"yingce/backend/internal/model"
)

func TestEcommerceRoundsUpgradeFrom100PreservesMigrationLedgerAndProjects(t *testing.T) {
	db := schemaBranchFixture(t, "local", 100)
	var before []schemaMigration
	if err := db.Order("version").Find(&before).Error; err != nil {
		t.Fatal(err)
	}
	if len(before) != 100 {
		t.Fatalf("expected released schema 100 fixture, got %d migrations", len(before))
	}
	// 基线使用当前模型，移除新结构以恢复真实的 schema 100。
	if err := db.Migrator().DropTable(&model.EcommerceRound{}); err != nil {
		t.Fatal(err)
	}
	if db.Migrator().HasIndex(&model.EcommerceProject{}, "ActiveRoundID") {
		if err := db.Migrator().DropIndex(&model.EcommerceProject{}, "ActiveRoundID"); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Migrator().DropColumn(&model.EcommerceProject{}, "ActiveRoundID"); err != nil {
		t.Fatal(err)
	}
	if db.Migrator().HasTable(&model.EcommerceRound{}) || db.Migrator().HasColumn(&model.EcommerceProject{}, "ActiveRoundID") {
		t.Fatal("fixture still contains ecommerce round structures")
	}
	createdAt := time.Date(2026, 11, 8, 12, 0, 0, 0, time.UTC)
	if err := db.Table("ecommerce_projects").Create(map[string]any{
		"id": "kept-project", "user_id": "kept-owner", "name": "原商品项目", "status": "draft",
		"draft_json": `{"productName":"原商品"}`, "plan_json": `{"images":[{"id":"active","taskId":"kept-task"}],"previousImages":[{"id":"history","taskId":"kept-history-task"}]}`,
		"revision": 7, "created_at": createdAt, "updated_at": createdAt,
	}).Error; err != nil {
		t.Fatal(err)
	}
	var projectBefore model.EcommerceProject
	if err := db.First(&projectBefore, "id = ?", "kept-project").Error; err != nil {
		t.Fatal(err)
	}
	var applied []schemaMigration
	for attempt := range 2 {
		if err := MigrateSchema(db); err != nil {
			t.Fatalf("upgrade attempt %d: %v", attempt, err)
		}
		if err := RequireSchemaVersion(db); err != nil {
			t.Fatal(err)
		}
		var released []schemaMigration
		if err := db.Where("version <= ?", 100).Order("version").Find(&released).Error; err != nil || !reflect.DeepEqual(before, released) {
			t.Fatalf("released migration identities or timestamps changed: %v", err)
		}
		var all []schemaMigration
		if err := db.Order("version").Find(&all).Error; err != nil {
			t.Fatal(err)
		}
		if len(all) != 101 || all[100].Version != 101 || all[100].Name != "ecommerce_round_history" || all[100].Checksum != "sha256:ecommerce-round-history-v93-20261109" {
			t.Fatalf("round history must append migration 101 without renumbering: %+v", all[len(all)-1])
		}
		if attempt == 0 {
			applied = all
		} else if !reflect.DeepEqual(applied, all) {
			t.Fatal("repeated upgrade changed the migration ledger")
		}
		if !db.Migrator().HasTable(&model.EcommerceRound{}) || !db.Migrator().HasColumn(&model.EcommerceProject{}, "ActiveRoundID") || !db.Migrator().HasIndex(&model.EcommerceProject{}, "ActiveRoundID") {
			t.Fatal("round history table or active round pointer missing after upgrade")
		}
		for _, index := range []string{"idx_ecommerce_round_ordinal", "idx_ecommerce_round_dedup", "idx_ecommerce_round_list"} {
			if !db.Migrator().HasIndex(&model.EcommerceRound{}, index) {
				t.Fatalf("missing round index %s", index)
			}
		}
		var projectAfter model.EcommerceProject
		if err := db.First(&projectAfter, "id = ?", projectBefore.ID).Error; err != nil || !reflect.DeepEqual(projectBefore, projectAfter) {
			t.Fatalf("schema upgrade must preserve legacy drafts, history and task references: before=%+v after=%+v err=%v", projectBefore, projectAfter, err)
		}
		var rounds int64
		if err := db.Model(&model.EcommerceRound{}).Count(&rounds).Error; err != nil || rounds != 0 {
			t.Fatalf("schema upgrade must not eagerly convert or duplicate project rounds: count=%d err=%v", rounds, err)
		}
	}
}
