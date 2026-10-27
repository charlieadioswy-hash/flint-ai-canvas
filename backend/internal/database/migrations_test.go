package database

import (
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"yingce/backend/internal/model"

	"gorm.io/gorm"
)

func TestCurrentSchemaVersionMatchesMigrationPlan(t *testing.T) {
	if len(schemaMigrations) == 0 {
		t.Fatal("migration plan is empty")
	}
	latest := schemaMigrations[len(schemaMigrations)-1].version
	if CurrentSchemaVersion != latest {
		t.Fatalf("supported schema version %d does not match latest migration %d", CurrentSchemaVersion, latest)
	}
	for index, item := range schemaMigrations {
		if item.version != int64(index+1) {
			t.Fatalf("migration %s has version %d, want %d", item.name, item.version, index+1)
		}
	}
}

type channelModelProtocolV58 struct {
	ID       string `gorm:"primaryKey;size:36"`
	Protocol string `gorm:"size:32;index"`
}

func (channelModelProtocolV58) TableName() string { return "channel_models" }

func TestMigrateChannelModelProtocolLengthPreservesExistingRows(t *testing.T) {
	db, err := Open(Config{Driver: "sqlite", DSN: "file:migration-channel-protocol-length?mode=memory&cache=shared"})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&channelModelProtocolV58{}); err != nil {
		t.Fatal(err)
	}
	legacy := channelModelProtocolV58{ID: "existing", Protocol: "chat-completion"}
	if err := db.Create(&legacy).Error; err != nil {
		t.Fatal(err)
	}
	if err := migrateChannelModelProtocolLength(db); err != nil {
		t.Fatalf("migrateChannelModelProtocolLength() error = %v", err)
	}
	statement := &gorm.Statement{DB: db}
	if err := statement.Parse(&model.ChannelModel{}); err != nil {
		t.Fatal(err)
	}
	protocolField := statement.Schema.LookUpField("Protocol")
	if protocolField == nil || protocolField.Size != 64 {
		t.Fatalf("protocol field size = %#v, want 64", protocolField)
	}
	var stored struct {
		Protocol string
	}
	if err := db.Table("channel_models").Select("protocol").Where("id = ?", legacy.ID).Scan(&stored).Error; err != nil {
		t.Fatal(err)
	}
	if stored.Protocol != legacy.Protocol {
		t.Fatalf("existing protocol = %q, want %q", stored.Protocol, legacy.Protocol)
	}
}

func TestMigrateSchemaRecordsAndValidatesVersion(t *testing.T) {
	db, err := Open(Config{Driver: "sqlite", DSN: "file:migration-version?mode=memory&cache=shared"})
	if err != nil {
		t.Fatal(err)
	}
	if err := MigrateSchema(db); err != nil {
		t.Fatal(err)
	}
	status, err := ReadSchemaStatus(db)
	if err != nil {
		t.Fatal(err)
	}
	if !status.Ready || status.Current != CurrentSchemaVersion {
		t.Fatalf("unexpected schema status: %#v", status)
	}
	if !db.Migrator().HasTable(&model.UploadReservation{}) {
		t.Fatal("upload reservation migration missing")
	}
	if !db.Migrator().HasTable(&model.WorkbenchTool{}) || !db.Migrator().HasTable(&model.WorkbenchPreset{}) {
		t.Fatal("schema migration v58 did not create workbench tool and preset tables")
	}
	if !db.Migrator().HasIndex(&model.WorkbenchTool{}, "idx_workbench_tools_kind_enabled_sort") {
		t.Fatal("schema migration v58 did not create the workbench catalog index")
	}
	if !db.Migrator().HasIndex(&model.WorkbenchPreset{}, "idx_workbench_presets_tool_enabled_sort") {
		t.Fatal("schema migration v58 did not create the workbench preset index")
	}
	if !db.Migrator().HasIndex(&schemaMigration{}, "idx_schema_migrations_applied_at") {
		t.Fatal("schema migration v2 did not create the applied_at index")
	}
	if !db.Migrator().HasIndex(&model.ProjectAssetCandidate{}, "idx_project_asset_candidates_pending_identity") {
		t.Fatal("schema migration v3 did not create candidate identity index")
	}
	if !db.Migrator().HasTable(&model.AgentProfile{}) || !db.Migrator().HasIndex(&model.AgentProfile{}, "idx_agent_profiles_scope") {
		t.Fatal("schema migration v15 did not create scoped Agent profiles")
	}
	if !db.Migrator().HasTable(&model.AgentLesson{}) || !db.Migrator().HasIndex(&model.AgentLesson{}, "idx_agent_lessons_status") {
		t.Fatal("schema migration v16 did not create Agent lessons")
	}
	if !db.Migrator().HasIndex(&model.AgentLesson{}, "idx_agent_lessons_author_status") {
		t.Fatal("schema migration v17 did not create owner status index")
	}
	if !db.Migrator().HasTable(&model.AgentMemorySetting{}) {
		t.Fatal("schema migration v18 did not create agent memory settings")
	}
	if !db.Migrator().HasColumn(&model.PaymentProviderConfig{}, "plugin_version") || !db.Migrator().HasColumn(&model.PaymentOrder{}, "plugin_version") {
		t.Fatal("schema migration v19 did not add payment plugin version columns")
	}
	if !db.Migrator().HasTable(&model.BannerAnnouncement{}) {
		t.Fatal("schema migration v20 did not create banner announcements")
	}
	if !db.Migrator().HasColumn(&model.BannerAnnouncement{}, "title_runs") {
		t.Fatal("schema migration v21 did not create banner announcements title_runs")
	}
	if !db.Migrator().HasColumn(&model.BannerAnnouncement{}, "notice_type") {
		t.Fatal("schema migration v22 did not create banner announcements notice_type")
	}
	if !db.Migrator().HasTable(&model.AuthVerification{}) ||
		!db.Migrator().HasTable(&model.NotificationQuota{}) ||
		!db.Migrator().HasTable(&model.SMSChannel{}) ||
		!db.Migrator().HasTable(&model.SMSRecord{}) {
		t.Fatal("schema migration v35 did not create auth notification tables")
	}
	if !db.Migrator().HasColumn(&model.User{}, "phone") ||
		!db.Migrator().HasColumn(&model.User{}, "email_verified_at") ||
		!db.Migrator().HasColumn(&model.User{}, "phone_verified_at") ||
		!db.Migrator().HasColumn(&model.EmailVerificationCode{}, "attempts") {
		t.Fatal("schema migration v35 did not add authentication verification fields")
	}
	if !db.Migrator().HasTable(&model.CloudAgentGeminiCache{}) {
		t.Fatal("schema migration v36 did not create Gemini cache table")
	}
	if err := MigrateSchema(db); err != nil {
		t.Fatalf("migration should be idempotent: %v", err)
	}
}

