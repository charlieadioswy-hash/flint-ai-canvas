package app

import (
	"reflect"
	"strings"
	"testing"

	"gorm.io/gorm"
	"yingce/backend/internal/model"
)

func TestDramaShotStableImageTokensCompileAgainstActualOrder(t *testing.T) {
	for _, tc := range []struct {
		name   string
		prompt string
		refs   []string
		want   string
		bad    bool
	}{
		{"repeated", "@[shot-image:A]走向@[shot-image:B]，保持@[shot-image:A]外观", []string{"A", "B"}, "参考图1走向参考图2，保持参考图1外观", false},
		{"reordered", "@[shot-image:A]走向@[shot-image:B]", []string{"B", "A"}, "参考图2走向参考图1", false},
		{"removed", "保持@[shot-image:A]外观", []string{"B"}, "", true},
		{"legacy out of range", "保持参考图2外观", []string{"A"}, "", true},
		{"legacy valid", "保持参考图1外观", []string{"A"}, "保持参考图1外观", false},
		{"frame roles", "首帧起幅并过渡至尾帧", nil, "首帧起幅并过渡至尾帧", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := compileDramaShotReferencePrompt(DramaShotMediaConfig{Prompt: tc.prompt, ReferenceResourceIDs: tc.refs})
			if tc.bad {
				if !isAppErrorStatus(err, 400) {
					t.Fatalf("invalid reference accepted: %q %v", got, err)
				}
			} else if err != nil || got != tc.want {
				t.Fatalf("compiled prompt = %q, %v; want %q", got, err, tc.want)
			}
		})
	}
}

func assertShotReferencesNoTasksOrCharge(t *testing.T, db *gorm.DB) {
	t.Helper()
	for _, entity := range []any{&model.Task{}, &model.BillingOrder{}} {
		var count int64
		if err := db.Model(entity).Count(&count).Error; err != nil || count != 0 {
			t.Fatalf("reference configuration created %T: %d %v", entity, count, err)
		}
	}
	var wallet model.CreditAccount
	if err := db.First(&wallet, "user_id = ?", "user").Error; err != nil || wallet.AvailableMicrocredits != 10000 || wallet.ReservedMicrocredits != 0 {
		t.Fatalf("reference configuration changed credits: %+v %v", wallet, err)
	}
}

func TestDramaShotStableImageTokenDraftSaveAndAdmission(t *testing.T) {
	s, db, saved := shotPromptFixture(t)
	draft := saved.Config
	draft.Operation, draft.FirstFrameResourceID, draft.LastFrameResourceID = "reference_to_video", "", ""
	draft.ReferenceResourceIDs = []string{"ref-one", "ref-two"}
	draft.Prompt = "秦子武采用@[shot-image:ref-one]的外观。"
	quote, err := s.QuoteDramaShotMedia("user", "drama-project", "real-shot", "video", DramaShotMediaSaveRequest{ExpectedRevision: &saved.Revision, Config: draft})
	if err != nil || !quote.Ready || quote.Config.Prompt != draft.Prompt {
		t.Fatalf("stable-token quote: %+v %v", quote, err)
	}
	updated, err := s.SaveDramaShotMedia("user", "drama-project", "real-shot", "video", DramaShotMediaSaveRequest{ExpectedRevision: &saved.Revision, Config: draft})
	if err != nil || updated.Config.Prompt != draft.Prompt {
		t.Fatalf("save changed stable identity: %+v %v", updated.Config, err)
	}
	preflight, err := s.PreflightDramaShotMedia("user", "drama-project", "real-shot", "video", DramaShotMediaActionRequest{ExpectedRevision: &updated.Revision})
	if err != nil || !preflight.Ready || preflight.ScopeHash != quote.ScopeHash {
		t.Fatalf("quote/save/preflight scope changed: %+v %v", preflight, err)
	}
	draft.ReferenceResourceIDs = []string{"ref-two", "ref-one"}
	plan, err := s.prepareDramaShotMediaDraft(s.repo, "user", "drama-project", "real-shot", "video", DramaShotMediaActionRequest{ExpectedRevision: &updated.Revision}, &draft)
	if err != nil || !plan.view.Ready || !strings.Contains(plan.request.Prompt, "秦子武采用参考图2的外观") || strings.Contains(plan.request.Prompt, "shot-image:") {
		t.Fatalf("provider prompt did not follow resource identity: %+v %v", plan.request, err)
	}
	draft.ReferenceResourceIDs = []string{"ref-two"}
	incomplete, err := s.SaveDramaShotMedia("user", "drama-project", "real-shot", "video", DramaShotMediaSaveRequest{ExpectedRevision: &updated.Revision, Config: draft})
	if err != nil || incomplete.Config.Prompt != draft.Prompt {
		t.Fatalf("intermediate reference draft was not preserved: %+v %v", incomplete.Config, err)
	}
	if _, err := s.QuoteDramaShotMedia("user", "drama-project", "real-shot", "video", DramaShotMediaSaveRequest{ExpectedRevision: &incomplete.Revision, Config: incomplete.Config}); !isAppErrorStatus(err, 400) {
		t.Fatalf("quote accepted removed image token: %v", err)
	}
	if _, err := s.PreflightDramaShotMedia("user", "drama-project", "real-shot", "video", DramaShotMediaActionRequest{ExpectedRevision: &incomplete.Revision}); !isAppErrorStatus(err, 400) {
		t.Fatalf("preflight accepted removed image token: %v", err)
	}
	assertShotReferencesNoTasksOrCharge(t, db)
}

