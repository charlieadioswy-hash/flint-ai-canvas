package app

import (
	"encoding/json"
	"errors"
	"testing"
	"time"

	"gorm.io/gorm"
	"yingce/backend/internal/model"
	"yingce/backend/internal/repository"
)

func shotMediaFixture(t *testing.T) (*Service, *gorm.DB, DramaShotMediaView) {
	t.Helper()
	s, db, _ := agentMediaFixture(t)
	if err := db.AutoMigrate(&model.DramaShotMedia{}); err != nil {
		t.Fatal(err)
	}
	settings, _ := json.Marshal(DramaSettings{Models: DramaModels{Video: DramaModelChoice{ChannelID: "channel", ModelKey: "seedance-test"}}})
	for _, row := range []any{
		&model.Project{ID: "drama-project", UserID: "user", Name: "镜头测试", Status: model.ProjectStatusActive},
		&model.DramaProduction{ProjectID: "drama-project", UserID: "user", Revision: 3, GuideStep: model.DramaGuideCompleted, Status: model.DramaStatusCompleted, SettingsJSON: string(settings)},
		&model.DramaEpisode{ID: "episode", ProjectID: "drama-project", Title: "第一集", Stage: model.DramaEpisodeDone},
		&model.DramaShot{ID: "real-shot", ProjectID: "drama-project", EpisodeID: "episode", Position: 1, VideoPrompt: "人物推门走出房间", DurationMs: 5000, UpdatedAt: time.Now()},
	} {
		if err := db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	zero := int64(0)
	view, err := s.SaveDramaShotMedia("user", "drama-project", "real-shot", "video", DramaShotMediaSaveRequest{ExpectedRevision: &zero, Config: DramaShotMediaConfig{Model: DramaModelChoice{ChannelID: "channel", ModelKey: "seedance-test"}, Prompt: "人物推门走出房间", Operation: "image_to_video", AspectRatio: "9:16", Resolution: "720p", Seconds: 5, FirstFrameResourceID: "ref-one", LastFrameResourceID: "ref-two"}})
	if err != nil {
		t.Fatal(err)
	}
	return s, db, view
}

func shotMediaConfirmed(t *testing.T, s *Service, op string) DramaShotMediaActionRequest {
	t.Helper()
	preflight, err := s.PreflightDramaShotMedia("user", "drama-project", "real-shot", "video", DramaShotMediaActionRequest{})
	if err != nil || !preflight.Ready || !preflight.Priced || preflight.AmountMicrocredits != 5 {
		t.Fatalf("preflight = %+v, %v", preflight, err)
	}
	return DramaShotMediaActionRequest{ExpectedRevision: &preflight.Revision, BaseRevision: &preflight.BaseRevision, ConfirmationToken: preflight.ConfirmationToken, ClientOperationID: op}
}

func completeShotMedia(t *testing.T, s *Service, db *gorm.DB, taskID, resourceID string) {
	t.Helper()
	if err := db.Create(&model.Resource{ID: resourceID, UserID: "user", Kind: "video", Status: model.ResourceStatusReady, MimeType: "video/mp4", DurationMs: 5000}).Error; err != nil {
		t.Fatal(err)
	}
	result, _ := json.Marshal(map[string]any{"mode": "video", "video": map[string]any{"resourceId": resourceID}})
	if err := db.Model(&model.Task{}).Where("id = ?", taskID).Updates(map[string]any{"status": model.TaskStatusSucceeded, "result_json": string(result)}).Error; err != nil {
		t.Fatal(err)
	}
	task, err := s.repo.Task(taskID)
	if err != nil {
		t.Fatal(err)
	}
	if handled, err := s.RegisterDramaShotMediaTaskOutput(*task); !handled || err != nil {
		t.Fatalf("completion = %v %v", handled, err)
	}
}

func TestDramaShotMediaAdmissionOwnsActualShotTaskAndVersion(t *testing.T) {
	s, db, view := shotMediaFixture(t)
	if view.Revision != 1 || view.ShotID != "real-shot" || len(view.Takes) != 0 {
		t.Fatalf("saved = %+v", view)
	}
	request := shotMediaConfirmed(t, s, "shot-video-once")
	var before int64
	db.Model(&model.Task{}).Count(&before)
	if before != 0 {
		t.Fatal("save/preflight submitted generation")
	}
	task, err := s.ExecuteDramaShotMedia("user", "drama-project", "real-shot", "video", request)
	if err != nil {
		t.Fatal(err)
	}
	second, err := s.ExecuteDramaShotMedia("user", "drama-project", "real-shot", "video", request)
	if err != nil || second.ID != task.ID {
		t.Fatalf("idempotent replay = %+v %v", second, err)
	}
	stored, _ := s.repo.Task(task.ID)
	var input struct {
		Metadata map[string]any  `json:"metadata"`
		Images   []providerMedia `json:"referenceImages"`
	}
	if err := json.Unmarshal([]byte(stored.InputJSON), &input); err != nil {
		t.Fatal(err)
	}
	if input.Metadata["dramaShotId"] != "real-shot" || input.Metadata["dramaShotMediaId"] != view.ID || input.Images[0].Role != "first_frame" || input.Images[1].Role != "last_frame" {
		t.Fatalf("request ownership/frames = %+v", input)
	}
	media, err := s.DramaShotMedia("user", "drama-project", "real-shot", "video")
	if err != nil || media.TaskID != task.ID || len(media.Takes) != 1 || media.Takes[0].OwnerID != "real-shot" || media.Takes[0].Kind != "shot_video" || media.Takes[0].TaskID != task.ID || media.Takes[0].ResourceID != "" {
		t.Fatalf("real pending version = %+v %v", media, err)
	}
	var wallet model.CreditAccount
	db.First(&wallet, "user_id = ?", "user")
	if wallet.AvailableMicrocredits != 9995 || wallet.ReservedMicrocredits != 5 {
		t.Fatalf("duplicate reservation: %+v", wallet)
	}
	request.ConfirmationToken = "different"
	if _, err := s.ExecuteDramaShotMedia("user", "drama-project", "real-shot", "video", request); !isAppErrorStatus(err, 409) {
		t.Fatalf("operation payload conflict = %v", err)
	}
	var segments int64
	db.Model(&model.DramaSegment{}).Count(&segments)
	if segments != 0 {
		t.Fatal("independent shot generation created a segment")
	}
}

func TestDramaShotMediaCompletionAndAdoptionProtectLatePaidResult(t *testing.T) {
	s, db, _ := shotMediaFixture(t)
	first, err := s.ExecuteDramaShotMedia("user", "drama-project", "real-shot", "video", shotMediaConfirmed(t, s, "first"))
	if err != nil {
		t.Fatal(err)
	}
	completeShotMedia(t, s, db, first.ID, "video-one")
	view, err := s.DramaShotMedia("user", "drama-project", "real-shot", "video")
	if err != nil || view.ResourceID != "video-one" || !view.Takes[0].Current {
		t.Fatalf("first result = %+v %v", view, err)
	}
	second, err := s.ExecuteDramaShotMedia("user", "drama-project", "real-shot", "video", shotMediaConfirmed(t, s, "second"))
	if err != nil {
		t.Fatal(err)
	}
	view, _ = s.DramaShotMedia("user", "drama-project", "real-shot", "video")
	if view.ResourceID != "video-one" || view.CurrentTakeID != view.Takes[1].ID {
		t.Fatal("pending result replaced the selected version")
	}
	if _, err := s.AdoptDramaShotMedia("user", "drama-project", "real-shot", "video", DramaShotMediaAdoptRequest{ExpectedRevision: &view.Revision, TakeID: view.Takes[1].ID}); err != nil {
		t.Fatal(err)
	}
	completeShotMedia(t, s, db, second.ID, "video-two")
	complete := mustShotMedia(t, s)
	if complete.ResourceID != "video-one" || len(complete.Takes) != 2 || complete.Takes[0].ResourceID != "video-two" || complete.Takes[0].Version != 2 || complete.Takes[0].Current {
		t.Fatalf("late result overwrote adoption or vanished: %+v", complete)
	}
	// Replaying completion cannot allocate another version.
	task, _ := s.repo.Task(second.ID)
	if _, err := s.RegisterDramaShotMediaTaskOutput(*task); err != nil || len(mustShotMedia(t, s).Takes) != 2 {
		t.Fatalf("completion replay = %v", err)
	}
}

func mustShotMedia(t *testing.T, s *Service) DramaShotMediaView {
	t.Helper()
	view, err := s.DramaShotMedia("user", "drama-project", "real-shot", "video")
	if err != nil {
		t.Fatal(err)
	}
	return view
}

func TestDramaShotMediaScriptEditKeepsOutputOnlyInHistory(t *testing.T) {
	s, db, _ := shotMediaFixture(t)
	task, err := s.ExecuteDramaShotMedia("user", "drama-project", "real-shot", "video", shotMediaConfirmed(t, s, "script-edit"))
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.DramaShot{}).Where("id = ?", "real-shot").Updates(map[string]any{"action": "已改成坐下", "updated_at": time.Now()}).Error; err != nil {
		t.Fatal(err)
	}
	completeShotMedia(t, s, db, task.ID, "old-script-video")
	view := mustShotMedia(t, s)
	if view.ResourceID != "" || view.Status != "stale" || len(view.Takes) != 1 || view.Takes[0].ResourceID != "old-script-video" {
		t.Fatalf("stale script activated: %+v", view)
	}
}

