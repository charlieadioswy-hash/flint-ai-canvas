package app

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"yingce/backend/internal/model"
)

func TestDramaShotReferenceNamesSaveReadAndPruneBindings(t *testing.T) {
	s, db, saved := shotMediaFixture(t)
	if err := db.Create(&model.Resource{ID: "ref-card", UserID: "user", Kind: "image", Status: model.ResourceStatusReady, MimeType: "image/png"}).Error; err != nil {
		t.Fatal(err)
	}
	config := saved.Config
	config.ReferenceResourceIDs = []string{" ref-card "}
	config.FirstFrameResourceID, config.LastFrameResourceID = " ref-one ", " ref-two "
	config.ReferenceNames = map[string]string{" ref-card ": "  秦子武 · 侧面  ", "ref-one": " 首帧.png ", "ref-two": " 尾帧.png ", "removed-image": strings.Repeat("旧", 121), "": "空资源"}
	view, err := s.SaveDramaShotMedia("user", "drama-project", "real-shot", "video", DramaShotMediaSaveRequest{ExpectedRevision: &saved.Revision, Config: config})
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{"ref-card": "秦子武 · 侧面", "ref-one": "首帧.png", "ref-two": "尾帧.png"}
	if !reflect.DeepEqual(view.Config.ReferenceNames, want) || !reflect.DeepEqual(mustShotMedia(t, s).Config.ReferenceNames, want) {
		t.Fatalf("display names not saved/read with trimmed bindings: %+v", view.Config)
	}
	config = view.Config
	config.ReferenceResourceIDs, config.FirstFrameResourceID = nil, ""
	config.ReferenceNames["ref-two"] = "  "
	updated, err := s.SaveDramaShotMedia("user", "drama-project", "real-shot", "video", DramaShotMediaSaveRequest{ExpectedRevision: &view.Revision, Config: config})
	if err != nil || len(updated.Config.ReferenceNames) != 0 {
		t.Fatalf("removed bindings/empty names retained: %+v, %v", updated.Config.ReferenceNames, err)
	}
	var row model.DramaShotMedia
	if err := db.First(&row, "id = ?", updated.ID).Error; err != nil {
		t.Fatal(err)
	}
	var stored map[string]json.RawMessage
	if err := json.Unmarshal([]byte(row.ConfigJSON), &stored); err != nil {
		t.Fatal(err)
	}
	if _, exists := stored["referenceNames"]; exists {
		t.Fatalf("empty display names must be omitted: %s", row.ConfigJSON)
	}
	for _, entity := range []any{&model.Task{}, &model.BillingOrder{}, &model.DramaTake{}} {
		var count int64
		if err := db.Model(entity).Count(&count).Error; err != nil || count != 0 {
			t.Fatalf("saving labels created %T: %d, %v", entity, count, err)
		}
	}
}

func TestDramaShotReferenceNamesUnicodeLimitAndConflictingTrimmedIDs(t *testing.T) {
	s, _, saved := shotMediaFixture(t)
	config := saved.Config
	config.ReferenceNames = map[string]string{"ref-one": "  " + strings.Repeat("图", 120) + "  "}
	view, err := s.SaveDramaShotMedia("user", "drama-project", "real-shot", "video", DramaShotMediaSaveRequest{ExpectedRevision: &saved.Revision, Config: config})
	if err != nil || view.Config.ReferenceNames["ref-one"] != strings.Repeat("图", 120) {
		t.Fatalf("120 Unicode characters should be accepted after trimming: %+v, %v", view.Config.ReferenceNames, err)
	}
	for name, names := range map[string]map[string]string{
		"too long":                {"ref-one": strings.Repeat("图", 121)},
		"conflicting trimmed IDs": {"ref-one": "主视觉", " ref-one ": "侧面"},
	} {
		t.Run(name, func(t *testing.T) {
			draft := view.Config
			draft.ReferenceNames = names
			if _, err := s.SaveDramaShotMedia("user", "drama-project", "real-shot", "video", DramaShotMediaSaveRequest{ExpectedRevision: &view.Revision, Config: draft}); !isAppErrorStatus(err, 400) {
				t.Fatalf("invalid names accepted: %v", err)
			}
			current := mustShotMedia(t, s)
			if current.Revision != view.Revision || !reflect.DeepEqual(current.Config.ReferenceNames, view.Config.ReferenceNames) {
				t.Fatal("rejected name change modified saved configuration")
			}
		})
	}
}

func TestDramaShotReferenceNamesKeepAtMostTwentyTwoActualImages(t *testing.T) {
	s, db, saved := shotMediaFixture(t)
	config := saved.Config
	config.ReferenceNames = map[string]string{"ref-one": "首帧", "ref-two": "尾帧"}
	for i := 0; i < 20; i++ {
		id := fmt.Sprintf("named-reference-%d", i)
		if err := db.Create(&model.Resource{ID: id, UserID: "user", Kind: "image", Status: model.ResourceStatusReady, MimeType: "image/png"}).Error; err != nil {
			t.Fatal(err)
		}
		config.ReferenceResourceIDs = append(config.ReferenceResourceIDs, id)
		config.ReferenceNames[id] = fmt.Sprintf("参考 %d", i+1)
	}
	config.ReferenceNames["unbound"] = "不再绑定的图"
	view, err := s.SaveDramaShotMedia("user", "drama-project", "real-shot", "video", DramaShotMediaSaveRequest{ExpectedRevision: &saved.Revision, Config: config})
	if err != nil || len(view.Config.ReferenceNames) != 22 || view.Config.ReferenceNames["unbound"] != "" {
		t.Fatalf("names do not follow the bounded attachment set: %+v, %v", view.Config.ReferenceNames, err)
	}
}

func TestDramaShotReferenceNamesChangeScopeButNotTaskInputOrPrice(t *testing.T) {
	s, _, saved := shotMediaFixture(t)
	before, err := s.QuoteDramaShotMedia("user", "drama-project", "real-shot", "video", DramaShotMediaSaveRequest{ExpectedRevision: &saved.Revision, Config: saved.Config})
	if err != nil || !before.Ready {
		t.Fatalf("baseline quote failed: %+v, %v", before, err)
	}
	config := saved.Config
	config.ReferenceNames = map[string]string{"ref-one": "人物主视觉", "ref-two": "上传尾帧.png"}
	after, err := s.QuoteDramaShotMedia("user", "drama-project", "real-shot", "video", DramaShotMediaSaveRequest{ExpectedRevision: &saved.Revision, Config: config})
	if err != nil || !after.Ready || after.AmountMicrocredits != before.AmountMicrocredits || after.ScopeHash == before.ScopeHash {
		t.Fatalf("names must bind scope while keeping price: before=%+v after=%+v err=%v", before, after, err)
	}
	shot, err := s.repo.DramaShot("drama-project", "real-shot")
	if err != nil {
		t.Fatal(err)
	}
	original, err := s.dramaShotMediaInput(s.repo, "user", *shot, "video", before.Config)
	if err != nil {
		t.Fatal(err)
	}
	renamed, err := s.dramaShotMediaInput(s.repo, "user", *shot, "video", after.Config)
	if err != nil || !reflect.DeepEqual(original, renamed) {
		t.Fatalf("display names altered generation input: %v", err)
	}
}
