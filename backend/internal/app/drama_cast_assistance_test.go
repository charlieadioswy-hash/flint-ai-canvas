package app

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"gorm.io/gorm"
	"yingce/backend/internal/model"
	"yingce/backend/internal/repository"
)

func castAssistanceFixture(t *testing.T) (*Service, *gorm.DB, DramaCastAssistanceRequest) {
	t.Helper()
	s, db, _, _ := creationTestService(t)
	audioConfig := DefaultModelCapabilityConfigForModel(string(model.ChannelInterfaceOpenAIAudio), "gpt-4o-mini-tts")
	for _, row := range []any{
		&model.Project{ID: "assist-project", UserID: "user", Name: "资产辅助测试", Status: model.ProjectStatusActive},
		&model.DramaProduction{ProjectID: "assist-project", UserID: "user", Revision: 3, GuideStep: model.DramaGuideAssets, Status: model.DramaStatusPaused, SettingsJSON: "{}"},
		&model.DramaCast{ID: "assist-cast", ProjectID: "assist-project", Kind: "character", Name: "秦子文", Revision: 2, Description: "年龄：26岁\n性格：冷静谨慎", DramaCharacterDefinition: model.DramaCharacterDefinition{DefinitionJSON: `{"sourceDefinition":"年龄：26岁\n性格：冷静谨慎","custom":{"keep":true}}`}},
		&model.ChannelModel{ID: "assist-audio", ChannelID: "channel", ModelKey: "gpt-4o-mini-tts", Capability: "audio", Protocol: model.ChannelInterfaceOpenAIAudio, CapabilityConfigJSON: mustEncodeModelCapabilityConfig(t, audioConfig), BillingMode: "fixed_request", PriceConfigured: true, Enabled: true},
		&model.ChannelModelPriceTier{ID: "assist-audio-tier", ChannelModelID: "assist-audio", SelectorKey: "{}", SelectorJSON: "{}", BillingMode: "fixed_request", UnitPriceMicrocredits: 50, PriceConfigured: true, Enabled: true},
		&model.Resource{ID: "assist-image", UserID: "user", Kind: "image", Status: model.ResourceStatusReady, MimeType: "image/png"},
		&model.Resource{ID: "assist-private", UserID: "other", Kind: "image", Status: model.ResourceStatusReady, MimeType: "image/png"},
	} {
		if err := db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	p, c := int64(3), int64(2)
	return s, db, DramaCastAssistanceRequest{Purpose: "fill_description", ExpectedRevision: &p, CastRevision: &c, Model: DramaModelChoice{ChannelID: "channel", ModelKey: "text-test"}, Instruction: "整理原文有明确说明的外观，其他不补充"}
}

func confirmCastAssistance(t *testing.T, s *Service, req DramaCastAssistanceRequest, op string) DramaCastAssistanceRequest {
	t.Helper()
	preflight, err := s.PreflightDramaCastAssistance("user", "assist-project", "assist-cast", req)
	if err != nil || !preflight.Ready || !preflight.Priced || preflight.ConfirmationToken == "" {
		t.Fatalf("preflight = %+v, %v", preflight, err)
	}
	req.ConfirmationToken, req.ClientOperationID = preflight.ConfirmationToken, op
	return req
}

func TestDramaCastAssistanceExplicitTextAdoptionPreservesOriginalDefinition(t *testing.T) {
	s, db, req := castAssistanceFixture(t)
	req = confirmCastAssistance(t, s, req, "assist-text-once")
	var count int64
	db.Model(&model.Task{}).Count(&count)
	if count != 0 {
		t.Fatal("preflight submitted generation")
	}
	task, err := s.ExecuteDramaCastAssistance("user", "assist-project", "assist-cast", req)
	if err != nil {
		t.Fatal(err)
	}
	replayed, err := s.ExecuteDramaCastAssistance("user", "assist-project", "assist-cast", req)
	if err != nil || replayed.ID != task.ID {
		t.Fatalf("replay = %+v, %v", replayed, err)
	}
	blocked, err := s.PreflightDramaCastAssistance("user", "assist-project", "assist-cast", req)
	if err != nil || blocked.Ready || !strings.Contains(blocked.Reason, "同类辅助任务") {
		t.Fatalf("active preflight = %+v, %v", blocked, err)
	}
	if err := db.Model(&model.Task{}).Where("id = ?", task.ID).Updates(map[string]any{"status": model.TaskStatusSucceeded, "result_json": `{"text":"26岁，外观未明确。"}`}).Error; err != nil {
		t.Fatal(err)
	}
	cast, _ := s.repo.DramaCast("assist-project", "assist-cast")
	if cast.Appearance != "" || cast.Description != "年龄：26岁\n性格：冷静谨慎" {
		t.Fatal("completed draft automatically overwrote cast")
	}
	history, err := s.DramaCastAssistance("user", "assist-project", "assist-cast")
	if err != nil || len(history) != 1 || history[0].Text != "26岁，外观未明确。" || history[0].Stale {
		t.Fatalf("history = %+v, %v", history, err)
	}
	_, err = s.AdoptDramaCastAssistance("user", "assist-project", "assist-cast", DramaCastAssistanceAdoptRequest{ExpectedRevision: req.ExpectedRevision, CastRevision: req.CastRevision, TakeID: history[0].ID, Text: "26岁；其余外观未明确。"})
	if err != nil {
		t.Fatal(err)
	}
	cast, _ = s.repo.DramaCast("assist-project", "assist-cast")
	var definition map[string]any
	_ = json.Unmarshal([]byte(cast.DefinitionJSON), &definition)
	production, _ := s.repo.DramaProduction("assist-project")
	if cast.Appearance != "26岁；其余外观未明确。" || cast.Description != "年龄：26岁\n性格：冷静谨慎" || definition["sourceDefinition"] != cast.Description || definition["custom"] == nil || cast.Revision != 3 || production.Revision != 4 || production.GuideStep != model.DramaGuideAssets {
		t.Fatalf("adoption did not preserve definition/stage: %+v %+v", cast, production)
	}
	var wallet model.CreditAccount
	db.First(&wallet, "user_id = ?", "user")
	if wallet.ReservedMicrocredits != 100 {
		t.Fatalf("duplicate charged: %+v", wallet)
	}
}

func TestDramaCastAssistanceRejectsChangedInputsOwnershipAndFakeProvenance(t *testing.T) {
	s, db, req := castAssistanceFixture(t)
	if _, err := s.DramaCastAssistance("other", "assist-project", "assist-cast"); err == nil {
		t.Fatal("foreign user read history")
	}
	req = confirmCastAssistance(t, s, req, "assist-cas")
	changed := req
	changed.Instruction = "改成18岁"
	if _, err := s.ExecuteDramaCastAssistance("user", "assist-project", "assist-cast", changed); !isAppErrorStatus(err, 409) {
		t.Fatalf("changed request reused quote: %v", err)
	}
	task, err := s.ExecuteDramaCastAssistance("user", "assist-project", "assist-cast", req)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.Task{}).Where("id = ?", task.ID).Updates(map[string]any{"status": model.TaskStatusSucceeded, "result_json": `{"text":"26岁"}`}).Error; err != nil {
		t.Fatal(err)
	}
	history, _ := s.DramaCastAssistance("user", "assist-project", "assist-cast")
	if err := db.Model(&model.DramaCast{}).Where("id = ?", "assist-cast").Update("revision", 3).Error; err != nil {
		t.Fatal(err)
	}
	currentRevision := int64(3)
	if _, err := s.AdoptDramaCastAssistance("user", "assist-project", "assist-cast", DramaCastAssistanceAdoptRequest{ExpectedRevision: req.ExpectedRevision, CastRevision: &currentRevision, TakeID: history[0].ID, Text: "18岁"}); !isAppErrorStatus(err, 409) {
		t.Fatalf("late old draft adopted: %v", err)
	}
	if _, err := s.AdoptDramaCastAssistance("user", "assist-project", "assist-cast", DramaCastAssistanceAdoptRequest{ExpectedRevision: req.ExpectedRevision, CastRevision: &currentRevision, TakeID: task.ID, Text: "伪造结果"}); err == nil {
		t.Fatal("adopted task without durable take")
	}
}

