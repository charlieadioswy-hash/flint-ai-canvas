package database

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"infinite-canvas/backend/internal/model"

	"gorm.io/gorm"
)

func mergedMigrationFixture(t *testing.T, upstream bool, lastVersion int64) *gorm.DB {
	t.Helper()
	db, err := Open(Config{Driver: "sqlite", DSN: "file:" + t.Name() + "?mode=memory&cache=shared"})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := db.AutoMigrate(&schemaMigration{}); err != nil {
		t.Fatal(err)
	}
	for _, item := range schemaMigrations {
		if item.version > lastVersion || upstream && item.version == 44 {
			continue
		}
		if upstream && item.version == 45 {
			item = schemaMigrations[len(schemaMigrations)-1]
			item.version = 45
		}
		if err := item.apply(db); err != nil {
			t.Fatal(err)
		}
		if err := db.Create(&schemaMigration{Version: item.version, Name: item.name, Checksum: item.checksum, AppliedAt: time.Date(2026, 10, 5, 0, 0, 0, 0, time.UTC)}).Error; err != nil {
			t.Fatal(err)
		}
	}
	// Baseline Models follows the current schema; remove tables absent on the
	// historical branch so upgrades must actually recreate them.
	missing := []any{}
	if upstream {
		missing = append(missing, &model.ImageModerationProvider{}, &model.ImageModerationConfig{}, &model.ImageModerationPolicy{}, &model.ImageModerationCheck{}, &model.ImageModerationItem{}, &model.ImageModerationDailyUsage{}, &model.Model3DProvider{}, &model.Model3DConfig{}, &model.Model3DPolicy{}, &model.Model3DSubmission{}, &model.Model3DDailyUsage{})
	} else {
		missing = append(missing, &model.UploadReservation{})
	}
	if lastVersion < 46 {
		missing = append(missing, &model.SkillCurationSetting{}, &model.SkillCurationCategory{}, &model.SkillCurationAssignment{})
	}
	if lastVersion < 47 {
		missing = append(missing, &model.SkillCurationRoot{}, &model.SkillCurationRootAssignment{})
	}
	for _, table := range missing {
		if err := db.Migrator().DropTable(table); err != nil {
			t.Fatal(err)
		}
	}
	return db
}

func TestMergedMigrationsPreserveBothVersion45Lineages(t *testing.T) {
	for _, tc := range []struct {
		upstream bool
		version  int64
	}{{false, 45}, {true, 45}, {true, 47}} {
		t.Run(fmt.Sprintf("upstream-%t-v%d", tc.upstream, tc.version), func(t *testing.T) {
			db := mergedMigrationFixture(t, tc.upstream, tc.version)
			var before []schemaMigration
			if err := db.Order("version").Find(&before).Error; err != nil {
				t.Fatal(err)
			}
			kept := &model.Task{ID: "kept-task", UserID: "owner", Type: model.TaskTypeCanvasModel3D, Status: model.TaskStatusSucceeded, ResultJSON: `{"resourceId":"kept-resource"}`}
			if err := db.Create(kept).Error; err != nil {
				t.Fatal(err)
			}
			if tc.upstream {
				if err := db.Create(&model.UploadReservation{ID: "kept-upload", UserID: "owner", Size: 123, Day: "2026-10-05", ExpiresAt: time.Now().Add(time.Hour)}).Error; err != nil {
					t.Fatal(err)
				}
			} else if err := db.Create(&model.Model3DProvider{ID: "kept-provider", Name: "Keep configuration"}).Error; err != nil {
				t.Fatal(err)
			}
			for attempt := 0; attempt < 2; attempt++ {
				if err := MigrateSchema(db); err != nil {
					t.Fatal(err)
				}
				status, err := ReadSchemaStatus(db)
				if err != nil || !status.Ready || status.Current != 48 {
					t.Fatalf("migration status: %+v %v", status, err)
				}
			}
			for _, record := range before {
				var after schemaMigration
				if err := db.First(&after, "version = ?", record.Version).Error; err != nil || record.Name != after.Name || record.Checksum != after.Checksum || !record.AppliedAt.Equal(after.AppliedAt) {
					t.Fatalf("historical migration changed: before=%+v after=%+v err=%v", record, after, err)
				}
			}
			for _, table := range Models() {
				if !db.Migrator().HasTable(table) {
					t.Errorf("missing table %T", table)
				}
			}
			var completed schemaMigration
			if err := db.First(&completed, "version = 48").Error; err != nil {
				t.Fatal(err)
			}
			want := "upload_reservations"
			if tc.upstream {
				want = "canvas_model3d"
				var reservation model.UploadReservation
				if err := db.First(&reservation, "id = ?", "kept-upload").Error; err != nil || reservation.Size != 123 {
					t.Fatalf("upload data changed: %+v %v", reservation, err)
				}
			} else {
				var provider model.Model3DProvider
				if err := db.First(&provider, "id = ?", "kept-provider").Error; err != nil || provider.Name != "Keep configuration" {
					t.Fatalf("3D data changed: %+v %v", provider, err)
				}
			}
			if completed.Name != want {
				t.Fatalf("migration 48=%s, want %s", completed.Name, want)
			}
			var task model.Task
			if err := db.First(&task, "id = ?", kept.ID).Error; err != nil || task.ResultJSON != kept.ResultJSON {
				t.Fatalf("existing task changed: %+v %v", task, err)
			}
		})
	}
}

func TestMergedMigrationsRejectUnknownVersion45(t *testing.T) {
	for _, upstream := range []bool{false, true} {
		for _, field := range []string{"name", "checksum"} {
			t.Run(fmt.Sprintf("upstream-%t-%s", upstream, field), func(t *testing.T) {
				db := mergedMigrationFixture(t, upstream, 45)
				if err := db.Model(&schemaMigration{}).Where("version = 45").Update(field, "unknown").Error; err != nil {
					t.Fatal(err)
				}
				if err := MigrateSchema(db); err == nil || !strings.Contains(err.Error(), "不一致") {
					t.Fatalf("expected unknown lineage rejection, got %v", err)
				}
				var count int64
				if err := db.Model(&schemaMigration{}).Where("version > 45").Count(&count).Error; err != nil || count != 0 {
					t.Fatalf("rejected migration advanced schema: %d %v", count, err)
				}
				if db.Migrator().HasTable(&model.SkillCurationSetting{}) {
					t.Fatal("rejected migration left new tables")
				}
			})
		}
	}
}
