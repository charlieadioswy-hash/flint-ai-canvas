package database

import (
	"fmt"
	"reflect"
	"strings"
	"testing"

	"yingce/backend/internal/model"
)

func TestDramaMergePreservesReleasedMigrationHistories(t *testing.T) {
	for _, tc := range []struct {
		lineage string
		version int64
	}{
		{"local", 65},
		{"extended_merged_upstream", 61},
		{"extended_merged_upstream", 65},
		{"upstream", 61},
		{"upstream", 66},
		{"upstream", 67},
		{"upstream", 68},
		{"upstream", 72},
	} {
		t.Run(fmt.Sprintf("%s-v%d", tc.lineage, tc.version), func(t *testing.T) {
			db := schemaBranchFixture(t, tc.lineage, tc.version)
			var before []schemaMigration
			if err := db.Order("version").Find(&before).Error; err != nil {
				t.Fatal(err)
			}
			// Replaying an already-applied drama revision would cancel this job.
			activeDrama := tc.lineage == "upstream" && tc.version >= 68
			if activeDrama {
				if err := db.Create(&model.DramaProduction{ProjectID: "kept-project", Status: model.DramaStatusRunning, SettingsJSON: `{"storyboard":{"segmentMode":"fixed","segmentSeconds":12}}`}).Error; err != nil {
					t.Fatal(err)
				}
				if err := db.Create(&model.DramaJob{ID: "kept-job", ProjectID: "kept-project", Kind: model.DramaJobSegmentVideo, Status: model.DramaJobQueued, TaskID: "kept-task"}).Error; err != nil {
					t.Fatal(err)
				}
			}
			for attempt := 0; attempt < 2; attempt++ {
				if err := MigrateSchema(db); err != nil {
					t.Fatalf("upgrade attempt %d: %v", attempt, err)
				}
				status, err := ReadSchemaStatus(db)
				if err != nil || !status.Ready || status.Current != 77 || status.Expected != 77 {
					t.Fatalf("schema status: %+v, %v", status, err)
				}
				for _, record := range before {
					var after schemaMigration
					if err := db.First(&after, "version = ?", record.Version).Error; err != nil || record.Name != after.Name || record.Checksum != after.Checksum || !record.AppliedAt.Equal(after.AppliedAt) {
						t.Fatalf("released migration changed: before=%+v after=%+v err=%v", record, after, err)
					}
				}
			}
			want := map[string]int64{
				"drama_production": 66, "drama_shot_segments": 67, "drama_job_attempts": 68,
				"drama_media_release": 69, "drama_shot_transition": 70, "drama_prompt_overrides": 71,
				"drama_segment_production": 72, "drama_segment_revision": 73, "storage_products": 74,
				"resource_offload_jobs": 75, "drama_segment_mode": 76, "referral_center": 77,
			}
			if tc.lineage == "upstream" {
				for name, version := range want {
					want[name] = version - 5
				}
				want["canvas_model3d"] = 73
				want["model3d_base_url"] = 74
				want["model3d_asset_timestamps"] = 75
				want["channel_model_provider_defaults"] = 76
				want["task_provider_progress"] = 77
			} else if tc.lineage == "extended_merged_upstream" {
				want["canvas_model3d"] = 61
				want["model3d_base_url"] = 62
				want["model3d_asset_timestamps"] = 63
				want["channel_model_provider_defaults"] = 64
				want["task_provider_progress"] = 65
			}
			for name, version := range want {
				var record schemaMigration
				if err := db.First(&record, "name = ?", name).Error; err != nil || record.Version != version {
					t.Fatalf("migration %s: %+v, want version %d, err=%v", name, record, version, err)
				}
			}
			for _, table := range Models() {
				if !db.Migrator().HasTable(table) {
					t.Errorf("missing table %T", table)
				}
			}
			if !db.Migrator().HasColumn(&model.ChannelModel{}, "ProviderDefaults") || !db.Migrator().HasColumn(&model.Task{}, "ProviderProgress") {
				t.Fatal("upstream upgrade did not install local columns")
			}
			if activeDrama {
				var production model.DramaProduction
				if err := db.First(&production, "project_id = ?", "kept-project").Error; err != nil || production.Status != model.DramaStatusRunning {
					t.Fatalf("upgrade replayed drama changes: %+v, %v", production, err)
				}
				var job model.DramaJob
				if err := db.First(&job, "id = ?", "kept-job").Error; err != nil || job.Status != model.DramaJobQueued || job.TaskID != "kept-task" {
					t.Fatalf("upgrade changed active drama job: %+v, %v", job, err)
				}
			}
		})
	}
}