func TestMigrateSchemaSQLPerformanceIndexes(t *testing.T) {
	db, err := Open(Config{Driver: "sqlite", DSN: "file:migration-sql-perf-v56?mode=memory&cache=shared"})
	if err != nil {
		t.Fatal(err)
	}
	if err := MigrateSchema(db); err != nil {
		t.Fatal(err)
	}
	var catalogMigration schemaMigration
	if err := db.First(&catalogMigration, "name = ?", "provider_catalog_source").Error; err != nil {
		t.Fatal(err)
	}
	if catalogMigration.Name != "provider_catalog_source" || catalogMigration.Checksum != "sha256:provider-catalog-source-v55" {
		t.Fatalf("provider catalog migration identity changed: %#v", catalogMigration)
	}
	for _, item := range []struct {
		entity any
		index  string
	}{
		{&model.ApiCallLog{}, "idx_api_logs_created_epoch"},
		{&model.ApiCallLog{}, "idx_api_logs_user_created"},
		{&model.Task{}, "idx_tasks_created_epoch"},
		{&model.Task{}, "idx_tasks_user_project_created"},
		{&model.CreditLedgerEntry{}, "idx_credit_ledger_user_type"},
	} {
		if err := db.Migrator().DropIndex(item.entity, item.index); err != nil {
			t.Fatal(err)
		}
	}
	for _, entity := range []any{&model.ApiCallLog{}, &model.Task{}} {
		if err := db.Migrator().DropColumn(entity, "CreatedAtEpoch"); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Where("name = ?", "sql_perf_indexes").Delete(&schemaMigration{}).Error; err != nil {
		t.Fatal(err)
	}
	createdAt := time.Date(2026, 10, 15, 12, 30, 0, 0, time.UTC)
	for _, table := range []string{"api_call_logs", "tasks"} {
		if err := db.Table(table).Create(map[string]any{"id": "legacy-" + table, "created_at": createdAt}).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err := MigrateSchema(db); err != nil {
		t.Fatalf("upgrade from provider catalog v55: %v", err)
	}
	for _, table := range []string{"api_call_logs", "tasks"} {
		var epoch int64
		if err := db.Table(table).Select("created_at_epoch").Where("id = ?", "legacy-"+table).Scan(&epoch).Error; err != nil {
			t.Fatal(err)
		}
		if epoch != createdAt.Unix() {
			t.Fatalf("%s legacy timestamp = %d, want %d", table, epoch, createdAt.Unix())
		}
	}
	for _, item := range []struct {
		entity any
		index  string
	}{
		{&model.ApiCallLog{}, "idx_api_logs_user_created"},
		{&model.Task{}, "idx_tasks_user_project_created"},
		{&model.CreditLedgerEntry{}, "idx_credit_ledger_user_type"},
	} {
		if !db.Migrator().HasIndex(item.entity, item.index) {
			t.Fatalf("v56 did not restore %s", item.index)
		}
	}
	var after schemaMigration
	if err := db.First(&after, "name = ?", "provider_catalog_source").Error; err != nil {
		t.Fatal(err)
	}
	if after != catalogMigration {
		t.Fatalf("v56 rewrote provider catalog migration: before=%#v after=%#v", catalogMigration, after)
	}
	if !db.Migrator().HasColumn(&model.ModelChannel{}, "CatalogProviderID") || !db.Migrator().HasColumn(&model.ChannelModel{}, "CatalogModelKey") {
		t.Fatal("provider catalog columns missing after v56 upgrade")
	}
	if err := MigrateSchema(db); err != nil {
		t.Fatalf("v56 upgrade should be idempotent: %v", err)
	}
}

func schemaBranchFixture(t *testing.T, lineage string, lastVersion int64) *gorm.DB {
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
	upstreamVersions := map[string]int64{
		"upload_reservations": 45, "channel_proxy_url": 48, "banner_sort_order": 49,
		"canvas_mutation_receipts": 50, "personal_profile_security": 51,
		"user_avatar_presets": 52, "user_login_logs": 53, workbenchToolsMigrationName: 54,
		"provider_catalog_source": 55, "sql_perf_indexes": 56, "canvas_multi_session_sync": 57,
		"agent_memory_proposals": 58, "channel_model_protocol_length": 59, "user_feedbacks": 60,
		"drama_production": 61, "drama_shot_segments": 62, "drama_job_attempts": 63,
		"drama_media_release": 64, "drama_shot_transition": 65, "drama_prompt_overrides": 66,
		"drama_segment_production": 67, "drama_segment_revision": 68, "storage_products": 69,
		"resource_offload_jobs": 70, "drama_segment_mode": 71, "referral_center": 72,
	}
	if lineage != "upstream" {
		for name, version := range upstreamVersions {
			if version >= 61 {
				upstreamVersions[name] = version + 5
			}
		}
	}
	if lineage == "extended_merged_upstream" {
		upstreamVersions["canvas_model3d"] = 61
		upstreamVersions["model3d_base_url"] = 62
		upstreamVersions["model3d_asset_timestamps"] = 63
		upstreamVersions["channel_model_provider_defaults"] = 64
		upstreamVersions["task_provider_progress"] = 65
	}
	if lineage == "native_merged_upstream" {
		upstreamVersions["canvas_model3d"] = 58
		upstreamVersions["model3d_base_url"] = 59
		upstreamVersions["model3d_asset_timestamps"] = 60
		upstreamVersions["channel_model_provider_defaults"] = 61
		upstreamVersions["task_provider_progress"] = 62
		delete(upstreamVersions, "agent_memory_proposals")
		delete(upstreamVersions, "channel_model_protocol_length")
		delete(upstreamVersions, "user_feedbacks")
	}
	if lineage == "merged_upstream" {
		upstreamVersions["canvas_model3d"] = 55
		upstreamVersions["model3d_base_url"] = 56
		upstreamVersions["model3d_asset_timestamps"] = 57
		upstreamVersions["channel_model_provider_defaults"] = 58
		delete(upstreamVersions, "provider_catalog_source")
		delete(upstreamVersions, "sql_perf_indexes")
		delete(upstreamVersions, "canvas_multi_session_sync")
		delete(upstreamVersions, "agent_memory_proposals")
		delete(upstreamVersions, "channel_model_protocol_length")
		delete(upstreamVersions, "user_feedbacks")
	}
	applied := map[string]bool{}
	for _, item := range schemaMigrations {
		switch lineage {
		case "upstream", "legacy_workbench", "merged_upstream", "native_merged_upstream", "extended_merged_upstream":
			if item.version >= 44 && item.version != 46 && item.version != 47 {
				version, ok := upstreamVersions[item.name]
				if !ok {
					continue
				}
				item.version = version
			}
			if lineage == "legacy_workbench" {
				if item.name == "personal_profile_security" {
					continue
				}
				if item.name == workbenchToolsMigrationName {
					item.version = 51
					item.checksum = legacyWorkbenchToolsMigrationChecksum
				}
			}
		case "merged_uploads":
			if item.version == 45 {
				item.version = 48
			} else if item.version == 48 {
				item.version = 45
			}
		}
		if item.version > lastVersion {
			continue
		}
		if err := item.apply(db); err != nil {
			t.Fatal(err)
		}
		if err := db.Create(&schemaMigration{Version: item.version, Name: item.name, Checksum: item.checksum, AppliedAt: time.Date(2026, 10, 5, 0, 0, 0, 0, time.UTC)}).Error; err != nil {
			t.Fatal(err)
		}
		applied[item.name] = true
	}
	// The baseline uses current models; remove structures absent in each actual
	// release so the upgrade must install them, not just add migration records.
	for name, tables := range map[string][]any{
		"image_content_moderation":  {&model.ImageModerationProvider{}, &model.ImageModerationConfig{}, &model.ImageModerationPolicy{}, &model.ImageModerationCheck{}, &model.ImageModerationItem{}, &model.ImageModerationDailyUsage{}},
		"canvas_model3d":            {&model.Model3DProvider{}, &model.Model3DConfig{}, &model.Model3DPolicy{}, &model.Model3DSubmission{}, &model.Model3DDailyUsage{}},
		"canvas_mutation_receipts":  {&model.CanvasMutationReceipt{}},
		"personal_profile_security": {&model.UserAvatar{}},
		"user_login_logs":           {&model.LoginLog{}},
		workbenchToolsMigrationName: {&model.WorkbenchPreset{}, &model.WorkbenchTool{}},
		"agent_memory_proposals":    {&model.AgentMemoryProposal{}, &model.AgentMemoryRevision{}},
		"user_feedbacks":            {&model.UserFeedback{}},
		"drama_production":          {&model.DramaProduction{}, &model.DramaCast{}, &model.DramaEpisode{}, &model.DramaShot{}, &model.DramaTake{}, &model.DramaJob{}},
		"drama_prompt_overrides":    {&model.DramaSegment{}},
		"storage_products":          {&model.UserStorageGrant{}, &model.UserStorageState{}},
		"resource_offload_jobs":     {&model.ResourceOffloadJob{}},
		"referral_center":           {&model.ReferralProfile{}, &model.ReferralBinding{}, &model.ReferralCommission{}},
	} {
		if !applied[name] {
			for _, table := range tables {
				if err := db.Migrator().DropTable(table); err != nil {
					t.Fatal(err)
				}
			}
		}
	}
	for _, column := range []struct {
		migration string
		model     any
		field     string
	}{
		{"channel_proxy_url", &model.ModelChannel{}, "ProxyURL"},
		{"channel_model_provider_defaults", &model.ChannelModel{}, "ProviderDefaults"},
		{"user_avatar_presets", &model.User{}, "AvatarPreset"},
		{"provider_catalog_source", &model.ModelChannel{}, "CatalogProviderID"},
		{"provider_catalog_source", &model.ChannelModel{}, "CatalogModelKey"},
		{"task_provider_progress", &model.Task{}, "ProviderProgress"},
		{"agent_memory_proposals", &model.AgentMemorySetting{}, "CompactProposalID"},
		{"agent_memory_proposals", &model.AgentMemorySetting{}, "CompactCursor"},
	} {
		if !applied[column.migration] {
			if err := db.Migrator().DropColumn(column.model, column.field); err != nil {
				t.Fatal(err)
			}
		}
	}
	return db
}

func TestMigrateSchemaPreservesReleasedBranchHistories(t *testing.T) {
	for _, tc := range []struct {
		lineage string
		version int64
	}{
		{"local", 51}, {"local", 58}, {"merged_uploads", 51}, {"merged_uploads", 58},
		{"upstream", 48}, {"upstream", 49}, {"upstream", 50}, {"upstream", 51},
		{"upstream", 54}, {"upstream", 55}, {"upstream", 56}, {"upstream", 57},
		{"merged_upstream", 58}, {"legacy_workbench", 51},
	} {
		t.Run(fmt.Sprintf("%s-v%d", tc.lineage, tc.version), func(t *testing.T) {
			db := schemaBranchFixture(t, tc.lineage, tc.version)
			var before []schemaMigration
			if err := db.Order("version").Find(&before).Error; err != nil {
				t.Fatal(err)
			}
			for attempt := 0; attempt < 2; attempt++ {
				if err := MigrateSchema(db); err != nil {
					t.Fatal(err)
				}
				status, err := ReadSchemaStatus(db)
				if err != nil || !status.Ready || status.Current != CurrentSchemaVersion {
					t.Fatalf("schema status: %+v, %v", status, err)
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
			if !db.Migrator().HasColumn(&model.ModelChannel{}, "ProxyURL") || !db.Migrator().HasColumn(&model.ChannelModel{}, "ProviderDefaults") || !db.Migrator().HasColumn(&model.User{}, "AvatarPreset") {
				t.Fatal("branch upgrade did not restore new columns")
			}
			if !db.Migrator().HasColumn(&model.ModelChannel{}, "CatalogProviderID") || !db.Migrator().HasColumn(&model.ChannelModel{}, "CatalogModelKey") {
				t.Fatal("branch upgrade did not restore provider catalog columns")
			}
		})
	}
}

func TestMigrateSchemaRejectsChangedUpstreamHistory(t *testing.T) {
	for _, tc := range []struct {
		version int64
		field   string
	}{{48, "name"}, {48, "checksum"}, {51, "checksum"}, {54, "name"}} {
		t.Run(fmt.Sprintf("v%d-%s", tc.version, tc.field), func(t *testing.T) {
			db := schemaBranchFixture(t, "upstream", 54)
			if err := db.Model(&schemaMigration{}).Where("version = ?", tc.version).Update(tc.field, "unknown").Error; err != nil {
				t.Fatal(err)
			}
			if err := MigrateSchema(db); err == nil || !strings.Contains(err.Error(), "不一致") {
				t.Fatalf("expected corrupt history rejection, got %v", err)
			}
			var count int64
			if err := db.Model(&schemaMigration{}).Where("version = 44 OR version > 54").Count(&count).Error; err != nil || count != 0 {
				t.Fatalf("rejected migration wrote records: %d, %v", count, err)
			}
			if db.Migrator().HasTable(&model.ImageModerationProvider{}) || db.Migrator().HasTable(&model.Model3DProvider{}) {
				t.Fatal("rejected migration left new tables")
			}
		})
	}
}

func TestMigrateSchemaV35UpgradesExistingDatabase(t *testing.T) {
	db, err := Open(Config{Driver: "sqlite", DSN: "file:migration-auth-notifications-v35?mode=memory&cache=shared"})
	if err != nil {
		t.Fatal(err)
	}
	if err := MigrateSchema(db); err != nil {
		t.Fatal(err)
	}

	for _, table := range []any{&model.AuthVerification{}, &model.NotificationQuota{}, &model.SMSChannel{}, &model.SMSRecord{}} {
		if err := db.Migrator().DropTable(table); err != nil {
			t.Fatal(err)
		}
	}
	for _, column := range []string{"phone", "email_verified_at", "phone_verified_at"} {
		if err := db.Migrator().DropColumn(&model.User{}, column); err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Migrator().DropColumn(&model.EmailVerificationCode{}, "attempts"); err != nil {
		t.Fatal(err)
	}
	if err := db.Where("version = ?", 35).Delete(&schemaMigration{}).Error; err != nil {
		t.Fatal(err)
	}

	if err := MigrateSchema(db); err != nil {
		t.Fatalf("upgrade from v34: %v", err)
	}
	for _, table := range []any{&model.AuthVerification{}, &model.NotificationQuota{}, &model.SMSChannel{}, &model.SMSRecord{}} {
		if !db.Migrator().HasTable(table) {
			t.Fatalf("migration v35 did not restore table %T", table)
		}
	}
	for _, column := range []string{"phone", "email_verified_at", "phone_verified_at"} {
		if !db.Migrator().HasColumn(&model.User{}, column) {
			t.Fatalf("migration v35 did not restore users.%s", column)
		}
	}
	if !db.Migrator().HasColumn(&model.EmailVerificationCode{}, "attempts") {
		t.Fatal("migration v35 did not restore email verification attempts")
	}
}

func TestMigrateSchemaV15UpgradesExistingDatabase(t *testing.T) {
	db, err := Open(Config{Driver: "sqlite", DSN: "file:migration-agent-profiles-v15?mode=memory&cache=shared"})
	if err != nil {
		t.Fatal(err)
	}
	if err := MigrateSchema(db); err != nil {
		t.Fatal(err)
	}
	if err := db.Migrator().DropTable(&model.AgentProfile{}); err != nil {
		t.Fatal(err)
	}
	if err := db.Where("version = ?", 15).Delete(&schemaMigration{}).Error; err != nil {
		t.Fatal(err)
	}
	if err := MigrateSchema(db); err != nil {
		t.Fatalf("upgrade from v14: %v", err)
	}
	if !db.Migrator().HasTable(&model.AgentProfile{}) || !db.Migrator().HasIndex(&model.AgentProfile{}, "idx_agent_profiles_scope") {
		t.Fatal("v15 upgrade did not install Agent profile table and scope index")
	}
	status, err := ReadSchemaStatus(db)
	if err != nil || !status.Ready || status.Current != CurrentSchemaVersion {
		t.Fatalf("unexpected upgraded schema status: %+v, %v", status, err)
	}
}

func TestMigrateSchemaV16UpgradesExistingDatabase(t *testing.T) {
	db, err := Open(Config{Driver: "sqlite", DSN: "file:migration-agent-lessons-v16?mode=memory&cache=shared"})
	if err != nil {
		t.Fatal(err)
	}
	if err := MigrateSchema(db); err != nil {
		t.Fatal(err)
	}
	if err := db.Migrator().DropTable(&model.AgentLesson{}); err != nil {
		t.Fatal(err)
	}
	if err := db.Where("version = ?", 16).Delete(&schemaMigration{}).Error; err != nil {
		t.Fatal(err)
	}
	if err := MigrateSchema(db); err != nil {
		t.Fatalf("upgrade from v15: %v", err)
	}
	if !db.Migrator().HasTable(&model.AgentLesson{}) || !db.Migrator().HasIndex(&model.AgentLesson{}, "idx_agent_lessons_status") {
		t.Fatal("v16 upgrade did not install Agent lesson table and status index")
	}
	status, err := ReadSchemaStatus(db)
	if err != nil || !status.Ready || status.Current != CurrentSchemaVersion {
		t.Fatalf("unexpected upgraded schema status: %+v, %v", status, err)
	}
}

func TestMigrateSchemaV17UpgradesExistingDatabase(t *testing.T) {
	db, err := Open(Config{Driver: "sqlite", DSN: "file:migration-agent-lessons-v17?mode=memory&cache=shared"})
	if err != nil {
		t.Fatal(err)
	}
	if err := MigrateSchema(db); err != nil {
		t.Fatal(err)
	}
	if err := db.Migrator().DropIndex(&model.AgentLesson{}, "idx_agent_lessons_author_status"); err != nil {
		t.Fatal(err)
	}
	if err := db.Where("version = ?", 17).Delete(&schemaMigration{}).Error; err != nil {
		t.Fatal(err)
	}
	if err := MigrateSchema(db); err != nil {
		t.Fatalf("upgrade from v16: %v", err)
	}
	if !db.Migrator().HasIndex(&model.AgentLesson{}, "idx_agent_lessons_author_status") {
		t.Fatal("v17 upgrade did not install owner status index")
	}
	status, err := ReadSchemaStatus(db)
	if err != nil || !status.Ready || status.Current != CurrentSchemaVersion {
		t.Fatalf("unexpected upgraded schema status: %+v, %v", status, err)
	}
}

func TestMigrateSchemaV18UpgradesExistingDatabase(t *testing.T) {
	db, err := Open(Config{Driver: "sqlite", DSN: "file:migration-agent-memory-settings-v18?mode=memory&cache=shared"})
	if err != nil {
		t.Fatal(err)
	}
	if err := MigrateSchema(db); err != nil {
		t.Fatal(err)
	}
	if err := db.Migrator().DropTable(&model.AgentMemorySetting{}); err != nil {
		t.Fatal(err)
	}
	if err := db.Where("version = ?", 18).Delete(&schemaMigration{}).Error; err != nil {
		t.Fatal(err)
	}
	if err := MigrateSchema(db); err != nil {
		t.Fatalf("upgrade from v17: %v", err)
	}
	if !db.Migrator().HasTable(&model.AgentMemorySetting{}) {
		t.Fatal("v18 upgrade did not install agent memory settings")
	}
	status, err := ReadSchemaStatus(db)
	if err != nil || !status.Ready || status.Current != CurrentSchemaVersion {
		t.Fatalf("unexpected upgraded schema status: %+v, %v", status, err)
	}
}

func TestMigrateSchemaV19AddsPaymentPluginVersion(t *testing.T) {
	db, err := Open(Config{Driver: "sqlite", DSN: "file:migration-payment-plugin-version-v19?mode=memory&cache=shared"})
	if err != nil {
		t.Fatal(err)
	}
	if err := MigrateSchema(db); err != nil {
		t.Fatal(err)
	}
	if err := db.Migrator().DropColumn(&model.PaymentProviderConfig{}, "PluginVersion"); err != nil {
		t.Fatal(err)
	}
	if err := db.Migrator().DropColumn(&model.PaymentOrder{}, "PluginVersion"); err != nil {
		t.Fatal(err)
	}
	if err := db.Where("version = ?", 19).Delete(&schemaMigration{}).Error; err != nil {
		t.Fatal(err)
	}
	if err := MigrateSchema(db); err != nil {
		t.Fatalf("upgrade from v18: %v", err)
	}
	if !db.Migrator().HasColumn(&model.PaymentProviderConfig{}, "plugin_version") {
		t.Fatal("v19 upgrade did not add payment_provider_configs.plugin_version")
	}
	if !db.Migrator().HasColumn(&model.PaymentOrder{}, "plugin_version") {
		t.Fatal("v19 upgrade did not add payment_orders.plugin_version")
	}
	status, err := ReadSchemaStatus(db)
	if err != nil || !status.Ready || status.Current != CurrentSchemaVersion {
		t.Fatalf("unexpected upgraded schema status: %+v, %v", status, err)
	}
}

func TestMigrateSchemaV20UpgradesExistingDatabaseWithBannerAnnouncements(t *testing.T) {
	db, err := Open(Config{Driver: "sqlite", DSN: "file:migration-banner-announcements-v20?mode=memory&cache=shared"})
	if err != nil {
		t.Fatal(err)
	}
	if err := MigrateSchema(db); err != nil {
		t.Fatal(err)
	}
	if !db.Migrator().HasTable(&model.BannerAnnouncement{}) {
		t.Fatal("v20 migration did not create banner_announcements table")
	}
	// 模拟旧库升级：删表 + 删除 v20 记录，重跑迁移应能重建。
	if err := db.Migrator().DropTable(&model.BannerAnnouncement{}); err != nil {
		t.Fatal(err)
	}
	if err := db.Where("version = ?", 20).Delete(&schemaMigration{}).Error; err != nil {
		t.Fatal(err)
	}
	if err := MigrateSchema(db); err != nil {
		t.Fatalf("upgrade from v19: %v", err)
	}
	if !db.Migrator().HasTable(&model.BannerAnnouncement{}) {
		t.Fatal("v20 upgrade did not reinstall banner_announcements table")
	}
	status, err := ReadSchemaStatus(db)
	if err != nil || !status.Ready || status.Current != CurrentSchemaVersion {
		t.Fatalf("unexpected upgraded schema status: %+v, %v", status, err)
	}
}

func TestMigrateSchemaV21AddsBannerAnnouncementTitleRuns(t *testing.T) {
	db, err := Open(Config{Driver: "sqlite", DSN: "file:migration-banner-title-runs-v21?mode=memory&cache=shared"})
	if err != nil {
		t.Fatal(err)
	}
	if err := MigrateSchema(db); err != nil {
		t.Fatal(err)
	}
	if !db.Migrator().HasColumn(&model.BannerAnnouncement{}, "title_runs") {
		t.Fatal("v21 migration did not add banner_announcements.title_runs")
	}
	legacy := &model.BannerAnnouncement{ID: "legacy-banner", Title: "旧库通知", Status: "active"}
	if err := db.Create(legacy).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Migrator().DropColumn(&model.BannerAnnouncement{}, "title_runs"); err != nil {
		t.Fatal(err)
	}
	if err := db.Where("version = ?", 21).Delete(&schemaMigration{}).Error; err != nil {
		t.Fatal(err)
	}
	if err := MigrateSchema(db); err != nil {
		t.Fatalf("upgrade from v20: %v", err)
	}
	if !db.Migrator().HasColumn(&model.BannerAnnouncement{}, "title_runs") {
		t.Fatal("v21 upgrade did not restore banner_announcements.title_runs")
	}
	var stored model.BannerAnnouncement
	if err := db.First(&stored, "id = ?", "legacy-banner").Error; err != nil {
		t.Fatal(err)
	}
	if stored.Title != "旧库通知" {
		t.Fatalf("legacy banner lost during upgrade: %+v", stored)
	}
	status, err := ReadSchemaStatus(db)
	if err != nil || !status.Ready || status.Current != CurrentSchemaVersion {
		t.Fatalf("unexpected upgraded schema status: %+v, %v", status, err)
	}
}

func TestMigrateSchemaV22AddsBannerAnnouncementNoticeType(t *testing.T) {
	db, err := Open(Config{Driver: "sqlite", DSN: "file:migration-banner-notice-type-v22?mode=memory&cache=shared"})
	if err != nil {
		t.Fatal(err)
	}
	if err := MigrateSchema(db); err != nil {
		t.Fatal(err)
	}
	if !db.Migrator().HasColumn(&model.BannerAnnouncement{}, "notice_type") {
		t.Fatal("v22 migration did not add banner_announcements.notice_type")
	}
	legacy := &model.BannerAnnouncement{ID: "legacy-banner-v21", Title: "旧库通知", TitleRunsJSON: `[{"text":"旧库通知"}]`, Status: "active"}
	if err := db.Create(legacy).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Migrator().DropColumn(&model.BannerAnnouncement{}, "notice_type"); err != nil {
		t.Fatal(err)
	}
	if err := db.Where("version = ?", 22).Delete(&schemaMigration{}).Error; err != nil {
		t.Fatal(err)
	}
	if err := MigrateSchema(db); err != nil {
		t.Fatalf("upgrade from v21: %v", err)
	}
	if !db.Migrator().HasColumn(&model.BannerAnnouncement{}, "notice_type") {
		t.Fatal("v22 upgrade did not restore banner_announcements.notice_type")
	}
	var stored model.BannerAnnouncement
	if err := db.First(&stored, "id = ?", "legacy-banner-v21").Error; err != nil {
		t.Fatal(err)
	}
	if stored.Title != "旧库通知" || stored.TitleRunsJSON != `[{"text":"旧库通知"}]` {
		t.Fatalf("legacy banner lost during upgrade: %+v", stored)
	}
	status, err := ReadSchemaStatus(db)
	if err != nil || !status.Ready || status.Current != CurrentSchemaVersion {
		t.Fatalf("unexpected upgraded schema status: %+v, %v", status, err)
	}
}

func TestMigrateSchemaV23BackfillsCanvasRevisions(t *testing.T) {
	db, err := Open(Config{Driver: "sqlite", DSN: "file:migration-canvas-revisions-v23?mode=memory&cache=shared"})
	if err != nil {
		t.Fatal(err)
	}
	if err := MigrateSchema(db); err != nil {
		t.Fatal(err)
	}
	if err := db.Migrator().DropTable(&model.CanvasSnapshotResource{}, &model.CanvasSnapshot{}); err != nil {
		t.Fatal(err)
	}
	if err := db.Migrator().DropColumn(&model.CanvasProject{}, "Revision"); err != nil {
		t.Fatal(err)
	}
	if err := db.Exec(`INSERT INTO canvas_projects (id, user_id, title, payload_json) VALUES ('legacy', 'owner', 'Existing canvas', '{"nodes":[]}')`).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Where("version = ?", 23).Delete(&schemaMigration{}).Error; err != nil {
		t.Fatal(err)
	}
	if err := MigrateSchema(db); err != nil {
		t.Fatal(err)
	}
	var project model.CanvasProject
	if err := db.First(&project, "id = ?", "legacy").Error; err != nil {
		t.Fatal(err)
	}
	if project.Revision != 1 || project.PayloadJSON != `{"nodes":[]}` {
		t.Fatalf("legacy canvas changed: %+v", project)
	}
	if !db.Migrator().HasTable(&model.CanvasSnapshot{}) || !db.Migrator().HasTable(&model.CanvasSnapshotResource{}) {
		t.Fatal("history tables missing")
	}
	if err := MigrateSchema(db); err != nil {
		t.Fatalf("migration not idempotent: %v", err)
	}
}

func TestMigrateSchemaV8AllowsReusingArchivedLogicalModelCode(t *testing.T) {
	db, err := Open(Config{Driver: "sqlite", DSN: "file:migration-logical-model-active-code?mode=memory&cache=shared"})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Exec(`CREATE TABLE logical_models (id text PRIMARY KEY, code text NOT NULL, archived_at datetime)`).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Exec(`CREATE UNIQUE INDEX idx_logical_models_code ON logical_models(code)`).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Exec(`INSERT INTO logical_models(id, code, archived_at) VALUES ('archived', 'gpt-image-2', CURRENT_TIMESTAMP)`).Error; err != nil {
		t.Fatal(err)
	}
	if err := migrateSchemaV8(db); err != nil {
		t.Fatal(err)
	}
	if err := db.Exec(`INSERT INTO logical_models(id, code, archived_at) VALUES ('active', 'gpt-image-2', NULL)`).Error; err != nil {
		t.Fatalf("reusing archived code after migration: %v", err)
	}
	if err := db.Exec(`INSERT INTO logical_models(id, code, archived_at) VALUES ('duplicate', 'gpt-image-2', NULL)`).Error; err == nil {
		t.Fatal("active logical model code must remain unique")
	}
}

func TestMigrateSchemaV12AddsAgentTokenChargeLimit(t *testing.T) {
	db, err := Open(Config{Driver: "sqlite", DSN: "file:migration-agent-token-charge-limit?mode=memory&cache=shared"})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Exec(`CREATE TABLE billing_orders (id text PRIMARY KEY)`).Error; err != nil {
		t.Fatal(err)
	}
	if err := migrateSchemaV12(db); err != nil {
		t.Fatal(err)
	}
	if !db.Migrator().HasColumn(&model.BillingOrder{}, "ChargeLimitMicrocredits") {
		t.Fatal("migration v12 did not add Agent token charge limit")
	}
}

func TestMigrateSchemaRejectsChecksumMismatch(t *testing.T) {
	db, err := Open(Config{Driver: "sqlite", DSN: "file:migration-checksum?mode=memory&cache=shared"})
	if err != nil {
		t.Fatal(err)
	}
	if err := MigrateSchema(db); err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&schemaMigration{}).Where("version = ?", CurrentSchemaVersion).Update("checksum", "changed").Error; err != nil {
		t.Fatal(err)
	}
	if err := MigrateSchema(db); err == nil || !strings.Contains(err.Error(), "校验和不一致") {
		t.Fatalf("expected checksum mismatch, got %v", err)
	}
	if err := RequireSchemaVersion(db); err == nil || !strings.Contains(err.Error(), "校验和不一致") {
		t.Fatalf("schema verification must reject checksum mismatch, got %v", err)
	}
}

func TestMigrateSchemaV3NormalizesLegacyAccessoryCategory(t *testing.T) {
	db, err := Open(Config{Driver: "sqlite", DSN: "file:migration-asset-taxonomy?mode=memory&cache=shared"})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.Asset{}, &model.ProjectAssetCandidate{}); err != nil {
		t.Fatal(err)
	}
	asset := model.Asset{ID: "asset-1", UserID: "user-1", Kind: "image", Category: model.AssetCategory("accessory"), Title: "旧配饰"}
	candidate := model.ProjectAssetCandidate{ID: "candidate-1", ProjectID: "project-1", Name: "旧配饰候选", Category: model.AssetCategory("accessory"), Status: "pending_confirmation"}
	if err := db.Create(&asset).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&candidate).Error; err != nil {
		t.Fatal(err)
	}
	if err := migrateSchemaV3(db); err != nil {
		t.Fatal(err)
	}
	if err := db.First(&asset, "id = ?", asset.ID).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.First(&candidate, "id = ?", candidate.ID).Error; err != nil {
		t.Fatal(err)
	}
	if asset.Category != model.AssetCategoryProp || candidate.Category != model.AssetCategoryProp {
		t.Fatalf("legacy accessory categories = %q/%q, want prop/prop", asset.Category, candidate.Category)
	}
	if candidate.NameKey != model.AssetCandidateNameKey(candidate.Name) {
		t.Fatalf("candidate name key = %q", candidate.NameKey)
	}
}

func TestMigrateSchemaV4AddsResourceUploadKeyToExistingSchema(t *testing.T) {
	db, err := Open(Config{Driver: "sqlite", DSN: "file:migration-resource-upload-key?mode=memory&cache=shared"})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Exec(`CREATE TABLE resources (id TEXT PRIMARY KEY, user_id TEXT NOT NULL)`).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.ModelChannel{}, &model.ChannelModel{}, &model.ChannelModelPriceTier{}, &model.BillingOrder{}, &model.OAuthState{}); err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&schemaMigration{}); err != nil {
		t.Fatal(err)
	}
	for _, item := range schemaMigrations[:3] {
		if err := db.Create(&schemaMigration{Version: item.version, Name: item.name, Checksum: item.checksum, AppliedAt: time.Now().UTC()}).Error; err != nil {
			t.Fatal(err)
		}
	}

	if err := MigrateSchema(db); err != nil {
		t.Fatalf("migrate existing schema: %v", err)
	}
	if !db.Migrator().HasColumn(&model.Resource{}, "upload_key") {
		t.Fatal("resource upload_key column was not added")
	}
	if !db.Migrator().HasIndex(&model.Resource{}, "idx_resources_user_upload_key") {
		t.Fatal("resource upload key index was not added")
	}
	var status SchemaStatus
	status, err = ReadSchemaStatus(db)
	if err != nil {
		t.Fatal(err)
	}
	if !status.Ready || status.Current != CurrentSchemaVersion {
		t.Fatalf("unexpected schema status: %#v", status)
	}

	firstKey := "same-upload"
	if err := db.Exec(`INSERT INTO resources (id, user_id, upload_key) VALUES (?, ?, ?)`, "resource-1", "user-1", firstKey).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Exec(`INSERT INTO resources (id, user_id, upload_key) VALUES (?, ?, ?)`, "resource-2", "user-1", firstKey).Error; err == nil {
		t.Fatal("duplicate resource upload key should be rejected")
	}
}

