package app

import (
	"encoding/json"
	"reflect"
	"testing"

	"yingce/backend/internal/model"
	"yingce/backend/internal/repository"
)

func TestDramaStoryboardImageSpecifications(t *testing.T) {
	for _, tc := range []struct {
		name     string
		size     *CapabilityImageSize
		options  map[string]OptionConstraint
		defaults map[string]any
		want     []DramaImageSpecification
	}{
		{
			name:     "native ratios and independent tiers",
			size:     &CapabilityImageSize{Parameter: "aspect_ratio"},
			options:  map[string]OptionConstraint{"size": anyValues([]string{"1:1", "9:16", "1:8"}), "imageResolution": anyValues([]string{"1K", "2K"})},
			defaults: map[string]any{"size": "9:16"},
			want:     []DramaImageSpecification{{"9:16", []string{"1K", "2K"}}, {"1:1", []string{"1K", "2K"}}, {"1:8", []string{"1K", "2K"}}},
		},
		{
			name: "native ratios with explicit tier pairs",
			size: &CapabilityImageSize{Parameter: "aspect_ratio", Presets: []ImageSizePreset{
				{Tier: "1k", Ratio: "1:1", Size: "1024x1024"},
				{Tier: "2k", Ratio: "9:16", Size: "1536x2752"},
			}},
			options: map[string]OptionConstraint{"size": anyValues([]string{"1:1", "9:16"}), "imageResolution": anyValues([]string{"1K", "2K", "4K"})},
			want:    []DramaImageSpecification{{"1:1", []string{"1K"}}, {"9:16", []string{"2K"}}},
		},
		{
			name: "mismatched presets and tier options",
			size: &CapabilityImageSize{Parameter: "aspect_ratio", Presets: []ImageSizePreset{
				{Tier: "1k", Ratio: "1:1", Size: "1024x1024"},
			}},
			options: map[string]OptionConstraint{"size": anyValues([]string{"1:1"}), "imageResolution": anyValues([]string{"2K"})},
		},
		{
			name:    "fixed pixels without named tiers",
			size:    &CapabilityImageSize{Parameter: "size", AllowCustom: true},
			options: map[string]OptionConstraint{"size": anyValues([]string{"1024x1024", "1024x1536", "2048x2048", "*"})},
			want:    []DramaImageSpecification{{"1:1", []string{"1024x1024", "2048x2048"}}, {"2:3", []string{"1024x1536"}}},
		},
		{
			name:    "ratio only",
			size:    &CapabilityImageSize{Parameter: "aspect_ratio"},
			options: map[string]OptionConstraint{"size": anyValues([]string{"1:1", "4:3"})},
			want:    []DramaImageSpecification{{"1:1", []string{""}}, {"4:3", []string{""}}},
		},
		{
			name: "model defaults",
			want: []DramaImageSpecification{{"", []string{""}}},
		},
		{
			name: "independent tier with no aspect ratio control",
			options: map[string]OptionConstraint{
				"imageResolution": anyValues([]string{"2K"}),
			},
			want: []DramaImageSpecification{{"", []string{"2K"}}},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := dramaStoryboardImageSpecifications(dramaStoryboardImageChoices(CapabilitySpec{ImageSize: tc.size, Options: tc.options}, tc.defaults))
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("image specifications = %#v, want %#v", got, tc.want)
			}
		})
	}
}

