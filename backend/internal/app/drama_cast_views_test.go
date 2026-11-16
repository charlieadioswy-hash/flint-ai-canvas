package app

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"gorm.io/gorm"
	"yingce/backend/internal/model"
	"yingce/backend/internal/repository"
)

func castViewsFixture(t *testing.T) (*Service, *gorm.DB, DramaCastViewResult) {
	t.Helper()
	s, db, _, _ := creationTestService(t)
	capability := DefaultModelCapabilityConfigForModel(string(model.ChannelInterfaceGrokImage), "grok-image")
	settings, _ := json.Marshal(DramaSettings{Models: DramaModels{Image: DramaModelChoice{ChannelID: "channel", ModelKey: "grok-image"}}})
	for _, row := range []any{
		&model.ChannelModel{ID: "view-cm", ChannelID: "channel", ModelKey: "grok-image", Capability: "image", Protocol: model.ChannelInterfaceGrokImage, CapabilityConfigJSON: mustEncodeModelCapabilityConfig(t, capability), BillingMode: "fixed_request", PriceConfigured: true, Enabled: true},
		&model.ChannelModelPriceTier{ID: "view-price", ChannelModelID: "view-cm", SelectorKey: "{}", SelectorJSON: "{}", BillingMode: "fixed_request", UnitPriceMicrocredits: 2, PriceConfigured: true, Enabled: true},
		&model.Project{ID: "view-project", UserID: "user", Name: "多视图", Status: model.ProjectStatusActive},
		&model.DramaProduction{ProjectID: "view-project", UserID: "user", GuideStep: model.DramaGuideStory, Revision: 3, SettingsJSON: string(settings)},
		&model.DramaCast{ID: "view-cast", ProjectID: "view-project", Kind: "character", Name: "秦子文", Description: "26岁，冷静谨慎，务实有主见。", Appearance: "黑色短发，白衬衫。", Revision: 2, ImageStatus: model.DramaMediaDraft},
	} {
		if err := db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	p, _ := s.repo.DramaProduction("view-project")
	c, _ := s.repo.DramaCast("view-project", "view-cast")
	zero := int64(0)
	view, err := s.SaveDramaCastView("user", "view-project", "view-cast", "", DramaCastViewSaveRequest{ExpectedRevision: &p.Revision, ExpectedCastRevision: &c.Revision, ViewRevision: &zero, Config: DramaCastViewConfig{Name: "正面", Direction: "front", ImageOptions: DramaCastImageOptions{Ratio: "1:1", Resolution: "1k"}}})
	if err != nil {
		t.Fatal(err)
	}
	return s, db, view
}

func confirmedCastView(t *testing.T, s *Service, viewID, operationID string) DramaCastViewActionRequest {
	t.Helper()
	v, err := s.PreflightDramaCastView("user", "view-project", "view-cast", viewID, DramaCastViewActionRequest{})
	if err != nil || !v.Ready || !v.Priced || v.AmountMicrocredits != 2 {
		t.Fatalf("preflight %+v %v", v, err)
	}
	return DramaCastViewActionRequest{ExpectedRevision: &v.Revision, ViewRevision: &v.ViewRevision, ConfirmationToken: v.ConfirmationToken, ClientOperationID: operationID}
}

func TestDramaCastViewDraftQuotesDoNotPersistAndMatchSavedScope(t *testing.T) {
	for _, existing := range []bool{false, true} {
		t.Run(map[bool]string{false: "new", true: "existing"}[existing], func(t *testing.T) {
			s, db, view := castViewsFixture(t)
			p, _ := s.repo.DramaProduction("view-project")
			cast, _ := s.repo.DramaCast("view-project", "view-cast")
			wallet, _ := s.repo.CreditAccount("user")
			config := view.Config
			config.Prompt = "仅展示服装背面的刺绣细节"
			viewID, viewRevision := "", int64(0)
			if existing {
				viewID, viewRevision = view.ID, view.Revision
			}
			req := DramaCastViewSaveRequest{ExpectedRevision: &p.Revision, ExpectedCastRevision: &cast.Revision, ViewRevision: &viewRevision, Config: config}
			quote, err := s.QuoteDramaCastViewDraft("user", "view-project", "view-cast", viewID, req)
			if err != nil || !quote.Ready || !quote.Priced || quote.ScopeHash == "" || quote.ConfirmationToken != "" || quote.AmountMicrocredits != 2 {
				t.Fatalf("draft quote %+v %v", quote, err)
			}
			fresh, _ := s.repo.DramaProduction("view-project")
			stored, _ := s.repo.DramaCastView("view-project", "view-cast", view.ID)
			views, _ := s.repo.DramaCastViews("view-project", "view-cast")
			freshWallet, _ := s.repo.CreditAccount("user")
			var tasks int64
			db.Model(&model.Task{}).Count(&tasks)
			if fresh.Revision != p.Revision || stored.ConfigJSON != view.ConfigJSON || len(views) != 1 || tasks != 0 || *freshWallet != *wallet {
				t.Fatal("draft quote saved configuration, created a view/task or changed billing")
			}
			saved, err := s.SaveDramaCastView("user", "view-project", "view-cast", viewID, req)
			if err != nil {
				t.Fatal(err)
			}
			ready, err := s.PreflightDramaCastView("user", "view-project", "view-cast", saved.ID, DramaCastViewActionRequest{})
			if err != nil || !ready.Ready || ready.ConfirmationToken == "" || ready.ScopeHash != quote.ScopeHash || ready.AmountMicrocredits != quote.AmountMicrocredits {
				t.Fatalf("saved quote changed equivalent scope: draft=%+v saved=%+v err=%v", quote, ready, err)
			}
			fresh, _ = s.repo.DramaProduction("view-project")
			req.ExpectedRevision, req.ViewRevision = &fresh.Revision, &saved.Revision
			req.Config.Prompt = "仅展示鞋底细节"
			changed, err := s.QuoteDramaCastViewDraft("user", "view-project", "view-cast", saved.ID, req)
			if err != nil || !changed.Ready || changed.ScopeHash == ready.ScopeHash {
				t.Fatalf("changed draft must change scope: %+v %v", changed, err)
			}
		})
	}
}

func TestDramaCastViewDraftQuoteChecksScopeAndBaseline(t *testing.T) {
	s, _, view := castViewsFixture(t)
	p, _ := s.repo.DramaProduction("view-project")
	cast, _ := s.repo.DramaCast("view-project", "view-cast")
	req := DramaCastViewSaveRequest{ExpectedRevision: &p.Revision, ExpectedCastRevision: &cast.Revision, ViewRevision: &view.Revision, Config: view.Config}
	if _, err := s.QuoteDramaCastViewDraft("someone-else", "view-project", "view-cast", view.ID, req); err == nil {
		t.Fatal("draft quote bypassed project ownership")
	}
	old := cast.Revision - 1
	req.ExpectedCastRevision = &old
	if _, err := s.QuoteDramaCastViewDraft("user", "view-project", "view-cast", view.ID, req); !isAppErrorStatus(err, 409) {
		t.Fatalf("stale cast baseline accepted: %v", err)
	}
}

func completeCastView(t *testing.T, s *Service, db *gorm.DB, taskID, resourceID string) {
	t.Helper()
	if err := db.Create(&model.Resource{ID: resourceID, UserID: "user", Kind: "image", MimeType: "image/png", Status: model.ResourceStatusReady}).Error; err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(map[string]any{"images": []any{map[string]any{"resourceId": resourceID}}})
	if err := db.Model(&model.Task{}).Where("id = ?", taskID).Updates(map[string]any{"status": model.TaskStatusSucceeded, "result_json": string(raw)}).Error; err != nil {
		t.Fatal(err)
	}
	task, _ := s.repo.Task(taskID)
	if err := s.RegisterTaskOutputFromTask(*task); err != nil {
		t.Fatal(err)
	}
}

func TestDramaCastViewsOwnIndependentConfigTasksAndVersions(t *testing.T) {
	s, db, view := castViewsFixture(t)
	var count int64
	db.Model(&model.Task{}).Count(&count)
	if count != 0 {
		t.Fatal("save generated media")
	}
	p, _ := s.repo.DramaProduction("view-project")
	if p.GuideStep != model.DramaGuideStory {
		t.Fatal("save rewound workflow")
	}
	req := confirmedCastView(t, s, view.ID, "view-once")
	task, err := s.ExecuteDramaCastView("user", "view-project", "view-cast", view.ID, req)
	if err != nil {
		t.Fatal(err)
	}
	replay, err := s.ExecuteDramaCastView("user", "view-project", "view-cast", view.ID, req)
	if err != nil || replay.ID != task.ID {
		t.Fatalf("replay %+v %v", replay, err)
	}
	stored, _ := s.repo.Task(task.ID)
	if !strings.Contains(stored.Prompt, "26岁") || !strings.Contains(stored.Prompt, "仅生成正面单视图") {
		t.Fatalf("lost definition/direction: %s", stored.Prompt)
	}
	var wallet model.CreditAccount
	db.First(&wallet, "user_id = ?", "user")
	if wallet.AvailableMicrocredits != 9998 || wallet.ReservedMicrocredits != 2 {
		t.Fatalf("duplicate bill %+v", wallet)
	}
	completeCastView(t, s, db, task.ID, "view-result-one")
	view, err = s.DramaCastView("user", "view-project", "view-cast", view.ID)
	if err != nil || view.ResourceID != "view-result-one" || len(view.Takes) != 1 || !view.Takes[0].Current || view.Takes[0].OwnerID != view.ID || view.Takes[0].Kind != "cast_view" {
		t.Fatalf("view %+v %v", view, err)
	}
	cast, _ := s.repo.DramaCast("view-project", "view-cast")
	if cast.ImageResourceID != "" || cast.ImageVersion != 0 || cast.Description != "26岁，冷静谨慎，务实有主见。" {
		t.Fatal("view overwrote base cast")
	}
}

func TestDramaCastViewsPreserveLatePaidResultAfterAdoptionOrSourceEdit(t *testing.T) {
	for _, mode := range []string{"adopt", "source", "style"} {
		t.Run(mode, func(t *testing.T) {
			s, db, view := castViewsFixture(t)
			first, err := s.ExecuteDramaCastView("user", "view-project", "view-cast", view.ID, confirmedCastView(t, s, view.ID, "first"))
			if err != nil {
				t.Fatal(err)
			}
			completeCastView(t, s, db, first.ID, "view-old")
			view, _ = s.DramaCastView("user", "view-project", "view-cast", view.ID)
			second, err := s.ExecuteDramaCastView("user", "view-project", "view-cast", view.ID, confirmedCastView(t, s, view.ID, "second"))
			if err != nil {
				t.Fatal(err)
			}
			if mode == "adopt" {
				p, _ := s.repo.DramaProduction("view-project")
				latest, _ := s.repo.DramaCastView("view-project", "view-cast", view.ID)
				_, err = s.AdoptDramaCastView("user", "view-project", "view-cast", view.ID, DramaCastViewAdoptRequest{ExpectedRevision: &p.Revision, ViewRevision: &latest.Revision, TakeID: view.Takes[0].ID})
				if err != nil {
					t.Fatal(err)
				}
			} else if mode == "source" {
				if err := s.repo.UpdateDramaCastFields("view-cast", map[string]any{"appearance": "手工改为蓝外套"}); err != nil {
					t.Fatal(err)
				}
			} else {
				if err := db.Model(&model.DramaProduction{}).Where("project_id = ?", "view-project").Update("settings_json", `{"stylePrompt":"水墨"}`).Error; err != nil {
					t.Fatal(err)
				}
			}
			completeCastView(t, s, db, second.ID, "view-late")
			latest, err := s.DramaCastView("user", "view-project", "view-cast", view.ID)
			if err != nil || latest.ResourceID != "view-old" || len(latest.Takes) != 2 {
				t.Fatalf("late overwrite %+v %v", latest, err)
			}
			found := false
			for _, take := range latest.Takes {
				if take.TaskID == second.ID && take.ResourceID == "view-late" && !take.Current {
					found = true
				}
			}
			if !found {
				t.Fatal("late paid result lost")
			}
		})
	}
}

func TestDramaCastViewsRejectStaleForeignAndChangedQuote(t *testing.T) {
	s, db, view := castViewsFixture(t)
	if _, err := s.DramaCastViews("other", "view-project", "view-cast"); err == nil {
		t.Fatal("foreign read")
	}
	p, _ := s.repo.DramaProduction("view-project")
	cast, _ := s.repo.DramaCast("view-project", "view-cast")
	stale := cast.Revision - 1
	if _, err := s.SaveDramaCastView("user", "view-project", "view-cast", view.ID, DramaCastViewSaveRequest{ExpectedRevision: &p.Revision, ExpectedCastRevision: &stale, ViewRevision: &view.Revision, Config: view.Config}); !isAppErrorStatus(err, 409) {
		t.Fatalf("cast CAS %v", err)
	}
	if err := db.Create(&model.Resource{ID: "foreign-view-ref", UserID: "other", Kind: "image", MimeType: "image/png", Status: model.ResourceStatusReady}).Error; err != nil {
		t.Fatal(err)
	}
	view.Config.ImageOptions.SubjectReferenceIDs = []string{"foreign-view-ref"}
	if _, err := s.SaveDramaCastView("user", "view-project", "view-cast", view.ID, DramaCastViewSaveRequest{ExpectedRevision: &p.Revision, ExpectedCastRevision: &cast.Revision, ViewRevision: &view.Revision, Config: view.Config}); err == nil {
		t.Fatal("foreign ref")
	}
	req := confirmedCastView(t, s, view.ID, "quote")
	db.Model(&model.ChannelModelPriceTier{}).Where("id = ?", "view-price").Update("unit_price_microcredits", 3)
	if _, err := s.ExecuteDramaCastView("user", "view-project", "view-cast", view.ID, req); !isAppErrorStatus(err, 409) {
		t.Fatalf("changed quote %v", err)
	}
	var count int64
	db.Model(&model.Task{}).Count(&count)
	if count != 0 {
		t.Fatal("quote conflict submitted")
	}
}

func TestDramaCastViewsAtomicAdmissionAndActiveDeleteProtection(t *testing.T) {
	s, db, view := castViewsFixture(t)
	req := confirmedCastView(t, s, view.ID, "rollback")
	if err := db.Callback().Create().Before("gorm:create").Register("view_test_fail", func(tx *gorm.DB) {
		if tx.Statement.Schema != nil && tx.Statement.Schema.Name == "Task" {
			tx.AddError(errors.New("injected task failure"))
		}
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ExecuteDramaCastView("user", "view-project", "view-cast", view.ID, req); err == nil {
		t.Fatal("failure not propagated")
	}
	db.Callback().Create().Remove("view_test_fail")
	var wallet model.CreditAccount
	db.First(&wallet, "user_id = ?", "user")
	if wallet.AvailableMicrocredits != 10000 || wallet.ReservedMicrocredits != 0 {
		t.Fatalf("leaked reservation %+v", wallet)
	}
	task, err := s.ExecuteDramaCastView("user", "view-project", "view-cast", view.ID, req)
	if err != nil {
		t.Fatal(err)
	}
	latest, _ := s.repo.DramaCastView("view-project", "view-cast", view.ID)
	p, _ := s.repo.DramaProduction("view-project")
	if err := s.DeleteDramaCastView("user", "view-project", "view-cast", view.ID, DramaCastViewActionRequest{ExpectedRevision: &p.Revision, ViewRevision: &latest.Revision}); !isAppErrorStatus(err, 409) {
		t.Fatalf("active delete %v", err)
	}
	db.Model(&model.Task{}).Where("id = ?", task.ID).Updates(map[string]any{"status": model.TaskStatusFailed, "updated_at": time.Now()})
	if _, err := s.RetryTask("user", task.ID); err == nil {
		t.Fatal("generic retry bypassed quote")
	}
}

func TestDramaCastViewsProtectConfigAndPaidHistoryResources(t *testing.T) {
	s, db, view := castViewsFixture(t)
	resource := model.Resource{ID: "view-style", UserID: "user", Kind: "image", MimeType: "image/png", Status: model.ResourceStatusReady}
	if err := db.Create(&resource).Error; err != nil {
		t.Fatal(err)
	}
	p, _ := s.repo.DramaProduction("view-project")
	cast, _ := s.repo.DramaCast("view-project", "view-cast")
	view.Config.ImageOptions.StyleReferenceIDs = []string{resource.ID}
	view, err := s.SaveDramaCastView("user", "view-project", "view-cast", view.ID, DramaCastViewSaveRequest{ExpectedRevision: &p.Revision, ExpectedCastRevision: &cast.Revision, ViewRevision: &view.Revision, Config: view.Config})
	if err != nil {
		t.Fatal(err)
	}
	refs, err := s.repo.DramaCastViewResourceReferences("user", []string{resource.ID})
	if err != nil || len(refs) != 1 {
		t.Fatalf("config refs %+v %v", refs, err)
	}
	if err := s.repo.DeleteDetachedResources([]model.Resource{resource}, nil); !errors.Is(err, repository.ErrResourceCleanupStillReferenced) {
		t.Fatalf("view reference deleted: %v", err)
	}
	if err := s.repo.RequireNoDramaCastViews("view-project", "view-cast"); !errors.Is(err, repository.ErrDramaCastViewChanged) {
		t.Fatalf("base deletion could orphan view: %v", err)
	}
	task, err := s.ExecuteDramaCastView("user", "view-project", "view-cast", view.ID, confirmedCastView(t, s, view.ID, "history-protection"))
	if err != nil {
		t.Fatal(err)
	}
	completeCastView(t, s, db, task.ID, "view-paid-history")
	latest, _ := s.repo.DramaCastView("view-project", "view-cast", view.ID)
	p, _ = s.repo.DramaProduction("view-project")
	if err := s.DeleteDramaCastView("user", "view-project", "view-cast", view.ID, DramaCastViewActionRequest{ExpectedRevision: &p.Revision, ViewRevision: &latest.Revision}); err != nil {
		t.Fatal(err)
	}
	paid, _ := s.repo.ResourceForUser("user", "view-paid-history")
	if err := s.repo.DeleteDetachedResources([]model.Resource{*paid}, nil); !errors.Is(err, repository.ErrResourceCleanupStillReferenced) {
		t.Fatalf("deleting view lost paid history protection: %v", err)
	}
	refs, err = s.repo.DramaCastViewResourceReferences("other", []string{resource.ID, paid.ID})
	if err != nil || len(refs) != 0 {
		t.Fatalf("view refs leaked to another account: %+v %v", refs, err)
	}
}

func TestDramaCastViewsScenePropAndLookUseRealReferenceOrder(t *testing.T) {
	for _, kind := range []string{"character", "scene", "prop", "look"} {
		t.Run(kind, func(t *testing.T) {
			s, db, view := castViewsFixture(t)
			capability := DefaultModelCapabilityConfigForModel(string(model.ChannelInterfaceGeminiImage), "gemini-3-pro-image-preview")
			if err := db.Model(&model.ChannelModel{}).Where("id = ?", "view-cm").Updates(map[string]any{"protocol": model.ChannelInterfaceGeminiImage, "model_key": "gemini-3-pro-image-preview", "capability_config_json": mustEncodeModelCapabilityConfig(t, capability)}).Error; err != nil {
				t.Fatal(err)
			}
			settings, _ := json.Marshal(DramaSettings{Models: DramaModels{Image: DramaModelChoice{ChannelID: "channel", ModelKey: "gemini-3-pro-image-preview"}}})
			if err := db.Model(&model.DramaProduction{}).Where("project_id = ?", "view-project").Update("settings_json", string(settings)).Error; err != nil {
				t.Fatal(err)
			}
			for _, id := range []string{"view-subject", "view-style", "view-own", "view-parent"} {
				if err := db.Create(&model.Resource{ID: id, UserID: "user", Kind: "image", MimeType: "image/png", Status: model.ResourceStatusReady}).Error; err != nil {
					t.Fatal(err)
				}
			}
			options := DramaCastImageOptions{SubjectReferenceIDs: []string{"view-subject"}, StyleReferenceIDs: []string{"view-style"}}
			encoded, _ := json.Marshal(options)
			fields := map[string]any{"kind": kind, "image_resource_id": "view-own", "image_status": model.DramaMediaReady, "image_options_json": string(encoded)}
			if kind == "look" {
				if err := db.Create(&model.DramaCast{ID: "parent", ProjectID: "view-project", Kind: "character", Name: "秦子文", ImageResourceID: "view-parent", ImageStatus: model.DramaMediaReady}).Error; err != nil {
					t.Fatal(err)
				}
				fields["kind"], fields["parent_id"], fields["look_name"] = "character", "parent", "白衬衫"
			}
			if err := db.Model(&model.DramaCast{}).Where("id = ?", "view-cast").Updates(fields).Error; err != nil {
				t.Fatal(err)
			}
			view.Config.ImageOptions.Resolution = ""
			p, _ := s.repo.DramaProduction("view-project")
			cast, _ := s.repo.DramaCast("view-project", "view-cast")
			var err error
			view, err = s.SaveDramaCastView("user", "view-project", "view-cast", view.ID, DramaCastViewSaveRequest{ExpectedRevision: &p.Revision, ExpectedCastRevision: &cast.Revision, ViewRevision: &view.Revision, Config: view.Config})
			if err != nil {
				t.Fatal(err)
			}
			task, err := s.ExecuteDramaCastView("user", "view-project", "view-cast", view.ID, confirmedCastView(t, s, view.ID, "kind-refs"))
			if err != nil {
				t.Fatal(err)
			}
			stored, _ := s.repo.Task(task.ID)
			var input struct {
				References []struct {
					StorageKey string `json:"storageKey"`
				} `json:"referenceImages"`
			}
			if err := json.Unmarshal([]byte(stored.InputJSON), &input); err != nil {
				t.Fatal(err)
			}
			want := []string{"view-own", "view-subject", "view-style"}
			if kind == "look" {
				want = append([]string{"view-parent"}, want...)
			}
			if len(input.References) != len(want) {
				t.Fatalf("reference count %+v", input.References)
			}
			for i, id := range want {
				if input.References[i].StorageKey != "resource:"+id {
					t.Fatalf("reference %d = %s, want %s", i, input.References[i].StorageKey, id)
				}
			}
			if !strings.Contains(stored.Prompt, "仅生成正面单视图") || !strings.Contains(stored.Prompt, "仅参考画风") {
				t.Fatalf("direction or reference group lost: %s", stored.Prompt)
			}
		})
	}
}
