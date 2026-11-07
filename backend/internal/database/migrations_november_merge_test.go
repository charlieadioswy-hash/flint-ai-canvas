package database

import (
	"testing"

	"yingce/backend/internal/model"
)

func TestNovemberMergePreservesReleasedMigrationIdentities(t *testing.T) {
	for _, released := range []struct {
		version  int64
		name     string
		checksum string
	}{
		{81, "user_groups_pricing_currency", "sha256:user-groups-pricing-currency-v75-20261028"},
		{82, "agent_memory_document_skill_discovery", "sha256:agent-memory-document-skill-discovery-v76-20261028"},
		{83, "agent_memory_document_columns", "sha256:agent-memory-document-columns-v77-20261028"},
		{84, "drama_cast_voice_looks", "sha256:drama-cast-voice-looks-v78-20261101"},
		{85, "ecommerce_agent_and_knowledge", "sha256:ecommerce-agent-and-knowledge-v79-20261101"},
		{86, "ecommerce_agent_run_leases", "sha256:ecommerce-agent-run-leases-v86-20261104"},
		{87, "drama_guided_creation", "sha256:drama-guided-creation-v87-20261105"},
	} {
		item := schemaMigrations[released.version-1]
		if item.version != released.version || item.name != released.name || item.checksum != released.checksum {
			t.Fatalf("released migration %d changed: %+v", released.version, item)
		}
	}
}

