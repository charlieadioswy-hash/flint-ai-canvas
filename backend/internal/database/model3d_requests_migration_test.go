package database

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"yingce/backend/internal/model"

	"gorm.io/gorm"
)

func TestModel3DRequestsMigration78(t *testing.T) {
	db, err := Open(Config{Driver: "sqlite", DSN: filepath.Join(t.TempDir(), "migration.db")})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	testModel3DRequestsMigration(t, db)
}

func TestPostgresModel3DRequestsMigration78(t *testing.T) {
	dsn := strings.TrimSpace(os.Getenv("CANVAS_TEST_POSTGRES_DSN"))
	if dsn == "" {
		t.Skip("CANVAS_TEST_POSTGRES_DSN is not configured")
	}
	base, err := Open(Config{Driver: "postgres", DSN: dsn})
	if err != nil {
		t.Fatal(err)
	}
	baseSQL, err := base.DB()
	if err != nil {
		t.Fatal(err)
	}
	defer baseSQL.Close()
	schema := fmt.Sprintf("model3d_requests_%d", time.Now().UnixNano())
	if err := base.Exec(`CREATE SCHEMA "` + schema + `"`).Error; err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := base.Exec(`DROP SCHEMA IF EXISTS "` + schema + `" CASCADE`).Error; err != nil {
			t.Errorf("drop test schema: %v", err)
		}
	}()
	testDSN, err := postgresDSNWithSearchPath(dsn, schema)
	if err != nil {
		t.Fatal(err)
	}
	db, err := Open(Config{Driver: "postgres", DSN: testDSN})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	defer sqlDB.Close()
	testModel3DRequestsMigration(t, db)
}

func testModel3DRequestsMigration(t *testing.T, db *gorm.DB) {
	t.Helper()
	if err := MigrateSchema(db); err != nil {
		t.Fatal(err)
	}
	if err := db.Migrator().DropTable(&model.Model3DRequest{}); err != nil {
		t.Fatal(err)
	}
	if err := db.Where("version = ?", 78).Delete(&schemaMigration{}).Error; err != nil {
		t.Fatal(err)
	}
	original := model.Model3DSubmission{TaskID: "original-task", UserID: "owner", RequestID: "original-request", RequestHash: "original-hash", State: "failed", ConfigID: "original-config", TokensEncrypted: "fixture-ciphertext"}
	if err := db.Create(&original).Error; err != nil {
		t.Fatal(err)
	}
	var history []schemaMigration
	if err := db.Order("version").Find(&history).Error; err != nil {
		t.Fatal(err)
	}
	for attempt := 0; attempt < 2; attempt++ {
		if err := MigrateSchema(db); err != nil {
			t.Fatal(err)
		}
		var mapping model.Model3DRequest
		if err := db.First(&mapping, "user_id = ? AND request_id = ?", original.UserID, original.RequestID).Error; err != nil {
			t.Fatal(err)
		}
		if mapping.TaskID != original.TaskID || mapping.RequestHash != original.RequestHash || !mapping.CreatedAt.Equal(original.CreatedAt) {
			t.Fatalf("original request identity changed: %+v", mapping)
		}
		var preserved model.Model3DSubmission
		if err := db.First(&preserved, "task_id = ?", original.TaskID).Error; err != nil {
			t.Fatal(err)
		}
		if preserved.RequestHash != original.RequestHash || preserved.State != original.State || preserved.TokensEncrypted != original.TokensEncrypted || preserved.ConfigID != original.ConfigID || !preserved.UpdatedAt.Equal(original.UpdatedAt) {
			t.Fatalf("submission checkpoint changed: %+v", preserved)
		}
		var after []schemaMigration
		if err := db.Where("version <> ?", 78).Order("version").Find(&after).Error; err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(history, after) {
			t.Fatal("historical migration ledger changed")
		}
	}
	alias := model.Model3DRequest{UserID: original.UserID, RequestID: "reused-request", TaskID: original.TaskID, RequestHash: "new-request-hash"}
	if err := db.Create(&alias).Error; err != nil {
		t.Fatal(err)
	}
	if err := migrateModel3DRequests(db); err != nil {
		t.Fatal(err)
	}
	var mappings []model.Model3DRequest
	if err := db.Order("request_id").Find(&mappings).Error; err != nil {
		t.Fatal(err)
	}
	if len(mappings) != 2 || mappings[1].RequestHash != alias.RequestHash || mappings[1].TaskID != original.TaskID {
		t.Fatalf("reapplying migration lost the reuse mapping: %+v", mappings)
	}
	if err := db.Create(&alias).Error; err == nil {
		t.Fatal("duplicate user/request identity was accepted")
	}
	alias.UserID = "other-owner"
	if err := db.Create(&alias).Error; err != nil {
		t.Fatalf("request IDs must be scoped by user: %v", err)
	}
	status, err := ReadSchemaStatus(db)
	if err != nil || !status.Ready || status.Current != CurrentSchemaVersion {
		t.Fatalf("schema status: %+v / %v", status, err)
	}
}
