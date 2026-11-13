package app

import (
	"encoding/json"
	"strings"
	"testing"

	"gorm.io/gorm"
	"yingce/backend/internal/model"
)

func shotAudioFixture(t *testing.T) (*Service, *gorm.DB, DramaShotMediaView) {
	t.Helper()
	s, db, _ := shotMediaFixture(t)
	capability := DefaultModelCapabilityConfigForModel(string(model.ChannelInterfaceOpenAIAudio), "gpt-4o-mini-tts")
	for _, row := range []any{
		&model.ChannelModel{ID: "shot-audio-cm", ChannelID: "channel", ModelKey: "gpt-4o-mini-tts", Capability: "audio", Protocol: model.ChannelInterfaceOpenAIAudio, CapabilityConfigJSON: mustEncodeModelCapabilityConfig(t, capability), BillingMode: "fixed_request", PriceConfigured: true, Enabled: true},
		&model.ChannelModelPriceTier{ID: "shot-audio-tier", ChannelModelID: "shot-audio-cm", SelectorKey: "{}", SelectorJSON: "{}", BillingMode: "fixed_request", UnitPriceMicrocredits: 25, PriceConfigured: true, Enabled: true},
	} {
		if err := db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	zero := int64(0)
	view, err := s.SaveDramaShotMedia("user", "drama-project", "real-shot", "audio", DramaShotMediaSaveRequest{ExpectedRevision: &zero, Config: DramaShotMediaConfig{Model: DramaModelChoice{ChannelID: "channel", ModelKey: "gpt-4o-mini-tts"}, Operation: "audio", Prompt: " 你好，我们出发吧。 ", AudioVoice: "alloy", AudioInstructions: "冷静、自然"}})
	if err != nil {
		t.Fatal(err)
	}
	return s, db, view
}

func shotAudioConfirmed(t *testing.T, s *Service, op string) DramaShotMediaActionRequest {
	t.Helper()
	quote, err := s.PreflightDramaShotMedia("user", "drama-project", "real-shot", "audio", DramaShotMediaActionRequest{})
	if err != nil || !quote.Ready || !quote.Priced || quote.AmountMicrocredits != 25 {
		t.Fatalf("audio preflight = %+v, %v", quote, err)
	}
	return DramaShotMediaActionRequest{ExpectedRevision: &quote.Revision, BaseRevision: &quote.BaseRevision, ConfirmationToken: quote.ConfirmationToken, ClientOperationID: op}
}

func completeShotAudio(t *testing.T, s *Service, db *gorm.DB, taskID, resourceID string) DramaShotMediaView {
	t.Helper()
	if err := db.Create(&model.Resource{ID: resourceID, UserID: "user", Kind: "audio", Status: model.ResourceStatusReady, MimeType: "audio/mpeg", DurationMs: 2200, Size: 12}).Error; err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(map[string]any{"mode": "audio", "audio": map[string]any{"resourceId": resourceID}})
	if err := db.Model(&model.Task{}).Where("id = ?", taskID).Updates(map[string]any{"status": model.TaskStatusSucceeded, "result_json": string(encoded)}).Error; err != nil {
		t.Fatal(err)
	}
	view, err := s.DramaShotMedia("user", "drama-project", "real-shot", "audio")
	if err != nil {
		t.Fatal(err)
	}
	return view
}

func TestDramaShotAudioIsRealTTSAndRequiresExplicitAdoption(t *testing.T) {
	s, db, original := shotAudioFixture(t)
	request := shotAudioConfirmed(t, s, "shot-audio-once")
	var count int64
	db.Model(&model.Task{}).Count(&count)
	if count != 0 {
		t.Fatal("save/preflight submitted TTS")
	}
	task, err := s.ExecuteDramaShotMedia("user", "drama-project", "real-shot", "audio", request)
	if err != nil || task.Type != "canvas_audio" || task.Prompt != "你好，我们出发吧。" {
		t.Fatalf("actual audio task = %+v, %v", task, err)
	}
	replayed, err := s.ExecuteDramaShotMedia("user", "drama-project", "real-shot", "audio", request)
	if err != nil || replayed.ID != task.ID {
		t.Fatalf("replay = %+v, %v", replayed, err)
	}
	stored, _ := s.repo.Task(task.ID)
	var input canvasGenerationInput
	if err := json.Unmarshal([]byte(stored.InputJSON), &input); err != nil {
		t.Fatal(err)
	}
	if input.Mode != "audio" || input.Config.AudioVoice != "alloy" || input.Config.AudioFormat != "mp3" || input.Config.AudioInstructions != "冷静、自然" || len(input.ReferenceImages) != 0 {
		t.Fatalf("TTS protocol config = %+v", input)
	}
	view := completeShotAudio(t, s, db, task.ID, "audio-first")
	if view.ResourceID != "" || view.CurrentTakeID != "" || view.PendingTakeID != "" || view.Status != "awaiting_adoption" || len(view.Takes) != 1 || view.Takes[0].Kind != "shot_audio" || view.Takes[0].Current {
		t.Fatalf("audio auto-adopted or pending never ended: %+v", view)
	}
	view, err = s.AdoptDramaShotMedia("user", "drama-project", "real-shot", "audio", DramaShotMediaAdoptRequest{ExpectedRevision: &view.Revision, TakeID: view.Takes[0].ID})
	if err != nil || view.ResourceID != "audio-first" || !view.Takes[0].Current {
		t.Fatalf("explicit audio adoption = %+v, %v", view, err)
	}
	second, err := s.ExecuteDramaShotMedia("user", "drama-project", "real-shot", "audio", shotAudioConfirmed(t, s, "shot-audio-second"))
	if err != nil {
		t.Fatal(err)
	}
	view = completeShotAudio(t, s, db, second.ID, "audio-second")
	if view.ResourceID != "audio-first" || view.Takes[0].Current || !view.Takes[1].Current || view.PendingTakeID != "" {
		t.Fatalf("new audition replaced old adopted audio: %+v", view)
	}
	video, _ := s.DramaShotMedia("user", "drama-project", "real-shot", "video")
	if video.ResourceID != "" || len(video.Takes) != 0 || original.Config.GenerateAudio {
		t.Fatal("standalone audio altered video slot")
	}
	var wallet model.CreditAccount
	db.First(&wallet, "user_id = ?", "user")
	if wallet.ReservedMicrocredits != 50 {
		t.Fatalf("audio replay double charged: %+v", wallet)
	}
}

func TestDramaShotAudioRejectsMissingVoiceImageInputsAndWrongModels(t *testing.T) {
	s, db, view := shotAudioFixture(t)
	for _, invalid := range []DramaShotMediaConfig{
		{Operation: "audio", Prompt: "台词"},
		{Operation: "audio", Prompt: "台词", AudioVoice: "alloy", ReferenceResourceIDs: []string{"ref-one"}},
		{Operation: "audio", Prompt: "台词", AudioVoice: "alloy", AspectRatio: "16:9"},
		{Operation: "audio", Prompt: strings.Repeat("长", 1001), AudioVoice: "alloy"},
	} {
		if _, err := s.SaveDramaShotMedia("user", "drama-project", "real-shot", "audio", DramaShotMediaSaveRequest{ExpectedRevision: &view.Revision, Config: invalid}); err == nil {
			t.Fatalf("invalid TTS config admitted: %+v", invalid)
		}
	}
	view.Config.Model = DramaModelChoice{ChannelID: "channel", ModelKey: "text-test"}
	view, err := s.SaveDramaShotMedia("user", "drama-project", "real-shot", "audio", DramaShotMediaSaveRequest{ExpectedRevision: &view.Revision, Config: view.Config})
	if err != nil {
		t.Fatal(err)
	}
	quote, err := s.PreflightDramaShotMedia("user", "drama-project", "real-shot", "audio", DramaShotMediaActionRequest{ExpectedRevision: &view.Revision})
	if err != nil || quote.Ready || quote.Reason == "" {
		t.Fatalf("text model accepted as TTS: %+v, %v", quote, err)
	}
	var count int64
	db.Model(&model.Task{}).Count(&count)
	if count != 0 {
		t.Fatal("blocked TTS created task")
	}
}

func TestDramaShotAudioAssetPackageIncludesOnlyExplicitlyAdoptedAudio(t *testing.T) {
	s, db, _ := shotAudioFixture(t)
	task, err := s.ExecuteDramaShotMedia("user", "drama-project", "real-shot", "audio", shotAudioConfirmed(t, s, "shot-audio-export"))
	if err != nil {
		t.Fatal(err)
	}
	view := completeShotAudio(t, s, db, task.ID, "export-audio")
	request := DramaAssetPackageRequest{EpisodeIDs: []string{"episode"}, Media: true, Prompts: true}
	before, err := s.PrepareDramaAssetPackage("user", "drama-project", request)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range before.entries {
		if entry.resourceID == "export-audio" {
			t.Fatal("unadopted audition exported as selected audio")
		}
	}
	if _, err := s.AdoptDramaShotMedia("user", "drama-project", "real-shot", "audio", DramaShotMediaAdoptRequest{ExpectedRevision: &view.Revision, TakeID: view.Takes[0].ID}); err != nil {
		t.Fatal(err)
	}
	archive, err := s.PrepareDramaAssetPackage("user", "drama-project", request)
	if err != nil {
		t.Fatal(err)
	}
	files, notes, manifests := 0, 0, 0
	for _, entry := range archive.entries {
		if entry.resourceID == "export-audio" && strings.Contains(entry.path, "/镜头音频/") && strings.HasSuffix(entry.path, ".mp3") {
			files++
		}
		if strings.HasSuffix(entry.path, "/镜头音频/使用说明.txt") && strings.Contains(string(entry.data), "未自动混入成片或剪映") {
			notes++
		}
		if strings.HasSuffix(entry.path, "/资产清单.json") {
			var manifest dramaAssetManifest
			if err := json.Unmarshal(entry.data, &manifest); err != nil {
				t.Fatal(err)
			}
			shot := manifest.Episodes[0].Shots[0]
			if shot.Audio != "" && shot.AudioText == task.Prompt {
				manifests++
			}
		}
	}
	if files != 1 || notes != 1 || manifests != 1 {
		t.Fatalf("standalone audio archive = files:%d notes:%d manifest:%d", files, notes, manifests)
	}
}