func TestDramaCastAssistanceImageReverseRequiresOwnedImageAndVision(t *testing.T) {
	s, db, req := castAssistanceFixture(t)
	req.Purpose, req.SourceResourceID = "image_prompt", "assist-private"
	preflight, err := s.PreflightDramaCastAssistance("user", "assist-project", "assist-cast", req)
	if err != nil || preflight.Ready || !strings.Contains(preflight.Reason, "当前账号") {
		t.Fatalf("private image = %+v, %v", preflight, err)
	}
	req.SourceResourceID = "assist-image"
	profile := DefaultModelCapabilityConfigForModel(string(model.ChannelInterfaceChatCompletion), "text-test")
	profile.Text.References.MaxImages = 0
	db.Model(&model.ChannelModel{}).Where("id = ?", "cm").Update("capability_config_json", mustEncodeModelCapabilityConfig(t, profile))
	preflight, err = s.PreflightDramaCastAssistance("user", "assist-project", "assist-cast", req)
	if err != nil || preflight.Ready {
		t.Fatalf("vision-less model = %+v, %v", preflight, err)
	}
	profile.Text.References.MaxImages = 1
	db.Model(&model.ChannelModel{}).Where("id = ?", "cm").Update("capability_config_json", mustEncodeModelCapabilityConfig(t, profile))
	req = confirmCastAssistance(t, s, req, "assist-image-reverse")
	task, err := s.ExecuteDramaCastAssistance("user", "assist-project", "assist-cast", req)
	if err != nil {
		t.Fatal(err)
	}
	stored, _ := s.repo.Task(task.ID)
	if !strings.Contains(stored.InputJSON, "resource:assist-image") || strings.Contains(stored.InputJSON, "assist-private") {
		t.Fatalf("real source missing: %s", stored.InputJSON)
	}
}

