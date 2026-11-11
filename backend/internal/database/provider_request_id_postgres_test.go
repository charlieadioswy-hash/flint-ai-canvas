package database

import (
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

func TestPostgresProviderRequestIDMigrationPreservesDataAndAcceptsGatewayIDs(t *testing.T) {
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
	schemaName := fmt.Sprintf("provider_request_id_%d", time.Now().UnixNano())
	if err := base.Exec(`CREATE SCHEMA "` + schemaName + `"`).Error; err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := base.Exec(`DROP SCHEMA IF EXISTS "` + schemaName + `" CASCADE`).Error; err != nil {
			t.Error(err)
		}
	}()
	testDSN, err := postgresDSNWithSearchPath(dsn, schemaName)
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

	tables := []string{"tasks", "api_call_logs", "billing_orders", "route_attempts"}
	for _, table := range tables {
		if err := db.Exec(`CREATE TABLE "` + table + `" (id varchar(36) PRIMARY KEY, provider_request_id varchar(160), payload text)`).Error; err != nil {
			t.Fatal(err)
		}
		if err := db.Exec(`CREATE INDEX "idx_` + table + `_provider_request_id" ON "` + table + `" (provider_request_id)`).Error; err != nil {
			t.Fatal(err)
		}
		if err := db.Table(table).Create(map[string]any{"id": "existing", "provider_request_id": "original-id", "payload": "preserved"}).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err := db.AutoMigrate(&schemaMigration{}); err != nil {
		t.Fatal(err)
	}
	for _, entry := range schemaMigrations {
		if entry.version < 109 {
			if err := db.Create(&schemaMigration{Version: entry.version, Name: entry.name, Checksum: entry.checksum, AppliedAt: time.Now()}).Error; err != nil {
				t.Fatal(err)
			}
		}
	}
	for i := 0; i < 2; i++ {
		if err := MigrateSchema(db); err != nil {
			t.Fatal(err)
		}
		if err := migrateProviderRequestIDText(db); err != nil {
			t.Fatal(err)
		}
	}
	if err := RequireSchemaVersion(db); err != nil {
		t.Fatal(err)
	}
	// Reproduce a composite gateway ID longer than the former varchar(160).
	providerID := "video." + strings.Repeat("a", 237)
	for _, table := range tables {
		t.Run(table, func(t *testing.T) {
			var existing struct{ ProviderRequestID, Payload string }
			if err := db.Table(table).Where("id = ?", "existing").Scan(&existing).Error; err != nil {
				t.Fatal(err)
			}
			if existing.ProviderRequestID != "original-id" || existing.Payload != "preserved" {
				t.Fatalf("migration changed historical row: %+v", existing)
			}
			if err := db.Table(table).Create(map[string]any{"id": "new", "provider_request_id": providerID, "payload": "new"}).Error; err != nil {
				t.Fatalf("save gateway task ID: %v", err)
			}
			if err := db.Table(table).Where("id = ?", "existing").Update("provider_request_id", providerID).Error; err != nil {
				t.Fatalf("update gateway task ID: %v", err)
			}
			var count int64
			if err := db.Table(table).Where("provider_request_id = ?", providerID).Count(&count).Error; err != nil || count != 2 {
				t.Fatalf("full gateway ID round trip: count=%d err=%v", count, err)
			}
			if !db.Migrator().HasIndex(table, "idx_"+table+"_provider_request_id") {
				t.Fatal("migration removed provider task ID index")
			}
			var dataType string
			if err := db.Raw(`SELECT data_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ? AND column_name = 'provider_request_id'`, table).Scan(&dataType).Error; err != nil || dataType != "text" {
				t.Fatalf("provider task ID column type=%q err=%v", dataType, err)
			}
		})
	}
}