func TestDramaStoryboardWangsuPixelSpecifications(t *testing.T) {
	s, db, board := storyboardFixture(t, 2, 2, 2)
	const protocol = "wangsu-images"
	config := DefaultModelCapabilityConfigForModel(protocol, "gpt-image-2")
	config.Image.Size.Values = append(config.Image.Size.Values, "2048x2048", "1536x2752")
	config.Image.Size.Presets = []ImageSizePreset{
		{Tier: "1k", Ratio: "1:1", Size: "1024x1024", Width: 1024, Height: 1024},
		{Tier: "2k", Ratio: "1:1", Size: "2048x2048", Width: 2048, Height: 2048},
		{Tier: "2k", Ratio: "9:16", Size: "1536x2752", Width: 1536, Height: 2752},
	}
	for _, row := range []any{
		&model.ChannelModel{ID: "wangsu-board-model", ChannelID: "channel", ModelKey: "gpt-image-2", Capability: "image", Protocol: protocol, CapabilityConfigJSON: mustEncodeModelCapabilityConfig(t, config), BillingMode: "fixed_request", PriceConfigured: true, Enabled: true},
		&model.ChannelModelPriceTier{ID: "wangsu-board-price", ChannelModelID: "wangsu-board-model", SelectorKey: "{}", SelectorJSON: "{}", BillingMode: "fixed_request", UnitPriceMicrocredits: 2, PriceConfigured: true, Enabled: true},
	} {
		if err := db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	choice := DramaModelChoice{ChannelID: "channel", ModelKey: "gpt-image-2"}
	pool, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	limit := pool.Stats().MaxOpenConnections
	pool.SetMaxOpenConns(1)
	err = s.repo.Transaction(func(repo *repository.Repository) error {
		if _, _, ok := s.dramaImageSpecFor(repo, choice); !ok {
			t.Error("failed to read channel capability through transaction")
		}
		return nil
	})
	pool.SetMaxOpenConns(limit)
	if err != nil {
		t.Fatal(err)
	}
	option := s.dramaModelOption(nil, choice, "image", "", "")
	want := []DramaImageSpecification{{"1:1", []string{"1k", "2k"}}, {"9:16", []string{"2k"}}}
	if !reflect.DeepEqual(option.ImageSpecifications, want) || option.DefaultImageResolution != "1k" {
		t.Fatalf("storyboard image model option = %+v, want specifications %+v and 1k default", option, want)
	}
	request := DramaStoryboardCreateRequest{ClientOperationID: "wangsu-board-create", ShotIDs: board.ShotIDs, Rows: 2, Columns: 2,
		Config: DramaShotMediaConfig{Model: choice, Operation: "text_to_image", AspectRatio: "9:16", Resolution: "1K"}}
	invalid, err := s.QuoteDramaStoryboard("user", board.ProjectID, request)
	if err != nil || invalid.Ready || invalid.Reason == "" {
		t.Fatalf("unmapped ratio and tier admitted: %+v, %v", invalid, err)
	}
	request.Config.Resolution = "2K"
	quote, err := s.QuoteDramaStoryboard("user", board.ProjectID, request)
	if err != nil || !quote.Ready || !quote.Priced {
		t.Fatalf("declared 9:16 / 2K quote = %+v, %v", quote, err)
	}
	board, err = s.CreateDramaStoryboard("user", board.ProjectID, request)
	if err != nil {
		t.Fatal(err)
	}
	confirm := storyboardConfirmed(t, s, board)
	plan, err := s.prepareDramaStoryboard(s.repo, "user", board.ProjectID, board.ID, confirm)
	if err != nil || plan.view.ScopeHash != quote.ScopeHash {
		t.Fatalf("preflight and quote differ: %+v, %v", plan.view, err)
	}
	task, err := s.ExecuteDramaStoryboard("user", board.ProjectID, board.ID, confirm)
	if err != nil {
		t.Fatal(err)
	}
	storedTask, err := s.repo.Task(task.ID)
	if err != nil {
		t.Fatal(err)
	}
	var input canvasGenerationInput
	if err := json.Unmarshal([]byte(storedTask.InputJSON), &input); err != nil {
		t.Fatal(err)
	}
	if input.Config.Size != "1536x2752" || input.Config.ImageResolution != "" {
		t.Fatalf("admitted task size = %q, independent resolution = %q", input.Config.Size, input.Config.ImageResolution)
	}
}

func TestDramaStoryboardLogicalImageSpecificationsUseNativeRatio(t *testing.T) {
	s, db, board := storyboardFixture(t, 2, 2, 2)
	const protocol, modelKey = "wangsu-gemini-image", "gemini-nano-banana-2.1"
	config := DefaultModelCapabilityConfigForModel(protocol, modelKey)
	channelModel := &model.ChannelModel{ID: "native-board-channel", ChannelID: "channel", ModelKey: modelKey, Capability: "image", Protocol: protocol, CapabilityConfigJSON: mustEncodeModelCapabilityConfig(t, config), Enabled: true}
	profile, err := normalizedChannelModelCapability(channelModel, s.protocolRegistry())
	if err != nil {
		t.Fatal(err)
	}
	spec, err := CapabilitySpecFromModelCapabilityConfig(profile, "image")
	if err != nil {
		t.Fatal(err)
	}
	spec.Options["size"] = anyValues([]string{"9:16", "1:1"})
	spec.Options["imageResolution"] = anyValues([]string{"1k", "2k"})
	specJSON, err := json.Marshal(spec)
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range []any{
		channelModel,
		&model.LogicalModel{ID: "native-board-model", Code: "native-board-model", Capability: "image", Enabled: true, ActiveRevisionID: "native-board-revision", PricePolicy: "unified", BillingMode: "fixed_request", UnitPriceMicrocredits: 2},
		&model.LogicalModelRevision{ID: "native-board-revision", LogicalModelID: "native-board-model", Version: 1, CapabilitySpecJSON: string(specJSON), DefaultOptionsJSON: `{"size":"1:1","imageResolution":"1k"}`},
		&model.LogicalModelRoute{ID: "native-board-route", LogicalModelRevisionID: "native-board-revision", ChannelModelID: "native-board-channel", Enabled: true, Weight: 1},
	} {
		if err := db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	s.invalidateRouteCatalog()
	features := FeatureAvailability{ShortDramaEnabled: true, TaskCenterEnabled: true, CreditsEnabled: true, FrontendModelsEnabled: true}
	if _, err := s.UpdateFeatureAvailability(&model.User{ID: "admin", Role: model.UserRoleAdmin}, features); err != nil {
		t.Fatal(err)
	}
	choice := DramaModelChoice{LogicalModelID: "native-board-model"}
	option := s.dramaModelOption(nil, choice, "image", "", "")
	want := []DramaImageSpecification{{"1:1", []string{"1k", "2k"}}, {"9:16", []string{"1k", "2k"}}}
	if !reflect.DeepEqual(option.ImageSpecifications, want) {
		t.Fatalf("logical model specifications = %+v, want %+v", option.ImageSpecifications, want)
	}
	create := DramaStoryboardCreateRequest{ClientOperationID: "native-board-create", ShotIDs: board.ShotIDs, Rows: 2, Columns: 2,
		Config: DramaShotMediaConfig{Model: choice, Operation: "text_to_image", AspectRatio: "9:16", Resolution: "2k"}}
	board, err = s.CreateDramaStoryboard("user", board.ProjectID, create)
	if err != nil {
		t.Fatal(err)
	}
	task, err := s.ExecuteDramaStoryboard("user", board.ProjectID, board.ID, storyboardConfirmed(t, s, board))
	if err != nil {
		t.Fatal(err)
	}
	stored, err := s.repo.Task(task.ID)
	if err != nil || stored.RouteID != "native-board-route" {
		t.Fatalf("native storyboard task failed to route: %v", err)
	}
	var input canvasGenerationInput
	if err := json.Unmarshal([]byte(stored.InputJSON), &input); err != nil {
		t.Fatal(err)
	}
	if input.Config.Size != "9:16" || input.Config.ImageResolution != "2k" {
		t.Fatalf("admitted logical task size = %q, resolution = %q", input.Config.Size, input.Config.ImageResolution)
	}
}

func TestDramaStoryboardWangsuStandardSizesWithFreePixelParameter(t *testing.T) {
	s, db, board := storyboardFixture(t, 2, 2, 2)
	const protocol = "wangsu-images"
	want := []DramaImageSpecification{{"1:1", []string{"1024x1024"}}, {"3:2", []string{"1536x1024"}}, {"2:3", []string{"1024x1536"}}}
	for _, modelKey := range []string{"gpt-image-2.5-flare", "gpt-image-2.5-sunburst"} {
		t.Run(modelKey, func(t *testing.T) {
			profile := DefaultModelCapabilityConfigForModel(protocol, modelKey)
			for _, row := range []any{
				&model.ChannelModel{ID: modelKey, ChannelID: "channel", ModelKey: modelKey, Capability: "image", Protocol: protocol, CapabilityConfigJSON: mustEncodeModelCapabilityConfig(t, profile), BillingMode: "fixed_request", PriceConfigured: true, Enabled: true},
				&model.ChannelModelPriceTier{ID: modelKey + "-price", ChannelModelID: modelKey, SelectorKey: "{}", SelectorJSON: "{}", BillingMode: "fixed_request", UnitPriceMicrocredits: 2, PriceConfigured: true, Enabled: true},
			} {
				if err := db.Create(row).Error; err != nil {
					t.Fatal(err)
				}
			}
			choice := DramaModelChoice{ChannelID: "channel", ModelKey: modelKey}
			option := s.dramaModelOption(nil, choice, "image", "", "")
			if !reflect.DeepEqual(option.ImageSpecifications, want) {
				t.Fatalf("free pixel model specifications = %+v, want %+v", option.ImageSpecifications, want)
			}
			for _, screen := range want {
				for _, operation := range []string{"text_to_image", "image_to_image"} {
					config := DramaShotMediaConfig{Model: choice, Operation: operation, AspectRatio: screen.AspectRatio, Resolution: screen.Resolutions[0]}
					if operation == "image_to_image" {
						config.ReferenceResourceIDs = []string{"ref-one"}
					}
					request := DramaStoryboardCreateRequest{ShotIDs: board.ShotIDs, Rows: 2, Columns: 2, Config: config}
					quote, err := s.QuoteDramaStoryboard("user", board.ProjectID, request)
					if err != nil || !quote.Ready || !quote.Priced {
						t.Fatalf("quote for %s %s %s = %+v, %v", operation, config.AspectRatio, config.Resolution, quote, err)
					}
				}
			}
		})
	}
}

func TestDramaStoryboardLogicalImageSpecificationsFollowAvailableRoutePairs(t *testing.T) {
	s, db, board := storyboardFixture(t, 2, 2, 2)
	const protocol, provider = "wangsu-gemini-image", "gemini-nano-banana-2.1"
	if err := db.Create(&model.ModelChannel{ID: "portrait-channel", Scope: model.ChannelScopeSystem, Enabled: true}).Error; err != nil {
		t.Fatal(err)
	}
	var product CapabilitySpec
	for index, variant := range []struct{ key, channel, aspectRatio, resolution string }{
		{"square-image", "channel", "1:1", "1k"},
		{"portrait-image", "portrait-channel", "9:16", "2k"},
	} {
		config := DefaultModelCapabilityConfigForModel(protocol, provider)
		config.Image.Size.Values, config.Image.Size.Default = []string{variant.aspectRatio}, variant.aspectRatio
		config.Image.Resolution.Values, config.Image.Resolution.Default = []string{variant.resolution}, variant.resolution
		channelModel := &model.ChannelModel{ID: variant.key, ChannelID: variant.channel, ModelKey: variant.key, ProviderModelKey: provider, Capability: "image", Protocol: protocol, CapabilityConfigJSON: mustEncodeModelCapabilityConfig(t, config), Enabled: true}
		for _, record := range []any{channelModel, &model.LogicalModelRoute{ID: variant.key + "-route", LogicalModelRevisionID: "filtered-image-revision", ChannelModelID: variant.key, Enabled: true, Weight: 1}} {
			if err := db.Create(record).Error; err != nil {
				t.Fatal(err)
			}
		}
		if index == 0 {
			spec, err := channelModelCapabilitySpec(*channelModel, s.protocolRegistry())
			if err != nil {
				t.Fatal(err)
			}
			product = spec
		}
	}
	product.Options["size"] = anyValues([]string{"1:1", "9:16"})
	product.Options["imageResolution"] = anyValues([]string{"1k", "2k"})
	encoded, err := json.Marshal(product)
	if err != nil {
		t.Fatal(err)
	}
	for _, row := range []any{
		&model.LogicalModel{ID: "filtered-image", Code: "filtered-image", Capability: "image", Enabled: true, ActiveRevisionID: "filtered-image-revision", PricePolicy: "unified", BillingMode: "fixed_request", UnitPriceMicrocredits: 2},
		&model.LogicalModelRevision{ID: "filtered-image-revision", LogicalModelID: "filtered-image", Version: 1, CapabilitySpecJSON: string(encoded), DefaultOptionsJSON: `{"size":"1:1","imageResolution":"1k"}`},
	} {
		if err := db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	s.invalidateRouteCatalog()
	features := FeatureAvailability{ShortDramaEnabled: true, TaskCenterEnabled: true, CreditsEnabled: true, FrontendModelsEnabled: true}
	if _, err := s.UpdateFeatureAvailability(&model.User{ID: "admin", Role: model.UserRoleAdmin}, features); err != nil {
		t.Fatal(err)
	}
	choice := DramaModelChoice{LogicalModelID: "filtered-image"}
	option := s.dramaModelOption(nil, choice, "image", "", "")
	want := []DramaImageSpecification{{"1:1", []string{"1k"}}, {"9:16", []string{"2k"}}}
	if !reflect.DeepEqual(option.ImageSpecifications, want) {
		t.Fatalf("logical model specifications = %+v, want %+v", option.ImageSpecifications, want)
	}
	squareOnly := &userGroupAccess{group: &resolvedUserGroup{channels: map[string]bool{"channel": true}}}
	if got := s.dramaModelOption(squareOnly, choice, "image", "", "").ImageSpecifications; !reflect.DeepEqual(got, want[:1]) {
		t.Fatalf("restricted group specifications = %+v, want %+v", got, want[:1])
	}
	for _, screen := range want {
		config := DramaShotMediaConfig{Model: choice, Operation: "text_to_image", AspectRatio: screen.AspectRatio, Resolution: screen.Resolutions[0]}
		request := DramaStoryboardCreateRequest{ShotIDs: board.ShotIDs, Rows: 2, Columns: 2, Config: config}
		quote, err := s.QuoteDramaStoryboard("user", board.ProjectID, request)
		if err != nil || !quote.Ready || !quote.Priced {
			t.Fatalf("advertised pair %s %s quote = %+v, %v", config.AspectRatio, config.Resolution, quote, err)
		}
	}
}