func TestMigrateSchemaRepairsLegacyAssetFoldersMigrationOrder(t *testing.T) {
	db, err := Open(Config{Driver: "sqlite", DSN: "file:migration-legacy-v6-order?mode=memory&cache=shared"})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.Resource{}, &model.Asset{}, &model.AssetFolder{}, &model.ModelChannel{}, &model.ChannelModel{}, &model.ChannelModelPriceTier{}, &model.BillingOrder{}, &model.OAuthState{}); err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&schemaMigration{}); err != nil {
		t.Fatal(err)
	}
	for _, item := range schemaMigrations[:5] {
		if err := db.Create(&schemaMigration{Version: item.version, Name: item.name, Checksum: item.checksum, AppliedAt: time.Now().UTC()}).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Create(&schemaMigration{Version: 6, Name: "asset_library_folders", Checksum: assetLibraryFoldersChecksum, AppliedAt: time.Now().UTC()}).Error; err != nil {
		t.Fatal(err)
	}

	if err := MigrateSchema(db); err != nil {
		t.Fatalf("repair legacy migration order: %v", err)
	}
	if !db.Migrator().HasColumn(&model.Resource{}, "playback_status") || !db.Migrator().HasColumn(&model.Resource{}, "playback_object_key") || !db.Migrator().HasColumn(&model.Resource{}, "playback_error") {
		t.Fatal("legacy database did not receive resource playback columns")
	}
	status, err := ReadSchemaStatus(db)
	if err != nil {
		t.Fatal(err)
	}
	if !status.Ready || status.Current != CurrentSchemaVersion {
		t.Fatalf("unexpected repaired schema status: %#v", status)
	}
	var applied schemaMigration
	if err := db.First(&applied, "version = ?", 6).Error; err != nil {
		t.Fatal(err)
	}
	if applied.Name != "asset_library_folders" || applied.Checksum != assetLibraryFoldersChecksum {
		t.Fatalf("historical migration 6 must be preserved: %#v", applied)
	}
	var playback schemaMigration
	if err := db.First(&playback, "version = ?", 7).Error; err != nil {
		t.Fatal(err)
	}
	if playback.Name != "resource_playback_variant" || playback.Checksum != resourcePlaybackChecksum {
		t.Fatalf("migration 7 must supply playback schema: %#v", playback)
	}
}