func TestDramaMergeRejectsChangedMigrationHistories(t *testing.T) {
	for _, tc := range []struct {
		lineage string
		version int64
		field   string
	}{
		{"local", 65, "checksum"},
		{"extended_merged_upstream", 61, "checksum"},
		{"upstream", 61, "name"},
		{"upstream", 61, "checksum"},
		{"upstream", 69, "checksum"},
		{"upstream", 72, "name"},
	} {
		t.Run(fmt.Sprintf("%s-v%d-%s", tc.lineage, tc.version, tc.field), func(t *testing.T) {
			lastVersion := int64(65)
			if tc.lineage == "upstream" {
				lastVersion = 72
			}
			db := schemaBranchFixture(t, tc.lineage, lastVersion)
			if err := db.Model(&schemaMigration{}).Where("version = ?", tc.version).Update(tc.field, "unknown").Error; err != nil {
				t.Fatal(err)
			}
			var before, after []schemaMigration
			if err := db.Order("version").Find(&before).Error; err != nil {
				t.Fatal(err)
			}
			if err := MigrateSchema(db); err == nil || !strings.Contains(err.Error(), "不一致") {
				t.Fatalf("expected changed history rejection, got %v", err)
			}
			if err := db.Order("version").Find(&after).Error; err != nil || !reflect.DeepEqual(before, after) {
				t.Fatalf("rejected migration changed its ledger: before=%+v after=%+v err=%v", before, after, err)
			}
			if tc.lineage == "upstream" && db.Migrator().HasTable(&model.Model3DSubmission{}) {
				t.Fatal("rejected migration left a new local table")
			}
		})
	}
}

func TestDramaMergeUpgradesExistingPaymentAndUserRows(t *testing.T) {
	db := schemaBranchFixture(t, "local", 65)
	for _, entity := range []any{
		&model.User{ID: "kept-user", Username: "kept-user", PasswordHash: "kept-hash"},
		&model.TopupProduct{ID: "kept-product", Name: "Existing credits", AmountFen: 500, CreditsMicrocredits: 123000},
		&model.PaymentOrder{ID: "kept-order", UserID: "kept-user", AmountFen: 500, CreditsMicrocredits: 123000, Status: model.PaymentOrderCredited},
	} {
		if err := db.Create(entity).Error; err != nil {
			t.Fatal(err)
		}
	}
	for _, field := range []struct {
		entity any
		name   string
	}{
		{&model.User{}, "IsPromoter"},
		{&model.TopupProduct{}, "Kind"},
		{&model.TopupProduct{}, "StorageBytes"},
		{&model.TopupProduct{}, "StorageDurationDays"},
		{&model.PaymentOrder{}, "ProductKind"},
		{&model.PaymentOrder{}, "StorageBytes"},
		{&model.PaymentOrder{}, "StorageDurationDays"},
	} {
		if db.Migrator().HasIndex(field.entity, field.name) {
			if err := db.Migrator().DropIndex(field.entity, field.name); err != nil {
				t.Fatal(err)
			}
		}
		if err := db.Migrator().DropColumn(field.entity, field.name); err != nil {
			t.Fatal(err)
		}
	}
	for attempt := 0; attempt < 2; attempt++ {
		if err := MigrateSchema(db); err != nil {
			t.Fatal(err)
		}
	}
	var user model.User
	if err := db.First(&user, "id = ?", "kept-user").Error; err != nil || user.IsPromoter || user.PasswordHash != "kept-hash" {
		t.Fatalf("existing user changed: %+v, %v", user, err)
	}
	var product model.TopupProduct
	if err := db.First(&product, "id = ?", "kept-product").Error; err != nil || product.Kind != model.TopupProductKindCredits || product.AmountFen != 500 || product.CreditsMicrocredits != 123000 || product.StorageBytes != 0 || product.StorageDurationDays != 0 {
		t.Fatalf("existing product changed: %+v, %v", product, err)
	}
	var order model.PaymentOrder
	if err := db.First(&order, "id = ?", "kept-order").Error; err != nil || order.ProductKind != model.TopupProductKindCredits || order.Status != model.PaymentOrderCredited || order.AmountFen != 500 || order.CreditsMicrocredits != 123000 || order.StorageBytes != 0 || order.StorageDurationDays != 0 {
		t.Fatalf("existing order changed: %+v, %v", order, err)
	}
}
