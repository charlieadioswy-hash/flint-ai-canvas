package database

import (
	"fmt"
	"testing"

	"yingce/backend/internal/model"
)

func TestOctoberMergePreservesReleasedMigrationIdentities(t *testing.T) {
	for _, tc := range []struct {
		lineage string
		version int64
	}{
		{"local", 62},
		{"upstream", 55},
		{"upstream", 56},
		{"upstream", 57},
		{"upstream", 60},
		{"native_merged_upstream", 62},
	} {
		t.Run(fmt.Sprintf("%s-v%d", tc.lineage, tc.version), func(t *testing.T) {
			db := schemaBranchFixture(t, tc.lineage, tc.version)
			var before []schemaMigration
			if err := db.Order("version").Find(&before).Error; err != nil {
				t.Fatal(err)
			}
			if err := db.Exec(`INSERT INTO tasks (id, status, progress, result_json) VALUES ('kept-task', 'running', 35, '{"resourceId":"kept-resource"}')`).Error; err != nil {
				t.Fatal(err)
			}
			for attempt := 0; attempt < 2; attempt++ {
				if err := MigrateSchema(db); err != nil {
					t.Fatalf("upgrade attempt %d: %v", attempt, err)
				}
				if err := RequireSchemaVersion(db); err != nil {
					t.Fatalf("verify attempt %d: %v", attempt, err)
				}
				status, err := ReadSchemaStatus(db)
				if err != nil || !status.Ready || status.Current != CurrentSchemaVersion {
					t.Fatalf("schema status: %+v, %v", status, err)
				}
			}
			for _, record := range before {
				var after schemaMigration
				if err := db.First(&after, "version = ?", record.Version).Error; err != nil || record.Name != after.Name || record.Checksum != after.Checksum || !record.AppliedAt.Equal(after.AppliedAt) {
					t.Fatalf("released migration changed: before=%+v after=%+v err=%v", record, after, err)
				}
			}
			want := map[string]int64{
				"canvas_model3d": 45, "model3d_base_url": 49, "model3d_asset_timestamps": 50,
				"channel_model_provider_defaults": 51, "task_provider_progress": 62,
				"agent_memory_proposals": 63, "channel_model_protocol_length": 64, "user_feedbacks": 65,
			}
			if tc.lineage == "upstream" {
				want = map[string]int64{
					"agent_memory_proposals": 58, "channel_model_protocol_length": 59, "user_feedbacks": 60,
					"canvas_model3d": 61, "model3d_base_url": 62, "model3d_asset_timestamps": 63,
					"channel_model_provider_defaults": 64, "task_provider_progress": 65,
				}
			} else if tc.lineage == "native_merged_upstream" {
				want["canvas_model3d"] = 58
				want["model3d_base_url"] = 59
				want["model3d_asset_timestamps"] = 60
				want["channel_model_provider_defaults"] = 61
			}
			for name, version := range want {
				var record schemaMigration
				if err := db.First(&record, "name = ?", name).Error; err != nil || record.Version != version {
					t.Fatalf("migration %s: %+v, want version %d, err=%v", name, record, version, err)
				}
			}
			for _, table := range []any{&model.AgentMemoryProposal{}, &model.AgentMemoryRevision{}, &model.UserFeedback{}, &model.Model3DSubmission{}} {
				if !db.Migrator().HasTable(table) {
					t.Fatalf("upgrade did not create %T", table)
				}
			}
			if !db.Migrator().HasColumn(&model.AgentMemorySetting{}, "CompactProposalID") || !db.Migrator().HasColumn(&model.AgentMemorySetting{}, "CompactCursor") || !db.Migrator().HasColumn(&model.ChannelModel{}, "ProviderDefaults") {
				t.Fatal("upgrade did not restore memory and provider-default columns")
			}
			var kept model.Task
			if err := db.First(&kept, "id = ?", "kept-task").Error; err != nil || kept.Progress != 35 || kept.ProviderProgress != nil || kept.ResultJSON != `{"resourceId":"kept-resource"}` {
				t.Fatalf("upgrade changed existing task: %+v, %v", kept, err)
			}
		})
	}
}

func TestOctoberMergeRejectsUnknownUpstreamTail(t *testing.T) {
	for _, field := range []string{"name", "checksum"} {
		t.Run(field, func(t *testing.T) {
			db := schemaBranchFixture(t, "upstream", 60)
			if err := db.Model(&schemaMigration{}).Where("version = ?", 58).Update(field, "unknown").Error; err != nil {
				t.Fatal(err)
			}
			if err := MigrateSchema(db); err == nil {
				t.Fatal("accepted an unknown upstream migration identity")
			}
			var count int64
			if err := db.Model(&schemaMigration{}).Where("version > ?", 60).Count(&count).Error; err != nil || count != 0 {
				t.Fatalf("rejected migration advanced the ledger: %d, %v", count, err)
			}
			if db.Migrator().HasTable(&model.Model3DSubmission{}) {
				t.Fatal("rejected migration left a new 3D table")
			}
		})
	}
}
