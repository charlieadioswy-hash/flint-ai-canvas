package app

import (
	"encoding/json"
	"testing"

	"yingce/backend/internal/model"
	"yingce/backend/internal/repository"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

// 目录始终来自系统渠道；空目录也要显式返回数组，不能被会话初始化判成畸形响应。
func TestModelCatalogAlwaysSerializesCollectionsAsArrays(t *testing.T) {
	for _, test := range []struct {
		name            string
		frontendEnabled bool
		wantSource      string
	}{
		{name: "逻辑模型开关不改变目录来源", frontendEnabled: true, wantSource: "system"},
		{name: "空的系统渠道目录", frontendEnabled: false, wantSource: "system"},
	} {
		t.Run(test.name, func(t *testing.T) {
			svc, db := newModelCatalogTestService(t)
			if test.frontendEnabled {
				if err := db.Create(&model.SystemSetting{Key: featureAvailabilitySettingKey, ValueJSON: `{"frontendModelsEnabled":true}`}).Error; err != nil {
					t.Fatal(err)
				}
			}

			catalog, err := svc.ModelCatalog(nil)
			if err != nil {
				t.Fatal(err)
			}
			if string(catalog.Source) != test.wantSource {
				t.Fatalf("source = %q, want %q", catalog.Source, test.wantSource)
			}

			encoded, err := json.Marshal(catalog)
			if err != nil {
				t.Fatal(err)
			}
			var payload map[string]json.RawMessage
			if err := json.Unmarshal(encoded, &payload); err != nil {
				t.Fatal(err)
			}
			for _, key := range []string{"models", "channels"} {
				raw, present := payload[key]
				if !present || string(raw) == "null" {
					t.Fatalf("%s 集合没有序列化成数组：%s", key, encoded)
				}
			}
		})
	}
}

func TestModelCatalogPublishesVideoModelsWithoutResolutionOptions(t *testing.T) {
	svc, db := newChannelModelTestService(t)
	channel := model.ModelChannel{ID: "channel-kling", Name: "wangsu", Scope: model.ChannelScopeSystem, Enabled: true}
	if err := db.Create(&channel).Error; err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"kling-v3", "kling-v3-omni"} {
		config := DefaultModelCapabilityConfigForModel("wangsu-videos", key)
		// Keep the persisted legacy contract available before the new plugin is deployed.
		config.Video.Resolutions = []string{}
		config.Video.DefaultResolution = ""
		if config == nil || config.Video == nil || len(config.Video.Resolutions) != 0 || config.Video.DefaultResolution != "" {
			t.Fatalf("%s should have no declared video resolution: %+v", key, config)
		}
		encoded, err := json.Marshal(config)
		if err != nil {
			t.Fatal(err)
		}
		item := model.ChannelModel{
			ID: key, ChannelID: channel.ID, ModelKey: key, ProviderModelKey: key, DisplayName: key,
			Capability: "video", Protocol: "wangsu-videos", Enabled: true, PriceConfigured: true,
			CapabilityConfigJSON: string(encoded), BillingMode: "per_second", UnitPriceMicrocredits: 600_000,
		}
		if err := db.Create(&item).Error; err != nil {
			t.Fatal(err)
		}
		tier := model.ChannelModelPriceTier{
			ID: "tier-" + key, ChannelModelID: item.ID, SelectorKey: "{}", SelectorJSON: "{}", Resolution: "*",
			ProviderModelKey: key, BillingMode: "per_second", UnitPriceMicrocredits: 600_000,
			Enabled: true, PriceConfigured: true,
		}
		if err := db.Create(&tier).Error; err != nil {
			t.Fatal(err)
		}
	}

	catalog, err := svc.ModelCatalog(nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(catalog.Channels) != 1 || catalog.Channels[0].ID != channel.ID || len(catalog.Channels[0].Models) != 2 {
		t.Fatalf("priced video models without resolution options must remain in the catalog: %+v", catalog.Channels)
	}
	for _, item := range catalog.Channels[0].Models {
		if !item.Available || len(item.PriceTiers) != 1 {
			t.Fatalf("%s is not available with its configured price tier: %+v", item.ModelKey, item)
		}
		if _, exists := item.DefaultOptions["vquality"]; exists {
			t.Fatalf("%s publishes an undeclared resolution default: %+v", item.ModelKey, item.DefaultOptions)
		}
		if item.DefaultOptions["videoSeconds"] != 5 {
			t.Fatalf("%s lost its declared duration default: %+v", item.ModelKey, item.DefaultOptions)
		}
		encoded, err := json.Marshal(item.CapabilityConfig)
		if err != nil {
			t.Fatal(err)
		}
		config, err := DecodeModelCapabilityConfig(string(encoded))
		if err != nil || config == nil || config.Video == nil || len(config.Video.Resolutions) != 0 || config.Video.DefaultResolution != "" {
			t.Fatalf("%s must retain its empty resolution capability: %s, %v", item.ModelKey, encoded, err)
		}
	}
}

func newModelCatalogTestService(t *testing.T) (*Service, *gorm.DB) {
	t.Helper()
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if sqlDB, err := db.DB(); err == nil {
		sqlDB.SetMaxOpenConns(1)
	}
	if err := db.AutoMigrate(&model.SystemSetting{}, &model.AdminAuditEvent{}, &model.ModelChannel{}, &model.ChannelModel{}, &model.LogicalModel{}); err != nil {
		t.Fatal(err)
	}
	return New(repository.New(db), t.TempDir()), db
}
