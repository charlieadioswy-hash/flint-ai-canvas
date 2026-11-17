package app

import (
	"encoding/json"
	"strings"
	"testing"

	"yingce/backend/internal/model"
)

func TestDramaShotVideoUsesLatestAssetsWithoutChangingManualDraft(t *testing.T) {
	s, db, saved := shotPromptFixture(t)
	config := saved.Config
	config.Prompt = "秦子武抬眼看向窗外，镜头缓慢推近。"
	config.Operation, config.FirstFrameResourceID, config.LastFrameResourceID = "text_to_video", "", ""
	config.ReferenceResourceIDs = nil
	updated, err := s.SaveDramaShotMedia("user", "drama-project", "real-shot", "video", DramaShotMediaSaveRequest{ExpectedRevision: &saved.Revision, Config: config})
	if err != nil {
		t.Fatal(err)
	}
	before, err := s.prepareDramaShotMedia(s.repo, "user", "drama-project", "real-shot", "video", DramaShotMediaActionRequest{ExpectedRevision: &updated.Revision})
	if err != nil || !before.view.Ready {
		t.Fatalf("initial plan: %+v %v", before.view, err)
	}
	if err := db.Model(&model.DramaCast{}).Where("id = ?", "prompt-hero").Updates(map[string]any{"appearance": "红色夹克，黑色卷发", "voice_instructions": "低沉略沙哑的青年声"}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.DramaCast{}).Where("id = ?", "prompt-scene").Update("appearance", "南向落地窗，木地板，墙边整齐堆放纸箱").Error; err != nil {
		t.Fatal(err)
	}
	after, err := s.prepareDramaShotMedia(s.repo, "user", "drama-project", "real-shot", "video", DramaShotMediaActionRequest{ExpectedRevision: &updated.Revision})
	if err != nil || !after.view.Ready {
		t.Fatalf("updated plan: %+v %v", after.view, err)
	}
	for _, want := range []string{"红色夹克", "低沉略沙哑", "南向落地窗", config.Prompt, "覆盖正文中冲突的固定外观与声线"} {
		if !strings.Contains(after.request.Prompt, want) {
			t.Fatalf("latest request lacks %q:\n%s", want, after.request.Prompt)
		}
	}
	if before.view.ScopeHash == after.view.ScopeHash || before.view.ConfirmationToken == after.view.ConfirmationToken || after.view.Config.Prompt != config.Prompt {
		t.Fatalf("latest asset input did not update admission independently from body: before=%+v after=%+v", before.view, after.view)
	}
	current := mustShotMedia(t, s)
	if current.Config.Prompt != config.Prompt || current.Revision != updated.Revision || current.Config.PromptSourceHash == nil || *current.Config.PromptSourceHash != "" {
		t.Fatalf("dynamic header changed saved manual body: %+v", current)
	}
	segment, err := s.repo.DramaSegment("drama-project", "prompt-segment")
	if err != nil || segment.PromptStatus != model.DramaMediaReady || segment.VideoPrompt != shotPromptWritten {
		t.Fatalf("single shot preparation changed segment prompt: %+v %v", segment, err)
	}
	assertShotReferencesNoTasksOrCharge(t, db)
}