func TestDramaCastAssistanceVoiceSampleRequiresExplicitAdoption(t *testing.T) {
	s, db, req := castAssistanceFixture(t)
	req.Purpose, req.Model = "voice_sample", DramaModelChoice{ChannelID: "channel", ModelKey: "gpt-4o-mini-tts"}
	req.SampleText, req.VoiceKey, req.Instruction = "你好，我是秦子文。", "alloy", ""
	req = confirmCastAssistance(t, s, req, "assist-voice")
	task, err := s.ExecuteDramaCastAssistance("user", "assist-project", "assist-cast", req)
	if err != nil {
		t.Fatal(err)
	}
	if task.Prompt != req.SampleText {
		t.Fatal("TTS spoke the editing prompt")
	}
	if err := db.Create(&model.Resource{ID: "assist-audio-result", UserID: "user", Kind: "audio", MimeType: "audio/mpeg", Status: model.ResourceStatusReady}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.Task{}).Where("id = ?", task.ID).Updates(map[string]any{"status": model.TaskStatusSucceeded, "result_json": `{"mode":"audio","audio":{"resourceId":"assist-audio-result"}}`}).Error; err != nil {
		t.Fatal(err)
	}
	stored, _ := s.repo.Task(task.ID)
	for range 2 {
		if err := s.RegisterTaskOutputFromTask(*stored); err != nil {
			t.Fatal(err)
		}
	}
	audio, _ := s.repo.ResourceForUser("user", "assist-audio-result")
	if err := s.repo.DeleteDetachedResources([]model.Resource{*audio}, nil); !errors.Is(err, repository.ErrResourceCleanupStillReferenced) {
		t.Fatalf("unadopted paid voice history was not protected: %v", err)
	}
	cast, _ := s.repo.DramaCast("assist-project", "assist-cast")
	if cast.VoiceSampleResourceID != "" {
		t.Fatal("generation automatically bound voice")
	}
	history, err := s.DramaCastAssistance("user", "assist-project", "assist-cast")
	if err != nil || len(history) != 1 || history[0].ResourceID != "assist-audio-result" {
		t.Fatalf("voice history = %+v %v", history, err)
	}
	if _, err := s.AdoptDramaCastAssistance("user", "assist-project", "assist-cast", DramaCastAssistanceAdoptRequest{ExpectedRevision: req.ExpectedRevision, CastRevision: req.CastRevision, TakeID: history[0].ID}); err != nil {
		t.Fatal(err)
	}
	cast, _ = s.repo.DramaCast("assist-project", "assist-cast")
	profile, err := s.repo.VoiceProfileForUser("user", cast.VoiceProfileID)
	if err != nil || cast.VoiceSampleResourceID != "assist-audio-result" || profile.SampleResourceID != cast.VoiceSampleResourceID || cast.Description != "年龄：26岁\n性格：冷静谨慎" {
		t.Fatalf("voice not explicitly bound: %+v %+v %v", cast, profile, err)
	}
}

