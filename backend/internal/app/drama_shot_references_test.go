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

func TestDramaShotReferenceSubjectsFollowAdoptedImageThroughExecution(t *testing.T) {
	s, db, saved := shotPromptFixture(t)
	for _, id := range []string{"adopted-image", "uploaded-image"} {
		if err := db.Create(&model.Resource{ID: id, UserID: "user", Kind: "image", Status: model.ResourceStatusReady, MimeType: "image/png"}).Error; err != nil {
			t.Fatal(err)
		}
	}
	draft := saved.Config
	draft.Operation, draft.FirstFrameResourceID, draft.LastFrameResourceID = "reference_to_video", "", ""
	draft.ReferenceResourceIDs = []string{"uploaded-image", "ref-one"}
	draft.ReferenceSubjects = map[string]string{"ref-one": "prompt-hero"}
	draft.ReferenceNames = map[string]string{"ref-one": "秦子武 · 初始版", "uploaded-image": "窗边.png"}
	draft.Prompt = "@[shot-image:ref-one]看向@[shot-image:uploaded-image]，以参考图2为准。"
	saved, err := s.SaveDramaShotMedia("user", "drama-project", "real-shot", "video", DramaShotMediaSaveRequest{ExpectedRevision: &saved.Revision, Config: draft})
	if err != nil {
		t.Fatal(err)
	}
	before := shotMediaConfirmed(t, s, "before-adoption")
	if err := db.Model(&model.DramaCast{}).Where("id = ?", "prompt-hero").Update("image_resource_id", "adopted-image").Error; err != nil {
		t.Fatal(err)
	}
	current := mustShotMedia(t, s)
	if current.Revision != saved.Revision || !reflect.DeepEqual(current.Config.ReferenceResourceIDs, []string{"uploaded-image", "adopted-image"}) ||
		!reflect.DeepEqual(current.Config.ReferenceSubjects, map[string]string{"adopted-image": "prompt-hero"}) ||
		!reflect.DeepEqual(current.Config.ReferenceNames, map[string]string{"uploaded-image": "窗边.png"}) ||
		current.Config.Prompt != "@[shot-image:adopted-image]看向@[shot-image:uploaded-image]，以参考图2为准。" {
		t.Fatalf("reading after adoption affected the wrong binding: %+v", current.Config)
	}
	quote, err := s.QuoteDramaShotMedia("user", "drama-project", "real-shot", "video", DramaShotMediaSaveRequest{ExpectedRevision: &saved.Revision, Config: saved.Config})
	if err != nil || !quote.Ready || !reflect.DeepEqual(quote.Config, current.Config) {
		t.Fatalf("quoting a draft still holding old binding returned a different config: %+v, %v", quote, err)
	}
	if _, err := s.ExecuteDramaShotMedia("user", "drama-project", "real-shot", "video", before); !isAppErrorStatus(err, 409) {
		t.Fatalf("quote for outdated adopted image was accepted: %v", err)
	}
	assertShotReferencesNoTasksOrCharge(t, db)
	task, err := s.ExecuteDramaShotMedia("user", "drama-project", "real-shot", "video", shotMediaConfirmed(t, s, "after-adoption"))
	if err != nil {
		t.Fatal(err)
	}
	stored, err := s.repo.Task(task.ID)
	if err != nil || !strings.Contains(stored.InputJSON, "resource:adopted-image") || !strings.Contains(stored.InputJSON, "resource:uploaded-image") ||
		strings.Contains(stored.InputJSON, "resource:ref-one") || !strings.Contains(stored.Prompt, "参考图2看向参考图1，以参考图2为准。") {
		t.Fatalf("task used wrong reference images or numbering: %+v %v", stored, err)
	}
}

func TestDramaShotReferenceSubjectsRequireCurrentDistinctImages(t *testing.T) {
	s, db, saved := shotPromptFixture(t)
	draft := saved.Config
	draft.Operation, draft.FirstFrameResourceID, draft.LastFrameResourceID = "reference_to_video", "", ""
	draft.ReferenceResourceIDs = []string{"ref-one", "ref-two"}
	draft.ReferenceSubjects = map[string]string{"ref-one": "prompt-hero"}
	for imageID, want := range map[string]string{"": "当前没有可用的采用图", "ref-two": "同一张主体图片"} {
		if err := db.Model(&model.DramaCast{}).Where("id = ?", "prompt-hero").Update("image_resource_id", imageID).Error; err != nil {
			t.Fatal(err)
		}
		request := DramaShotMediaSaveRequest{ExpectedRevision: &saved.Revision, Config: draft}
		quote, err := s.QuoteDramaShotMedia("user", "drama-project", "real-shot", "video", request)
		if err != nil || quote.Ready || !strings.Contains(quote.Reason, want) || !reflect.DeepEqual(quote.Config.ReferenceResourceIDs, draft.ReferenceResourceIDs) {
			t.Fatalf("unresolvable binding shifted slot numbering or was accepted: %+v %v", quote, err)
		}
		if _, err := s.SaveDramaShotMedia("user", "drama-project", "real-shot", "video", request); !isAppErrorStatus(err, 400) {
			t.Fatalf("unresolvable binding was saved: %v", err)
		}
	}
	assertShotReferencesNoTasksOrCharge(t, db)
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
			wantPrompt := draft.Prompt
			if kind == "video" {
				wantPrompt = "秦子武看向秦子文。@[shot-image:ref-one]在左，@[shot-image:ref-two]在右。"
			}
			if err != nil || updated.Config.Prompt != wantPrompt {
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