func TestMigrateSchemaRollsBackFailedMigration(t *testing.T) {
	db, err := Open(Config{Driver: "sqlite", DSN: "file:migration-rollback?mode=memory&cache=shared"})
	if err != nil {
		t.Fatal(err)
	}
	if err := MigrateSchema(db); err != nil {
		t.Fatal(err)
	}

	original := schemaMigrations
	schemaMigrations = append(append([]migration(nil), original...), migration{
		version:  CurrentSchemaVersion + 1,
		name:     "rollback_probe",
		checksum: "sha256:rollback-probe",
		apply: func(tx *gorm.DB) error {
			if err := tx.Exec("CREATE TABLE migration_rollback_probe (id INTEGER PRIMARY KEY)").Error; err != nil {
				return err
			}
			return errors.New("forced migration failure")
		},
	})
	t.Cleanup(func() { schemaMigrations = original })

	if err := MigrateSchema(db); err == nil || !strings.Contains(err.Error(), "forced migration failure") {
		t.Fatalf("expected forced migration failure, got %v", err)
	}
	if db.Migrator().HasTable("migration_rollback_probe") {
		t.Fatal("failed migration left a partial table behind")
	}
	var count int64
	if err := db.Model(&schemaMigration{}).Where("version = ?", CurrentSchemaVersion+1).Count(&count).Error; err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("failed migration was recorded: %d", count)
	}
}