func TestDramaCastAssistanceBudgetAndDeletedReferenceNeverReserveCredits(t *testing.T) {
	s, db, req := castAssistanceFixture(t)
	if err := db.Model(&model.DramaProduction{}).Where("project_id = ?", "assist-project").Update("budget_microcredits", 50).Error; err != nil {
		t.Fatal(err)
	}
	preflight, err := s.PreflightDramaCastAssistance("user", "assist-project", "assist-cast", req)
	if err != nil || preflight.Ready || !strings.Contains(preflight.Reason, "预算不足") {
		t.Fatalf("budget = %+v, %v", preflight, err)
	}
	db.Model(&model.DramaProduction{}).Where("project_id = ?", "assist-project").Update("budget_microcredits", 0)
	profile := DefaultModelCapabilityConfigForModel(string(model.ChannelInterfaceChatCompletion), "text-test")
	profile.Text.References.MaxImages = 1
	db.Model(&model.ChannelModel{}).Where("id = ?", "cm").Update("capability_config_json", mustEncodeModelCapabilityConfig(t, profile))
	req.Purpose, req.SourceResourceID = "image_prompt", "assist-image"
	req = confirmCastAssistance(t, s, req, "assist-deleted-source")
	if err := db.Delete(&model.Resource{}, "id = ?", "assist-image").Error; err != nil {
		t.Fatal(err)
	}
	if _, err := s.ExecuteDramaCastAssistance("user", "assist-project", "assist-cast", req); err == nil {
		t.Fatal("deleted source image admitted")
	}
	var count int64
	db.Model(&model.Task{}).Count(&count)
	var wallet model.CreditAccount
	db.First(&wallet, "user_id = ?", "user")
	if count != 0 || wallet.ReservedMicrocredits != 0 || wallet.AvailableMicrocredits != 10000 {
		t.Fatalf("blocked task reserved credits: tasks=%d wallet=%+v", count, wallet)
	}
}

func TestDramaCastAssistanceFailedTaskAndMissingAudioProtectExistingVoice(t *testing.T) {
	s, db, req := castAssistanceFixture(t)
	if err := db.Model(&model.DramaCast{}).Where("id = ?", "assist-cast").Updates(map[string]any{"voice_profile_id": "previous-profile", "voice_sample_resource_id": "previous-sample"}).Error; err != nil {
		t.Fatal(err)
	}
	req.Purpose, req.Model, req.Instruction = "voice_sample", DramaModelChoice{ChannelID: "channel", ModelKey: "gpt-4o-mini-tts"}, ""
	req.SampleText, req.VoiceKey = "你好。", "alloy"
	req = confirmCastAssistance(t, s, req, "assist-failed-voice")
	task, err := s.ExecuteDramaCastAssistance("user", "assist-project", "assist-cast", req)
	if err != nil {
		t.Fatal(err)
	}
	db.Model(&model.Task{}).Where("id = ?", task.ID).Updates(map[string]any{"status": model.TaskStatusFailed, "error": "上游失败"})
	history, err := s.DramaCastAssistance("user", "assist-project", "assist-cast")
	if err != nil || len(history) != 1 || history[0].Status != model.TaskStatusFailed || history[0].Error != "上游失败" {
		t.Fatalf("failed task history = %+v, %v", history, err)
	}
	adopt := DramaCastAssistanceAdoptRequest{ExpectedRevision: req.ExpectedRevision, CastRevision: req.CastRevision, TakeID: history[0].ID}
	if _, err := s.AdoptDramaCastAssistance("user", "assist-project", "assist-cast", adopt); err == nil {
		t.Fatal("failed task adopted")
	}
	db.Model(&model.Task{}).Where("id = ?", task.ID).Updates(map[string]any{"status": model.TaskStatusSucceeded, "error": "", "result_json": `{"audio":{"resourceId":"assist-private"}}`})
	if _, err := s.AdoptDramaCastAssistance("user", "assist-project", "assist-cast", adopt); err == nil {
		t.Fatal("foreign or nonaudio result adopted")
	}
	cast, _ := s.repo.DramaCast("assist-project", "assist-cast")
	if cast.VoiceProfileID != "previous-profile" || cast.VoiceSampleResourceID != "previous-sample" || cast.Revision != 2 {
		t.Fatalf("failed task replaced original voice: %+v", cast)
	}
}

