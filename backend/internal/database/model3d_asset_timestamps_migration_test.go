package database

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"

	"gorm.io/gorm"
)

func TestModel3DAssetTimestampMigration50PreservesCompletedTask(t *testing.T) {
	db, err := Open(Config{Driver: "sqlite", DSN: filepath.Join(t.TempDir(), "migration.db")})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	testModel3DAssetTimestampMigration(t, db)
}

func TestPostgresModel3DAssetTimestampMigration50(t *testing.T) {
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
	schema := fmt.Sprintf("model3d_asset_migration_%d", time.Now().UnixNano())
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
	testModel3DAssetTimestampMigration(t, db)
}

func testModel3DAssetTimestampMigration(t *testing.T, db *gorm.DB) {
	t.Helper()
	if err := MigrateSchema(db); err != nil {
		t.Fatal(err)
	}
	if err := db.Where("version = ?", 50).Delete(&schemaMigration{}).Error; err != nil {
		t.Fatal(err)
	}
	var history []schemaMigration
	if err := db.Order("version").Find(&history).Error; err != nil {
		t.Fatal(err)
	}
	created := time.Date(2026, 10, 7, 8, 0, 1, 123000000, time.UTC)
	updated := created.Add(time.Minute)
	payload := fmt.Sprintf(`{"id":"model3d_done","kind":"model","title":"用户改名","tags":["精选"],"createdAt":%d,"updatedAt":%d,"data":{"storageKey":"resource:kept-resource","url":"/api/resources/kept-resource/file","bytes":41288008,"mimeType":"model/gltf-binary","fileName":"kept.glb"},"metadata":{"source":"model3d","taskId":"done","canvasId":"canvas","nodeId":"node","largeNumber":9007199254740993}}`, created.UnixMilli(), updated.UnixMilli())
	assets := []model.Asset{
		{ID: "model3d_done", UserID: "owner", Kind: "model", Title: "用户改名", FolderID: "folder", PayloadJSON: payload, CreatedAt: created, UpdatedAt: updated},
		{ID: "model3d_valid", UserID: "another-owner", Kind: "model", PayloadJSON: `{"metadata":{"source":"model3d"},"createdAt":"2026-10-07T16:00:01.123+08:00","updatedAt":"2026-10-07T16:01:01.123+08:00"}`, CreatedAt: created.Add(456 * time.Nanosecond), UpdatedAt: updated.Add(789 * time.Nanosecond)},
		{ID: "manual-model", UserID: "owner", Kind: "model", PayloadJSON: `{"metadata":{"source":"manual"},"createdAt":1,"updatedAt":2}`},
		{ID: "model3d_other-source", UserID: "owner", Kind: "model", PayloadJSON: `{"metadata":{"source":"manual"},"createdAt":1,"updatedAt":2}`},
	}
	if err := db.Create(&assets).Error; err != nil {
		t.Fatal(err)
	}
	// Compare persisted instants: PostgreSQL stores microseconds, while fixtures can carry nanoseconds.
	for index := range assets {
		var stored model.Asset
		if err := db.Select("id", "created_at", "updated_at").First(&stored, "id = ?", assets[index].ID).Error; err != nil {
			t.Fatal(err)
		}
		assets[index].CreatedAt = stored.CreatedAt
		assets[index].UpdatedAt = stored.UpdatedAt
	}
	task := model.Task{ID: "done", UserID: "owner", Type: model.TaskTypeCanvasModel3D, Status: model.TaskStatusSucceeded, ProviderRequestID: "upstream-existing", ResultJSON: `{"assetId":"model3d_done","resourceId":"kept-resource","storageKey":"resource:kept-resource"}`, CompletedAt: &updated}
	submission := model.Model3DSubmission{TaskID: task.ID, UserID: task.UserID, RequestID: "original-request", State: "completed", ConfigID: "original-config"}
	resource := model.Resource{ID: "kept-resource", UserID: task.UserID, Kind: "model", Status: model.ResourceStatusReady, Size: 41288008, ObjectKey: "kept.glb", MimeType: "model/gltf-binary"}
	for _, value := range []any{&task, &submission, &resource} {
		if err := db.Create(value).Error; err != nil {
			t.Fatal(err)
		}
	}
	var firstPayload string
	for attempt := 0; attempt < 2; attempt++ {
		if err := MigrateSchema(db); err != nil {
			t.Fatal(err)
		}
		status, err := ReadSchemaStatus(db)
		if err != nil || !status.Ready || status.Current != CurrentSchemaVersion {
			t.Fatalf("migration status: %+v %v", status, err)
		}
		for index, expected := range assets {
			var actual model.Asset
			if err := db.First(&actual, "id = ?", expected.ID).Error; err != nil {
				t.Fatal(err)
			}
			if index != 0 && actual.PayloadJSON != expected.PayloadJSON {
				t.Fatalf("untargeted payload changed: %s", expected.ID)
			}
			if actual.UserID != expected.UserID || actual.Title != expected.Title || actual.FolderID != expected.FolderID || !actual.CreatedAt.Equal(expected.CreatedAt) || !actual.UpdatedAt.Equal(expected.UpdatedAt) {
				t.Fatalf("asset row identity or timestamps changed: %s; createdAt: got %s, want %s; updatedAt: got %s, want %s", expected.ID, actual.CreatedAt.Format(time.RFC3339Nano), expected.CreatedAt.Format(time.RFC3339Nano), actual.UpdatedAt.Format(time.RFC3339Nano), expected.UpdatedAt.Format(time.RFC3339Nano))
			}
			if index != 0 {
				continue
			}
			var before, after map[string]json.RawMessage
			if err := json.Unmarshal([]byte(expected.PayloadJSON), &before); err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal([]byte(actual.PayloadJSON), &after); err != nil {
				t.Fatal(err)
			}
			for _, key := range []string{"createdAt", "updatedAt"} {
				var value string
				if err := json.Unmarshal(after[key], &value); err != nil {
					t.Fatalf("%s is not a string: %v", key, err)
				}
				want := created
				if key == "updatedAt" {
					want = updated
				}
				if value != want.Format(time.RFC3339Nano) {
					t.Fatalf("%s instant changed: %s", key, value)
				}
				delete(before, key)
				delete(after, key)
			}
			if !reflect.DeepEqual(before, after) {
				t.Fatal("migration changed fields other than payload timestamps")
			}
			if attempt == 0 {
				firstPayload = actual.PayloadJSON
			} else if actual.PayloadJSON != firstPayload {
				t.Fatal("migration replay changed the repaired payload")
			}
		}
	}
	for _, previous := range history {
		var actual schemaMigration
		if err := db.First(&actual, "version = ?", previous.Version).Error; err != nil || actual.Name != previous.Name || actual.Checksum != previous.Checksum || !actual.AppliedAt.Equal(previous.AppliedAt) {
			t.Fatalf("historical migration changed: %+v %v", actual, err)
		}
	}
	var keptTask model.Task
	var keptSubmission model.Model3DSubmission
	var keptResource model.Resource
	if err := db.First(&keptTask, "id = ?", task.ID).Error; err != nil || keptTask.Status != task.Status || keptTask.ProviderRequestID != task.ProviderRequestID || keptTask.ResultJSON != task.ResultJSON || !keptTask.CompletedAt.Equal(*task.CompletedAt) {
		t.Fatalf("completed task changed: %+v %v", keptTask, err)
	}
	if err := db.First(&keptSubmission, "task_id = ?", task.ID).Error; err != nil || keptSubmission.State != submission.State || keptSubmission.RequestID != submission.RequestID || keptSubmission.ConfigID != submission.ConfigID {
		t.Fatalf("completed submission changed: %+v %v", keptSubmission, err)
	}
	if err := db.First(&keptResource, "id = ?", resource.ID).Error; err != nil || keptResource.UserID != resource.UserID || keptResource.Size != resource.Size || keptResource.ObjectKey != resource.ObjectKey || keptResource.Status != resource.Status {
		t.Fatalf("model resource changed: %+v %v", keptResource, err)
	}
}