func TestDramaShotReferenceSubjectsPreserveAlternateImages(t *testing.T) {
	for _, source := range []string{"history", "view", "crop", "new subject", "two views"} {
		t.Run(source, func(t *testing.T) {
			s, db, saved := shotPromptFixture(t)
			resourceID := "alternate-subject-image"
			if err := db.Create(&model.Resource{ID: resourceID, UserID: "user", Kind: "image", Status: model.ResourceStatusReady, MimeType: "image/png"}).Error; err != nil {
				t.Fatal(err)
			}
			castID, name := "prompt-hero", "秦子武"
			switch source {
			case "history":
				if err := db.Create(&model.DramaTake{ID: "hero-history", ProjectID: "drama-project", OwnerID: castID, Kind: "cast", Version: 2, ResourceID: resourceID}).Error; err != nil {
					t.Fatal(err)
				}
			case "view", "two views":
				if err := db.Create(&model.DramaCastView{ID: "hero-view", ProjectID: "drama-project", CastID: castID, ResourceID: resourceID, Status: model.DramaMediaReady}).Error; err != nil {
					t.Fatal(err)
				}
			case "new subject":
				castID, name = "extra-subject", "门口路人"
				if err := db.Create(&model.DramaCast{ID: castID, ProjectID: "drama-project", Name: name, Kind: "character", Appearance: "蓝色长衣"}).Error; err != nil {
					t.Fatal(err)
				}
			}
			draft := saved.Config
			draft.Operation, draft.FirstFrameResourceID, draft.LastFrameResourceID = "reference_to_video", "", ""
			draft.ReferenceResourceIDs = []string{resourceID}
			draft.ReferenceSubjects = map[string]string{resourceID: castID}
			if source == "two views" {
				draft.ReferenceResourceIDs = append(draft.ReferenceResourceIDs, "ref-one")
				draft.ReferenceSubjects["ref-one"] = castID
			}
			quote, err := s.QuoteDramaShotMedia("user", "drama-project", "real-shot", "video", DramaShotMediaSaveRequest{ExpectedRevision: &saved.Revision, Config: draft})
			if err != nil || !quote.Ready || !strings.Contains(quote.Config.Prompt, name+"（参考图1）") || strings.Contains(quote.Config.Prompt, "补充图片（参考图1）") || strings.Contains(quote.Config.Prompt, name+"：浅色衬衣") {
				t.Fatalf("alternate image lost subject association:\n%s\n%v", quote.Config.Prompt, err)
			}
			if source == "two views" && !strings.Contains(quote.Config.Prompt, name+"（参考图2）") {
				t.Fatalf("second view lost its attachment number:\n%s", quote.Config.Prompt)
			}
			updated, err := s.SaveDramaShotMedia("user", "drama-project", "real-shot", "video", DramaShotMediaSaveRequest{ExpectedRevision: &saved.Revision, Config: draft})
			if err != nil || !reflect.DeepEqual(updated.Config.ReferenceSubjects, draft.ReferenceSubjects) {
				t.Fatalf("subject mapping not persisted: %+v %v", updated.Config.ReferenceSubjects, err)
			}
			preflight, err := s.PreflightDramaShotMedia("user", "drama-project", "real-shot", "video", DramaShotMediaActionRequest{ExpectedRevision: &updated.Revision})
			if err != nil || !preflight.Ready || preflight.ScopeHash != quote.ScopeHash {
				t.Fatalf("subject mapping quote/save/preflight differs: %+v %v", preflight, err)
			}
			assertShotReferencesNoTasksOrCharge(t, db)
		})
	}
}