func TestDramaCastAssistanceGenericRetryRequiresFreshApproval(t *testing.T) {
	s, db, req := castAssistanceFixture(t)
	req = confirmCastAssistance(t, s, req, "assist-no-generic-retry")
	task, err := s.ExecuteDramaCastAssistance("user", "assist-project", "assist-cast", req)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.Task{}).Where("id = ?", task.ID).Update("status", model.TaskStatusFailed).Error; err != nil {
		t.Fatal(err)
	}
	var before model.CreditAccount
	db.First(&before, "user_id = ?", "user")
	if _, err := s.RetryTask("user", task.ID); err == nil || !strings.Contains(err.Error(), "重新预检") {
		t.Fatalf("generic retry bypassed approval: %v", err)
	}
	stored, _ := s.repo.Task(task.ID)
	var after model.CreditAccount
	db.First(&after, "user_id = ?", "user")
	if stored.Status != model.TaskStatusFailed || after.ReservedMicrocredits != before.ReservedMicrocredits || after.AvailableMicrocredits != before.AvailableMicrocredits {
		t.Fatal("rejected retry changed task or billing")
	}
}

func TestDramaCastAssistanceAdoptionUsesFieldLimitsAndPreservesMediaHistory(t *testing.T) {
	for _, purpose := range []string{"fill_description", "image_prompt"} {
		t.Run(purpose, func(t *testing.T) {
			s, db, req := castAssistanceFixture(t)
			if err := db.Model(&model.DramaCast{}).Where("id = ?", "assist-cast").Updates(map[string]any{"image_status": model.DramaMediaReady, "image_resource_id": "assist-image"}).Error; err != nil {
				t.Fatal(err)
			}
			if err := db.Model(&model.DramaProduction{}).Where("project_id = ?", "assist-project").Update("guide_step", model.DramaGuideCompleted).Error; err != nil {
				t.Fatal(err)
			}
			if purpose == "image_prompt" {
				profile := DefaultModelCapabilityConfigForModel(string(model.ChannelInterfaceChatCompletion), "text-test")
				profile.Text.References.MaxImages = 1
				if err := db.Model(&model.ChannelModel{}).Where("id = ?", "cm").Update("capability_config_json", mustEncodeModelCapabilityConfig(t, profile)).Error; err != nil {
					t.Fatal(err)
				}
				req.Purpose, req.SourceResourceID = purpose, "assist-image"
			}
			req = confirmCastAssistance(t, s, req, "assist-field-limit")
			task, err := s.ExecuteDramaCastAssistance("user", "assist-project", "assist-cast", req)
			if err != nil {
				t.Fatal(err)
			}
			if err := db.Model(&model.Task{}).Where("id = ?", task.ID).Updates(map[string]any{"status": model.TaskStatusSucceeded, "result_json": `{"text":"审阅后的文字"}`}).Error; err != nil {
				t.Fatal(err)
			}
			history, err := s.DramaCastAssistance("user", "assist-project", "assist-cast")
			if err != nil || len(history) != 1 {
				t.Fatalf("history: %+v %v", history, err)
			}
			limit := 1000
			if purpose == "image_prompt" {
				limit = 12000
			}
			adopt := DramaCastAssistanceAdoptRequest{ExpectedRevision: req.ExpectedRevision, CastRevision: req.CastRevision, TakeID: history[0].ID, Text: strings.Repeat("字", limit+1)}
			if _, err := s.AdoptDramaCastAssistance("user", "assist-project", "assist-cast", adopt); err == nil {
				t.Fatal("overlong text adopted")
			}
			adopt.Text = strings.Repeat("字", limit)
			if _, err := s.AdoptDramaCastAssistance("user", "assist-project", "assist-cast", adopt); err != nil {
				t.Fatal(err)
			}
			cast, _ := s.repo.DramaCast("assist-project", "assist-cast")
			production, _ := s.repo.DramaProduction("assist-project")
			if cast.ImageStatus != model.DramaMediaStale || cast.ImageResourceID != "assist-image" || cast.Description != "年龄：26岁\n性格：冷静谨慎" || cast.Revision != 3 || production.Revision != 4 || production.GuideStep != model.DramaGuideCompleted {
				t.Fatalf("adoption lost stage, original text or existing image: %+v %+v", cast, production)
			}
			var tasks int64
			db.Model(&model.Task{}).Count(&tasks)
			if tasks != 1 {
				t.Fatal("adoption automatically generated media")
			}
		})
	}
}