func TestRequireSchemaVersionRejectsUninitializedDatabase(t *testing.T) {
	db, err := Open(Config{Driver: "sqlite", DSN: "file:migration-uninitialized?mode=memory&cache=shared"})
	if err != nil {
		t.Fatal(err)
	}
	if err := RequireSchemaVersion(db); err == nil || !strings.Contains(err.Error(), "请先执行 migrate-schema up") {
		t.Fatalf("expected missing migration error, got %v", err)
	}
}

func TestMigrateSchemaV13AddsCloudAgentCanvasMutation(t *testing.T) {
	db, err := Open(Config{Driver: "sqlite", DSN: "file:migration-cloud-agent-canvas-mutation?mode=memory&cache=shared"})
	if err != nil {
		t.Fatal(err)
	}
	if err := MigrateSchema(db); err != nil {
		t.Fatal(err)
	}
	if !db.Migrator().HasTable(&model.CloudAgentCanvasMutation{}) {
		t.Fatal("migration v13 did not create cloud agent canvas mutation table")
	}
	for _, field := range []string{"RunID", "BeforeSnapshotHash", "AfterSnapshotHash", "BeforeJSON", "HasSubmittedTask", "Status"} {
		if !db.Migrator().HasColumn(&model.CloudAgentCanvasMutation{}, field) {
			t.Fatalf("migration v13 did not add %s", field)
		}
	}
}

