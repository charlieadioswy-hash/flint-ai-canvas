package app

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path"
	"path/filepath"
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

func TestDramaShotAudioAssetPackageStreamsRealSelectedEpisodeAudio(t *testing.T) {
	s, db, first := shotAudioFixture(t)
	if err := db.Model(&model.DramaEpisode{}).Where("id = ?", "episode").Update("number", 1).Error; err != nil {
		t.Fatal(err)
	}
	for _, row := range []any{
		&model.DramaEpisode{ID: "episode-two", ProjectID: "drama-project", Number: 2, Title: "第二集", Stage: model.DramaEpisodeDone},
		&model.DramaShot{ID: "second-audio-shot", ProjectID: "drama-project", EpisodeID: "episode-two", Position: 0, Speaker: "秦子文", Dialogue: "第二集台词", DurationMs: 2000},
	} {
		if err := db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	secondConfig := first.Config
	secondConfig.Prompt = "第二集尚未采用的新文本"
	zero := int64(0)
	second, err := s.SaveDramaShotMedia("user", "drama-project", "second-audio-shot", "audio", DramaShotMediaSaveRequest{ExpectedRevision: &zero, Config: secondConfig})
	if err != nil {
		t.Fatal(err)
	}
	wave := func(samples []int16) []byte {
		data := make([]byte, 44+len(samples)*2)
		copy(data, "RIFF")
		binary.LittleEndian.PutUint32(data[4:8], uint32(len(data)-8))
		copy(data[8:16], "WAVEfmt ")
		binary.LittleEndian.PutUint32(data[16:20], 16)
		binary.LittleEndian.PutUint16(data[20:22], 1)
		binary.LittleEndian.PutUint16(data[22:24], 1)
		binary.LittleEndian.PutUint32(data[24:28], 8000)
		binary.LittleEndian.PutUint32(data[28:32], 16000)
		binary.LittleEndian.PutUint16(data[32:34], 2)
		binary.LittleEndian.PutUint16(data[34:36], 16)
		copy(data[36:40], "data")
		binary.LittleEndian.PutUint32(data[40:44], uint32(len(samples)*2))
		for i, sample := range samples {
			binary.LittleEndian.PutUint16(data[44+i*2:], uint16(sample))
		}
		return data
	}
	firstBytes, secondBytes := wave([]int16{0, 1000, -1000, 2000, -2000, 0}), wave([]int16{0, 3000, -3000, 4000, -4000, 0})
	upload := func(identity string, data []byte) *model.Resource {
		t.Helper()
		resource, err := s.UploadResourceFile("user", identity+".wav", int64(len(data)), "audio", 0, 0, 1, bytes.NewReader(data), identity)
		if err != nil || resource.Provider != "local" || resource.Kind != "audio" || !strings.Contains(resource.MimeType, "wav") {
			t.Fatalf("real local audio upload = %+v, %v", resource, err)
		}
		return resource
	}
	firstResource, secondResource := upload("zip-audio-first", firstBytes), upload("zip-audio-second", secondBytes)
	for _, item := range []struct {
		media    DramaShotMediaView
		resource *model.Resource
		text     string
	}{{first, firstResource, "第一集已采用的朗读文本"}, {second, secondResource, "第二集已采用的朗读文本"}} {
		take := model.DramaTake{ID: item.resource.ID + "-take", ProjectID: "drama-project", OwnerID: item.media.ShotID, Kind: "shot_audio", ResourceID: item.resource.ID, Version: 1, Prompt: item.text}
		if err := db.Create(&take).Error; err != nil {
			t.Fatal(err)
		}
		if _, err := s.AdoptDramaShotMedia("user", "drama-project", item.media.ShotID, "audio", DramaShotMediaAdoptRequest{ExpectedRevision: &item.media.Revision, TakeID: take.ID}); err != nil {
			t.Fatal(err)
		}
	}
	audition := upload("zip-audio-unadopted", wave([]int16{0, 7000, -7000, 0}))
	if err := db.Create(&model.DramaTake{ID: "zip-unadopted-take", ProjectID: "drama-project", OwnerID: "real-shot", Kind: "shot_audio", ResourceID: audition.ID, Version: 2, Prompt: "尚未采用的试听"}).Error; err != nil {
		t.Fatal(err)
	}
	var selectedArchive *DramaArchive
	for _, selected := range [][]string{{"episode"}, {"episode-two"}, {"episode-two", "episode"}} {
		archive, err := s.PrepareDramaAssetPackage("user", "drama-project", DramaAssetPackageRequest{EpisodeIDs: selected, Media: true, Prompts: true})
		if err != nil {
			t.Fatal(err)
		}
		selectedArchive = archive
		var output bytes.Buffer
		if err := s.WriteDramaArchive(context.Background(), "user", archive, &output); err != nil {
			t.Fatal(err)
		}
		reader, err := zip.NewReader(bytes.NewReader(output.Bytes()), int64(output.Len()))
		if err != nil {
			t.Fatal(err)
		}
		files := map[string][]byte{}
		var manifest dramaAssetManifest
		audioFiles, notes, manifests := 0, 0, 0
		for _, file := range reader.File {
			body, err := file.Open()
			if err != nil {
				t.Fatal(err)
			}
			data, readErr := io.ReadAll(body)
			closeErr := body.Close()
			if readErr != nil || closeErr != nil {
				t.Fatal(errors.Join(readErr, closeErr))
			}
			files[file.Name] = data
			if strings.Contains(file.Name, "/镜头音频/") && strings.HasSuffix(file.Name, ".wav") {
				audioFiles++
			}
			if strings.HasSuffix(file.Name, "/镜头音频/使用说明.txt") {
				notes++
				if !strings.Contains(string(data), "未自动混入成片或剪映时间线") {
					t.Fatal("independent audio mixing limitation missing from streamed ZIP")
				}
			}
			if strings.HasSuffix(file.Name, "/"+dramaAssetManifestFile) {
				manifests++
				if err := json.Unmarshal(data, &manifest); err != nil {
					t.Fatal(err)
				}
			}
		}
		if manifests != 1 || len(manifest.Episodes) != len(selected) || audioFiles != len(selected) || notes != len(selected) {
			t.Fatalf("selected episodes %v streamed unexpected contents: manifest:%d episodes:%d audio:%d notes:%d", selected, manifests, len(manifest.Episodes), audioFiles, notes)
		}
		for _, episode := range manifest.Episodes {
			if len(episode.Shots) != 1 {
				t.Fatalf("streamed episode shots = %+v", episode)
			}
			shot := episode.Shots[0]
			wanted, wantedText, episodeID := firstBytes, "第一集已采用的朗读文本", "episode"
			if episode.Number == 2 {
				wanted, wantedText, episodeID = secondBytes, "第二集已采用的朗读文本", "episode-two"
			} else if episode.Number != 1 {
				t.Fatalf("unexpected episode in stream: %+v", episode)
			}
			if !containsString(selected, episodeID) || !strings.HasSuffix(shot.Audio, ".wav") || !bytes.Equal(files[shot.Audio], wanted) || shot.AudioText != wantedText || len(files[path.Dir(shot.Audio)+"/使用说明.txt"]) == 0 {
				t.Fatalf("selected audio bytes, real extension or adopted text mismatch: %+v", shot)
			}
		}
	}
	var foreign bytes.Buffer
	if err := s.WriteDramaArchive(context.Background(), "other", selectedArchive, &foreign); err == nil {
		t.Fatal("streaming audio download ignored resource ownership")
	}
	if _, err := zip.NewReader(bytes.NewReader(foreign.Bytes()), int64(foreign.Len())); err == nil {
		t.Fatal("unauthorized partial download was finalized as a complete ZIP")
	}
	if err := os.Remove(filepath.Join(s.dataDir, "resources", firstResource.ObjectKey)); err != nil {
		t.Fatal(err)
	}
	var unavailable bytes.Buffer
	if err := s.WriteDramaArchive(context.Background(), "user", selectedArchive, &unavailable); err == nil {
		t.Fatal("missing physical audio was silently downloaded as a complete asset package")
	}
	if _, err := zip.NewReader(bytes.NewReader(unavailable.Bytes()), int64(unavailable.Len())); err == nil {
		t.Fatal("missing audio download was finalized as a complete ZIP")
	}
}