func TestDramaShotReferenceSubjectsValidateOwnershipAndPruneBindings(t *testing.T) {
	s, db, saved := shotPromptFixture(t)
	if err := db.Create(&model.DramaCast{ID: "foreign-cast", ProjectID: "other-project", Name: "其他作品主体", Kind: "character"}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.Resource{ID: "foreign-image", UserID: "other-user", Kind: "image", Status: model.ResourceStatusReady, MimeType: "image/png"}).Error; err != nil {
		t.Fatal(err)
	}
	for name, subjects := range map[string]map[string]string{
		"other project": {"ref-one": "foreign-cast"},
		"missing":       {"ref-one": "missing-cast"},
		"empty":         {"ref-one": ""},
	} {
		t.Run(name, func(t *testing.T) {
			draft := saved.Config
			draft.ReferenceSubjects = subjects
			if _, err := s.SaveDramaShotMedia("user", "drama-project", "real-shot", "video", DramaShotMediaSaveRequest{ExpectedRevision: &saved.Revision, Config: draft}); !isAppErrorStatus(err, 400) {
				t.Fatalf("invalid subject accepted: %v", err)
			}
		})
	}
	draft := saved.Config
	draft.FirstFrameResourceID = "foreign-image"
	draft.ReferenceSubjects = map[string]string{"foreign-image": "prompt-hero"}
	if _, err := s.SaveDramaShotMedia("user", "drama-project", "real-shot", "video", DramaShotMediaSaveRequest{ExpectedRevision: &saved.Revision, Config: draft}); !isAppErrorStatus(err, 400) {
		t.Fatalf("another user's resource accepted: %v", err)
	}
	draft = saved.Config
	draft.ReferenceSubjects = map[string]string{" ref-one ": " prompt-hero ", "removed-resource": "foreign-cast"}
	updated, err := s.SaveDramaShotMedia("user", "drama-project", "real-shot", "video", DramaShotMediaSaveRequest{ExpectedRevision: &saved.Revision, Config: draft})
	if err != nil || !reflect.DeepEqual(updated.Config.ReferenceSubjects, map[string]string{"ref-one": "prompt-hero"}) || !strings.Contains(updated.Config.Prompt, "首帧中的主体外观") {
		t.Fatalf("frame association or pruning failed: %+v %v", updated.Config, err)
	}
	assertShotReferencesNoTasksOrCharge(t, db)
}

func TestDramaShotManualPromptsKeepExplicitSubjectImageBindings(t *testing.T) {
	for _, kind := range []string{"image", "video"} {
		t.Run(kind, func(t *testing.T) {
			s, db, saved := shotPromptFixture(t)
			for resourceID, castID := range map[string]string{"alternate-hero": "prompt-hero", "alternate-brother": "prompt-brother"} {
				if err := db.Create(&model.Resource{ID: resourceID, UserID: "user", Kind: "image", Status: model.ResourceStatusReady, MimeType: "image/png"}).Error; err != nil {
					t.Fatal(err)
				}
				if err := db.Create(&model.DramaTake{ID: resourceID + "-take", ProjectID: "drama-project", OwnerID: castID, Kind: "cast", Version: 2, ResourceID: resourceID}).Error; err != nil {
					t.Fatal(err)
				}
			}
			draft := saved.Config
			draft.Operation, draft.FirstFrameResourceID, draft.LastFrameResourceID = "reference_to_video", "", ""
			revision := saved.Revision
			if kind == "image" {
				draft.Operation, revision = "image_to_image", 0
			}
			draft.ReferenceResourceIDs = []string{"alternate-brother", "alternate-hero"}
			draft.ReferenceSubjects = map[string]string{"alternate-hero": "prompt-hero", "alternate-brother": "prompt-brother"}
			draft.Prompt = "秦子武看向秦子文。@[shot-image:alternate-hero]在左，@[shot-image:alternate-brother]在右。"
			updated, err := s.SaveDramaShotMedia("user", "drama-project", "real-shot", kind, DramaShotMediaSaveRequest{ExpectedRevision: &revision, Config: draft})
			if err != nil || updated.Config.Prompt != draft.Prompt {
				t.Fatalf("manual prompt changed on save: %+v %v", updated.Config, err)
			}
			shot, err := s.repo.DramaShot("drama-project", "real-shot")
			if err != nil {
				t.Fatal(err)
			}
			input, err := s.dramaShotMediaInput(s.repo, "user", *shot, kind, updated.Config)
			if err != nil {
				t.Fatal(err)
			}
			prompt := input["prompt"].(string)
			for _, want := range []string{"参考图1对应秦子文", "参考图2对应秦子武", "参考图2在左，参考图1在右。"} {
				if !strings.Contains(prompt, want) {
					t.Fatalf("provider prompt lacks %q:\n%s", want, prompt)
				}
			}
			if strings.Contains(prompt, "@[shot-image:") {
				t.Fatal("stable token leaked into provider request")
			}
			if kind == "video" {
				quote, err := s.QuoteDramaShotMedia("user", "drama-project", "real-shot", kind, DramaShotMediaSaveRequest{ExpectedRevision: &updated.Revision, Config: updated.Config})
				if err != nil || !quote.Ready {
					t.Fatalf("manual subject quote: %+v %v", quote, err)
				}
				plan, err := s.prepareDramaShotMedia(s.repo, "user", "drama-project", "real-shot", kind, DramaShotMediaActionRequest{ExpectedRevision: &updated.Revision})
				if err != nil || !plan.view.Ready || plan.view.ScopeHash != quote.ScopeHash || plan.request.Prompt != prompt || plan.request.Input["prompt"] != prompt {
					t.Fatalf("manual prompt differs between quote and execution input: %+v %v", plan.view, err)
				}
			}
			assertShotReferencesNoTasksOrCharge(t, db)
		})
	}
}