func TestMigrateSchemaV30AddsBuiltinTools(t *testing.T) {
	db, err := Open(Config{Driver: "sqlite", DSN: "file:migration-builtin-tools-v30?mode=memory&cache=shared"})
	if err != nil {
		t.Fatal(err)
	}
	if err := MigrateSchema(db); err != nil {
		t.Fatal(err)
	}
	if !db.Migrator().HasTable(&model.Tool{}) {
		t.Fatal("migration v30 did not create tools table")
	}
}

func TestMigrateSchemaV31AddsToolUserActions(t *testing.T) {
	db, err := Open(Config{Driver: "sqlite", DSN: "file:migration-tool-user-actions-v31?mode=memory&cache=shared"})
	if err != nil {
		t.Fatal(err)
	}
	if err := MigrateSchema(db); err != nil {
		t.Fatal(err)
	}
	if !db.Migrator().HasTable(&model.ToolFavorite{}) {
		t.Fatal("migration v31 did not create tool_favorites table")
	}
}

func TestToolsUpgradeFromMain29PreservesMigrationChecksums(t *testing.T) {
	db, err := Open(Config{Driver: "sqlite", DSN: "file:tools-main29-upgrade?mode=memory&cache=shared"})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&schemaMigration{}); err != nil {
		t.Fatal(err)
	}
	for _, item := range schemaMigrations {
		if item.version > 29 {
			break
		}
		if err := item.apply(db); err != nil {
			t.Fatal(err)
		}
		if err := db.Create(&schemaMigration{Version: item.version, Name: item.name, Checksum: item.checksum, AppliedAt: time.Now()}).Error; err != nil {
			t.Fatal(err)
		}
	}
	// The initial migration uses today's model registry; restore the actual v29
	// boundary so this test proves that v30/v31 create the new tables.
	if err := db.Migrator().DropTable(&model.ToolFavorite{}, &model.Tool{}); err != nil {
		t.Fatal(err)
	}
	if db.Migrator().HasTable(&model.Tool{}) || db.Migrator().HasTable(&model.ToolFavorite{}) {
		t.Fatal("tool tables must not exist before upgrading v29")
	}
	for range 2 {
		if err := MigrateSchema(db); err != nil {
			t.Fatal(err)
		}
	}
	for _, version := range []int64{28, 29} {
		var record schemaMigration
		if err := db.First(&record, version).Error; err != nil {
			t.Fatal(err)
		}
		expected := map[int64]string{28: "sha256:agent-execution-journal-v28", 29: "sha256:agent-resource-leases-v29-20260919"}
		if record.Checksum != expected[version] {
			t.Fatal("main checksum changed")
		}
	}
	if !db.Migrator().HasTable(&model.Tool{}) || !db.Migrator().HasTable(&model.ToolFavorite{}) {
		t.Fatal("tools tables missing")
	}
}