func TestDramaShotMediaOwnershipCASAndQuoteChanges(t *testing.T) {
	s, db, view := shotMediaFixture(t)
	for _, scope := range []struct{ user, project, shot, kind string }{{"other", "drama-project", "real-shot", "video"}, {"user", "drama-project", "missing", "video"}, {"user", "drama-project", "real-shot", "binary"}} {
		if _, err := s.DramaShotMedia(scope.user, scope.project, scope.shot, scope.kind); err == nil {
			t.Fatalf("invalid scope accepted: %+v", scope)
		}
	}
	invalid := view.Config
	invalid.LastFrameResourceID = "private"
	if _, err := s.SaveDramaShotMedia("user", "drama-project", "real-shot", "video", DramaShotMediaSaveRequest{ExpectedRevision: &view.Revision, Config: invalid}); err == nil {
		t.Fatal("foreign frame accepted")
	}
	zero := int64(0)
	if _, err := s.SaveDramaShotMedia("user", "drama-project", "real-shot", "video", DramaShotMediaSaveRequest{ExpectedRevision: &zero, Config: view.Config}); !isAppErrorStatus(err, 409) {
		t.Fatalf("stale config accepted: %v", err)
	}
	req := shotMediaConfirmed(t, s, "changed-price")
	if err := db.Model(&model.ChannelModelPriceTier{}).Where("id = ?", "video-tier").Update("unit_price_microcredits", 2).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := s.ExecuteDramaShotMedia("user", "drama-project", "real-shot", "video", req); !isAppErrorStatus(err, 409) {
		t.Fatalf("changed quote accepted: %v", err)
	}
	var count int64
	db.Model(&model.Task{}).Count(&count)
	if count != 0 {
		t.Fatal("stale quote created a task")
	}
}