func TestDramaShotVideoLatestAssetsKeepLookAndFrameBindings(t *testing.T) {
	s, db, saved := shotPromptFixture(t)
	look := model.DramaCast{ID: "rain-look", ProjectID: "drama-project", Kind: "character", ParentID: "prompt-hero", Name: "秦子武", LookName: "雨夜", Appearance: "红色雨衣，湿发", VoiceInstructions: "不应使用的造型声线"}
	prop := model.DramaCast{ID: "new-key", ProjectID: "drama-project", Kind: "prop", Name: "房门钥匙", Appearance: "黄铜方头钥匙"}
	for _, item := range []any{&look, &prop} {
		if err := db.Create(item).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Model(&model.DramaShot{}).Where("id = ?", "real-shot").Updates(map[string]any{"look_cast_ids_json": `["rain-look"]`, "prop_ids_json": `["new-key"]`}).Error; err != nil {
		t.Fatal(err)
	}
	shot, _ := s.repo.DramaShot("drama-project", "real-shot")
	config := saved.Config
	config.Prompt, config.PromptSourceHash = "秦子武握住钥匙。", nil
	config.ReferenceSubjects = map[string]string{"ref-one": look.ID}
	input, err := s.dramaShotMediaInput(s.repo, "user", *shot, "video", config)
	if err != nil {
		t.Fatal(err)
	}
	prompt := input["prompt"].(string)
	for _, want := range []string{"首帧对应秦子武·雨夜", "外观与空间以所附图片为准", "红色雨衣", "轻柔青年声", "黄铜方头钥匙", config.Prompt} {
		if !strings.Contains(prompt, want) {
			t.Fatalf("request lacks current look/frame information %q:\n%s", want, prompt)
		}
	}
	if strings.Contains(prompt, "不应使用的造型声线") || strings.Contains(prompt, "参考图1对应秦子武") {
		t.Fatalf("look inherited wrong voice or invented reference image numbering:\n%s", prompt)
	}
	if _, ok := input["referenceAudios"]; ok {
		t.Fatal("frame generation unexpectedly attached reference audio")
	}
}

func TestDramaShotVideoLatestVoiceMatchesActualAudioAttachments(t *testing.T) {
	for _, tc := range []struct {
		name, operation, sample string
		audio, supported        bool
		maxAudios               int
		wantSample              bool
	}{
		{"sample", "reference_to_video", "voice-sample", true, true, 1, true},
		{"no sample", "reference_to_video", "", true, true, 1, false},
		{"no sample capability", "reference_to_video", "voice-sample", true, true, 0, false},
		{"frames", "image_to_video", "voice-sample", true, true, 1, false},
		{"audio disabled", "reference_to_video", "voice-sample", false, true, 1, false},
		{"silent model", "reference_to_video", "voice-sample", true, false, 1, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, db, saved := shotPromptFixture(t)
			capability := DefaultModelCapabilityConfigForModel(string(model.ChannelInterfaceVolcengineArkVideo), "seedance-test")
			capability.Video.GenerateAudio.Supported = tc.supported
			capability.Video.References.MaxAudios = tc.maxAudios
			if err := db.Model(&model.ChannelModel{}).Where("id = ?", "video-cm").Update("capability_config_json", mustEncodeModelCapabilityConfig(t, capability)).Error; err != nil {
				t.Fatal(err)
			}
			if err := db.Create(&model.Resource{ID: "voice-sample", UserID: "user", Kind: "audio", MimeType: "audio/wav", Status: model.ResourceStatusReady, DurationMs: 3000}).Error; err != nil {
				t.Fatal(err)
			}
			if err := db.Model(&model.DramaCast{}).Where("id = ?", "prompt-hero").Update("voice_sample_resource_id", tc.sample).Error; err != nil {
				t.Fatal(err)
			}
			config := saved.Config
			config.Prompt, config.PromptSourceHash, config.GenerateAudio = "秦子武轻声说出本镜台词。", nil, tc.audio
			config.Operation, config.FirstFrameResourceID, config.LastFrameResourceID = tc.operation, "", ""
			config.ReferenceResourceIDs = []string{"ref-one"}
			if tc.operation == "image_to_video" {
				config.FirstFrameResourceID, config.ReferenceResourceIDs = "ref-one", nil
			}
			shot, _ := s.repo.DramaShot("drama-project", "real-shot")
			input, err := s.dramaShotMediaInput(s.repo, "user", *shot, "video", config)
			if err != nil {
				t.Fatal(err)
			}
			prompt := input["prompt"].(string)
			if !strings.Contains(prompt, "轻柔青年声") || !strings.Contains(prompt, config.Prompt) {
				t.Fatalf("latest voice or manual text missing:\n%s", prompt)
			}
			attached, _ := input["referenceAudios"].([]any)
			if tc.wantSample {
				if len(attached) != 1 || !strings.Contains(prompt, "参考音频1对应秦子武的声音") || !strings.Contains(prompt, "音色以随请求附带的声音样本为准") {
					t.Fatalf("sample claimed without actual attachment: %+v\n%s", attached, prompt)
				}
				encoded, _ := json.Marshal(attached)
				if !strings.Contains(string(encoded), "resource:voice-sample") {
					t.Fatalf("wrong audio resource: %s", encoded)
				}
			} else if len(attached) != 0 || strings.Contains(prompt, "参考音频1") {
				t.Fatalf("audio not sent but claimed in prompt: %+v\n%s", attached, prompt)
			}
			if !tc.audio || !tc.supported {
				if !strings.Contains(prompt, "本次不生成声音") {
					t.Fatalf("silent request promised sound:\n%s", prompt)
				}
			} else if !tc.wantSample && !strings.Contains(prompt, "本次未附带声音样本") {
				t.Fatalf("text voice fallback not explained:\n%s", prompt)
			}
		})
	}
}