func TestNovemberMergeUpgradesReleased87WithoutChangingGuideOrBilling(t *testing.T) {
	db := schemaBranchFixture(t, "local", 87)
	var before []schemaMigration
	if err := db.Order("version").Find(&before).Error; err != nil {
		t.Fatal(err)
	}
	for _, row := range []any{
		&model.DramaProduction{ProjectID: "kept-project", UserID: "owner", Status: model.DramaStatusRunning, GuideStep: "assets", Revision: 7, GuideConversationID: "kept-conversation", CreativeBrief: "原有创作要求", SettingsJSON: `{"generationMode":"manual"}`, SpentMicrocredits: 100},
		&model.DramaCast{ID: "kept-cast", ProjectID: "kept-project", Kind: "character", Name: "秦子文", Description: "年龄：26岁\n性格：冷静谨慎，务实有主见", Appearance: "原文明确外貌", VoiceProfileID: "kept-voice", Revision: 3},
		&model.DramaSegment{ID: "kept-segment", ProjectID: "kept-project", EpisodeID: "kept-episode", SegmentIndex: 1, VideoPromptOverride: "已确认提示词", ReferenceCastIDsJSON: `["kept-cast"]`, Revision: 4},
		&model.DramaJob{ID: "kept-job", ProjectID: "kept-project", Kind: model.DramaJobSegmentVideo, Status: model.DramaJobQueued, TaskID: "kept-task"},
		&model.EcommerceAgentRun{ID: "kept-run", UserID: "owner", IdempotencyKey: "kept-run", Status: "running", BillingOrderID: "kept-bill", LeaseOwner: "kept-worker"},
		&model.CreditAccount{UserID: "owner", AvailableMicrocredits: 800, ReservedMicrocredits: 200},
		&model.BillingOrder{ID: "kept-bill", UserID: "owner", IdempotencyKey: "kept-bill", Status: model.BillingStatusRunning, ReservedAmountMicrocredits: 200, AmountMicrocredits: 200},
		&model.PaymentOrder{ID: "kept-payment", UserID: "owner", IdempotencyKey: "kept-payment", MerchantOrderNo: "kept-merchant", AmountFen: 1234, Currency: "CNY", Status: model.PaymentOrderCredited},
		&model.ChannelModel{ID: "kept-model", ChannelID: "kept-channel", ModelKey: "video-token", Capability: "video"},
		&model.ChannelModelPriceTier{ID: "kept-tier", ChannelModelID: "kept-model", SelectorKey: "{}", BillingMode: "token", OutputTokenPriceMicrocredits: 16000000, CostPricing: model.CreditCostPricing{Configured: true, OutputTokenPriceMicrocredits: 6000000}},
	} {
		if err := db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	// The baseline uses today's models. Remove the upstream additions so this
	// fixture requires real schema changes, rather than only new ledger rows.
	addedTables := []any{
		&model.ArkPortraitSession{}, &model.ArkPortraitGroup{}, &model.ArkPortraitAsset{}, &model.ArkPortraitGroupGrant{},
		&model.PoseLibrarySource{}, &model.PoseLibraryItem{}, &model.InspirationFeedEntry{}, &model.EmailLog{}, &model.UserNotificationSetting{},
	}
	for _, table := range addedTables {
		if err := db.Migrator().DropTable(table); err != nil {
			t.Fatal(err)
		}
	}
	addedColumns := []struct {
		entity any
		fields []string
	}{
		{&model.PaymentOrder{}, []string{"ChargeAmountFen", "ChargeCurrency", "ExchangeRateMicros", "PaymentMethod"}},
		{&model.ChannelModel{}, []string{"CacheWriteTokenPriceMicrocredits", "ReferenceVideoBilling"}},
		{&model.ChannelModelPriceTier{}, []string{"CacheWriteTokenPriceMicrocredits", "cost_cache_write_token_price_microcredits", "TokenPriceRulesEnabled", "TokenPriceRules", "ReferenceVideoUnitPriceMicrocredits", "ReferenceVideoOutputTokenPriceMicrocredits", "cost_reference_video_unit_price_microcredits", "cost_reference_video_output_token_price_microcredits"}},
		{&model.BillingOrder{}, []string{"CacheWriteTokenPriceMicrocredits", "cost_cache_write_token_price_microcredits", "CacheWriteTokens", "TokenPriceRulesJSON", "TokenPriceRule", "ReferenceVideoCount", "ReferenceVideoMillis", "ReferenceVideoBilled", "cost_reference_video_unit_price_microcredits", "cost_reference_video_output_token_price_microcredits"}},
		{&model.LogicalModel{}, []string{"CacheWritePriceMicrocredits"}},
		{&model.ApiCallLog{}, []string{"CacheWriteTokens"}},
		{&model.Skill{}, []string{"AdminInfoEditedAt", "AdminContentEditedAt"}},
		{&model.DramaProduction{}, []string{"DraftJSON"}},
		{&model.DramaCast{}, []string{"ImagePrompt"}},
		{&model.DramaSegment{}, []string{"ReferenceImagesJSON", "AudioCastIDsJSON"}},
	}
	for _, change := range addedColumns {
		for _, field := range change.fields {
			if err := db.Migrator().DropColumn(change.entity, field); err != nil {
				t.Fatal(err)
			}
			if db.Migrator().HasColumn(change.entity, field) {
				t.Fatalf("fixture still contains new column %T.%s", change.entity, field)
			}
		}
	}
	for range 2 {
		if err := MigrateSchema(db); err != nil {
			t.Fatal(err)
		}
		if err := RequireSchemaVersion(db); err != nil {
			t.Fatal(err)
		}
	}
	for _, record := range before {
		var after schemaMigration
		if err := db.First(&after, "version = ?", record.Version).Error; err != nil || record.Name != after.Name || record.Checksum != after.Checksum || !record.AppliedAt.Equal(after.AppliedAt) {
			t.Fatalf("released migration changed: before=%+v after=%+v err=%v", record, after, err)
		}
	}
	for _, table := range addedTables {
		if !db.Migrator().HasTable(table) {
			t.Fatalf("missing upstream table %T", table)
		}
	}
	for _, change := range addedColumns {
		for _, field := range change.fields {
			if !db.Migrator().HasColumn(change.entity, field) {
				t.Fatalf("missing upstream column %T.%s", change.entity, field)
			}
		}
	}
	var production model.DramaProduction
	if err := db.First(&production, "project_id = ?", "kept-project").Error; err != nil || production.GuideStep != "assets" || production.Revision != 7 || production.GuideConversationID != "kept-conversation" || production.CreativeBrief != "原有创作要求" || production.SpentMicrocredits != 100 || production.Status != model.DramaStatusRunning {
		t.Fatalf("guide changed: %+v, %v", production, err)
	}
	var cast model.DramaCast
	if err := db.First(&cast, "id = ?", "kept-cast").Error; err != nil || cast.Description != "年龄：26岁\n性格：冷静谨慎，务实有主见" || cast.Appearance != "原文明确外貌" || cast.VoiceProfileID != "kept-voice" || cast.Revision != 3 {
		t.Fatalf("character definition changed: %+v, %v", cast, err)
	}
	var segment model.DramaSegment
	if err := db.First(&segment, "id = ?", "kept-segment").Error; err != nil || segment.VideoPromptOverride != "已确认提示词" || segment.ReferenceCastIDsJSON != `["kept-cast"]` || segment.Revision != 4 {
		t.Fatalf("segment changed: %+v, %v", segment, err)
	}
	var job model.DramaJob
	if err := db.First(&job, "id = ?", "kept-job").Error; err != nil || job.Status != model.DramaJobQueued || job.TaskID != "kept-task" {
		t.Fatalf("queued work changed: %+v, %v", job, err)
	}
	var run model.EcommerceAgentRun
	if err := db.First(&run, "id = ?", "kept-run").Error; err != nil || run.Status != "running" || run.BillingOrderID != "kept-bill" || run.LeaseOwner != "kept-worker" {
		t.Fatalf("leased work changed: %+v, %v", run, err)
	}
	var bill model.BillingOrder
	if err := db.First(&bill, "id = ?", "kept-bill").Error; err != nil || bill.Status != model.BillingStatusRunning || bill.ReservedAmountMicrocredits != 200 || bill.AmountMicrocredits != 200 {
		t.Fatalf("billing reservation changed: %+v, %v", bill, err)
	}
	var wallet model.CreditAccount
	if err := db.First(&wallet, "user_id = ?", "owner").Error; err != nil || wallet.AvailableMicrocredits != 800 || wallet.ReservedMicrocredits != 200 {
		t.Fatalf("wallet changed: %+v, %v", wallet, err)
	}
	var payment model.PaymentOrder
	if err := db.First(&payment, "id = ?", "kept-payment").Error; err != nil || payment.ChargeAmountFen != 1234 || payment.ChargeCurrency != "CNY" || payment.Status != model.PaymentOrderCredited {
		t.Fatalf("legacy payment snapshot not backfilled: %+v, %v", payment, err)
	}
	var channelModel model.ChannelModel
	if err := db.First(&channelModel, "id = ?", "kept-model").Error; err != nil || !channelModel.ReferenceVideoBilling {
		t.Fatalf("token video billing not preserved: %+v, %v", channelModel, err)
	}
	var tier model.ChannelModelPriceTier
	if err := db.First(&tier, "id = ?", "kept-tier").Error; err != nil || tier.OutputTokenPriceMicrocredits != 16000000 || tier.ReferenceVideoOutputTokenPriceMicrocredits != 16000000 || tier.CostPricing.ReferenceVideoOutputTokenPriceMicrocredits != 6000000 {
		t.Fatalf("token video prices changed: %+v, %v", tier, err)
	}
}