func TestDramaShotMediaBindingFailureRollsBackTaskAndCredits(t *testing.T) {
	s, db, _ := shotMediaFixture(t)
	req := shotMediaConfirmed(t, s, "rollback")
	if err := db.Callback().Create().Before("gorm:create").Register("reject_shot_take", func(tx *gorm.DB) {
		if tx.Statement.Schema != nil && tx.Statement.Schema.Name == "DramaTake" {
			tx.AddError(errors.New("injected version failure"))
		}
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ExecuteDramaShotMedia("user", "drama-project", "real-shot", "video", req); err == nil {
		t.Fatal("injected failure ignored")
	}
	for _, entity := range []any{&model.Task{}, &model.BillingOrder{}, &model.DramaTake{}} {
		var count int64
		db.Model(entity).Count(&count)
		if count != 0 {
			t.Fatalf("orphaned admission: %T count=%d", entity, count)
		}
	}
	var wallet model.CreditAccount
	db.First(&wallet, "user_id = ?", "user")
	if wallet.AvailableMicrocredits != 10000 || wallet.ReservedMicrocredits != 0 || mustShotMedia(t, s).TaskID != "" {
		t.Fatalf("rollback changed wallet/slot: %+v", wallet)
	}
}

func TestDramaShotMediaConfiguredFramesAreDeletionReferences(t *testing.T) {
	s, _, _ := shotMediaFixture(t)
	refs, err := s.repo.DramaShotMediaResourceReferences("user", []string{"ref-one", "ref-two", "private"})
	if err != nil || len(refs) != 2 || refs[0].ResourceID == "private" || refs[1].ResourceID == "private" {
		t.Fatalf("frame protection = %+v %v", refs, err)
	}
	foreign, err := s.repo.DramaShotMediaResourceReferences("other", []string{"ref-one", "ref-two"})
	if err != nil || len(foreign) != 0 {
		t.Fatalf("cross-user references = %+v %v", foreign, err)
	}
}

func TestDramaShotMediaTerminalFailureRequiresFreshAdmission(t *testing.T) {
	for _, status := range []model.TaskStatus{model.TaskStatusFailed, model.TaskStatusCancelled} {
		t.Run(string(status), func(t *testing.T) {
			s, db, _ := shotMediaFixture(t)
			task, err := s.ExecuteDramaShotMedia("user", "drama-project", "real-shot", "video", shotMediaConfirmed(t, s, "terminal"))
			if err != nil {
				t.Fatal(err)
			}
			pending := mustShotMedia(t, s)
			if _, err := s.SaveDramaShotMedia("user", "drama-project", "real-shot", "video", DramaShotMediaSaveRequest{ExpectedRevision: &pending.Revision, Config: pending.Config}); !isAppErrorStatus(err, 409) {
				t.Fatalf("active task detached by save: %v", err)
			}
			if err := db.Model(&model.Task{}).Where("id = ?", task.ID).Updates(map[string]any{"status": status, "error": "fixture failure"}).Error; err != nil {
				t.Fatal(err)
			}
			view := mustShotMedia(t, s)
			if view.Status != string(status) || view.ResourceID != "" || len(view.Takes) != 1 || view.Takes[0].ResourceID != "" || view.Takes[0].Status != string(status) {
				t.Fatalf("failure created usable output: %+v", view)
			}
			if _, err := s.RetryTask("user", task.ID); !isAppErrorStatus(err, 400) {
				t.Fatalf("generic retry bypassed fresh quote/take: %v", err)
			}
			shotMediaConfirmed(t, s, "fresh-terminal")
			var count int64
			db.Model(&model.Task{}).Count(&count)
			if count != 1 {
				t.Fatal("failure preflight or generic retry created another task")
			}
		})
	}
}

func TestDramaShotMediaSuccessHookAndReadRecovery(t *testing.T) {
	for _, useHook := range []bool{true, false} {
		t.Run(map[bool]string{true: "task-output-hook", false: "read-recovery"}[useHook], func(t *testing.T) {
			s, db, _ := shotMediaFixture(t)
			task, err := s.ExecuteDramaShotMedia("user", "drama-project", "real-shot", "video", shotMediaConfirmed(t, s, "recovery"))
			if err != nil {
				t.Fatal(err)
			}
			if err := db.Create(&model.Resource{ID: "hook-result", UserID: "user", Kind: "video", Status: model.ResourceStatusReady, MimeType: "video/mp4"}).Error; err != nil {
				t.Fatal(err)
			}
			if err := db.Model(&model.Task{}).Where("id = ?", task.ID).Updates(map[string]any{"status": model.TaskStatusSucceeded, "result_json": `{"video":{"resourceId":"hook-result"}}`}).Error; err != nil {
				t.Fatal(err)
			}
			if useHook {
				stored, _ := s.repo.Task(task.ID)
				if err := s.RegisterTaskOutputFromTask(*stored); err != nil {
					t.Fatal(err)
				}
			}
			view := mustShotMedia(t, s)
			if view.ResourceID != "hook-result" || view.Status != "ready" || !view.Takes[0].Current {
				t.Fatalf("real task output not reconciled: %+v", view)
			}
		})
	}
}

func TestDramaShotMediaFramesRequireRealProtocolSemantics(t *testing.T) {
	s, _, saved := shotMediaFixture(t)
	for _, item := range []struct {
		protocol string
		ready    bool
	}{{string(model.ChannelInterfaceVolcengineArkVideo), true}, {string(model.ChannelInterfaceXAIVideo), false}, {"missing-shot-protocol", false}} {
		t.Run(item.protocol, func(t *testing.T) {
			shot, _ := s.repo.DramaShot("drama-project", "real-shot")
			input, err := s.dramaShotMediaInput(s.repo, "user", *shot, "video", saved.Config)
			if err != nil {
				t.Fatal(err)
			}
			input["config"].(map[string]any)["interfaceType"] = item.protocol
			err = s.validateDramaShotMediaFrameProtocol(input)
			if (err == nil) != item.ready {
				t.Fatalf("protocol frame validation = %v, expected ready=%v", err, item.ready)
			}
		})
	}
}

func TestDramaShotMediaReferenceCleanupRecheckAndPreflightChange(t *testing.T) {
	s, db, _ := shotMediaFixture(t)
	resource, err := s.repo.ResourceForUser("user", "ref-one")
	if err != nil {
		t.Fatal(err)
	}
	// Simulates a cleanup snapshot taken before a concurrent configuration save.
	if err := s.repo.DeleteDetachedResources([]model.Resource{*resource}, nil); !errors.Is(err, repository.ErrResourceCleanupStillReferenced) {
		t.Fatalf("locked cleanup ignored configured frame: %v", err)
	}
	request := shotMediaConfirmed(t, s, "frame-changed")
	if err := db.Model(&model.Resource{}).Where("id = ?", "ref-one").Update("status", model.ResourceStatusPending).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := s.ExecuteDramaShotMedia("user", "drama-project", "real-shot", "video", request); !isAppErrorStatus(err, 409) {
		t.Fatalf("changed frame admitted: %v", err)
	}
	var count int64
	db.Model(&model.Task{}).Count(&count)
	if count != 0 {
		t.Fatal("changed dependency created task")
	}
}

func TestDramaShotMediaImageAndVideoHaveIndependentRealOutputs(t *testing.T) {
	s, db, video := shotMediaFixture(t)
	capability := DefaultModelCapabilityConfigForModel(string(model.ChannelInterfaceGrokImage), "grok-image")
	for _, row := range []any{
		&model.ChannelModel{ID: "image-cm", ChannelID: "channel", ModelKey: "grok-image", Capability: "image", Protocol: model.ChannelInterfaceGrokImage, CapabilityConfigJSON: mustEncodeModelCapabilityConfig(t, capability), BillingMode: "fixed_request", PriceConfigured: true, Enabled: true},
		&model.ChannelModelPriceTier{ID: "image-tier", ChannelModelID: "image-cm", SelectorKey: "{}", SelectorJSON: "{}", BillingMode: "fixed_request", UnitPriceMicrocredits: 2, PriceConfigured: true, Enabled: true},
	} {
		if err := db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	zero := int64(0)
	image, err := s.SaveDramaShotMedia("user", "drama-project", "real-shot", "image", DramaShotMediaSaveRequest{ExpectedRevision: &zero, Config: DramaShotMediaConfig{Model: DramaModelChoice{ChannelID: "channel", ModelKey: "grok-image"}, Prompt: "人物推门的起幅画面", Operation: "text_to_image", AspectRatio: "1:1", Resolution: "1k"}})
	if err != nil {
		t.Fatal(err)
	}
	preflight, err := s.PreflightDramaShotMedia("user", "drama-project", "real-shot", "image", DramaShotMediaActionRequest{ExpectedRevision: &image.Revision})
	if err != nil || !preflight.Ready || preflight.AmountMicrocredits != 2 {
		t.Fatalf("image preflight = %+v %v", preflight, err)
	}
	task, err := s.ExecuteDramaShotMedia("user", "drama-project", "real-shot", "image", DramaShotMediaActionRequest{ExpectedRevision: &preflight.Revision, BaseRevision: &preflight.BaseRevision, ConfirmationToken: preflight.ConfirmationToken, ClientOperationID: "independent-image"})
	if err != nil || task.Type != "canvas_image" {
		t.Fatalf("image admission = %+v %v", task, err)
	}
	if err := db.Create(&model.Resource{ID: "shot-image", UserID: "user", Kind: "image", Status: model.ResourceStatusReady, MimeType: "image/png"}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.Task{}).Where("id = ?", task.ID).Updates(map[string]any{"status": model.TaskStatusSucceeded, "result_json": `{"images":[{"resourceId":"shot-image"}]}`}).Error; err != nil {
		t.Fatal(err)
	}
	image, err = s.DramaShotMedia("user", "drama-project", "real-shot", "image")
	if err != nil || image.ResourceID != "shot-image" || image.Status != "ready" || image.Takes[0].Kind != "shot_image" || image.Takes[0].TaskID != task.ID {
		t.Fatalf("real image output = %+v %v", image, err)
	}
	if after := mustShotMedia(t, s); after.Revision != video.Revision || after.ResourceID != "" || len(after.Takes) != 0 {
		t.Fatalf("image generation mutated video slot: %+v", after)
	}
}
