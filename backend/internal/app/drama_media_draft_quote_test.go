package app

import (
	"reflect"
	"testing"

	"yingce/backend/internal/model"
)

func TestDramaShotMediaDraftQuoteDoesNotSaveOrAuthorizeExecution(t *testing.T) {
	s, db, saved := shotMediaFixture(t)
	draft := saved.Config
	draft.Prompt = "尚未保存的推门画面"
	preview, err := s.QuoteDramaShotMedia("user", "drama-project", "real-shot", "video", DramaShotMediaSaveRequest{ExpectedRevision: &saved.Revision, Config: draft})
	if err != nil || !preview.Ready || !preview.Priced || preview.ScopeHash == "" || preview.ConfirmationToken != "" || preview.Config.Prompt != draft.Prompt {
		t.Fatalf("draft quote = %+v %v", preview, err)
	}
	after := mustShotMedia(t, s)
	if !reflect.DeepEqual(saved, after) {
		t.Fatal("background quote saved the draft")
	}
	for _, entity := range []any{&model.Task{}, &model.BillingOrder{}, &model.DramaTake{}} {
		var count int64
		if err := db.Model(entity).Count(&count).Error; err != nil || count != 0 {
			t.Fatalf("quote created %T: count=%d error=%v", entity, count, err)
		}
	}
	for _, user := range []string{"other", ""} {
		if _, err := s.QuoteDramaShotMedia(user, "drama-project", "real-shot", "video", DramaShotMediaSaveRequest{ExpectedRevision: &saved.Revision, Config: draft}); err == nil {
			t.Fatal("foreign draft quote accepted")
		}
	}
	updated, err := s.SaveDramaShotMedia("user", "drama-project", "real-shot", "video", DramaShotMediaSaveRequest{ExpectedRevision: &saved.Revision, Config: draft})
	if err != nil {
		t.Fatal(err)
	}
	fresh, err := s.PreflightDramaShotMedia("user", "drama-project", "real-shot", "video", DramaShotMediaActionRequest{ExpectedRevision: &updated.Revision})
	if err != nil || fresh.ScopeHash != preview.ScopeHash || fresh.AmountMicrocredits != preview.AmountMicrocredits || fresh.ConfirmationToken == "" {
		t.Fatalf("saved preflight differs from same draft: %+v %v", fresh, err)
	}
	if _, err := s.QuoteDramaShotMedia("user", "drama-project", "real-shot", "video", DramaShotMediaSaveRequest{ExpectedRevision: &saved.Revision, Config: draft}); !isAppErrorStatus(err, 409) {
		t.Fatalf("stale quote accepted: %v", err)
	}
	if _, err := s.QuoteDramaShotMedia("user", "drama-project", "real-shot", "audio", DramaShotMediaSaveRequest{ExpectedRevision: &updated.Revision, Config: draft}); err == nil {
		t.Fatal("visual draft quote changed the audio flow")
	}
}

func TestDramaStoryboardDraftQuoteDoesNotCreateHistoryAndMatchesSavedScope(t *testing.T) {
	s, db, original := storyboardFixture(t, 2, 2, 4)
	config := original.Config
	config.Prompt = "写实电影光线"
	req := DramaStoryboardCreateRequest{ShotIDs: original.ShotIDs, Rows: 2, Columns: 2, Config: config}
	preview, err := s.QuoteDramaStoryboard("user", "drama-project", req)
	if err != nil || !preview.Ready || !preview.Priced || preview.ScopeHash == "" || preview.ConfirmationToken != "" || preview.BoardID != "" {
		t.Fatalf("storyboard draft quote = %+v %v", preview, err)
	}
	var count int64
	if err := db.Model(&model.DramaStoryboardBoard{}).Count(&count).Error; err != nil || count != 1 {
		t.Fatalf("draft quote created history: %d %v", count, err)
	}
	for _, entity := range []any{&model.Task{}, &model.BillingOrder{}} {
		if err := db.Model(entity).Count(&count).Error; err != nil || count != 0 {
			t.Fatalf("quote created %T: %d %v", entity, count, err)
		}
	}
	if _, err := s.QuoteDramaStoryboard("other", "drama-project", req); err == nil {
		t.Fatal("foreign storyboard quote accepted")
	}
	req.ClientOperationID = "after-draft-quote"
	created, err := s.CreateDramaStoryboard("user", "drama-project", req)
	if err != nil {
		t.Fatal(err)
	}
	fresh, err := s.PreflightDramaStoryboard("user", "drama-project", created.ID, DramaStoryboardActionRequest{ExpectedRevision: &created.Revision})
	if err != nil || fresh.ScopeHash != preview.ScopeHash || fresh.AmountMicrocredits != preview.AmountMicrocredits || fresh.ConfirmationToken == "" {
		t.Fatalf("saved scope differs from draft: %+v %v", fresh, err)
	}
	if err := db.Model(&model.DramaShot{}).Where("id = ?", original.ShotIDs[0]).Update("action", "原稿已改为坐下").Error; err != nil {
		t.Fatal(err)
	}
	changed, err := s.QuoteDramaStoryboard("user", "drama-project", req)
	if err != nil || !changed.Ready || changed.ScopeHash == preview.ScopeHash {
		t.Fatalf("changed shot scope was not detected: %+v %v", changed, err)
	}
}
