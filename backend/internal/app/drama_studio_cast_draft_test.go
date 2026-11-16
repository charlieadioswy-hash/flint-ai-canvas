package app

import (
	"reflect"
	"strings"
	"testing"

	"yingce/backend/internal/model"
)

func TestDramaStudioCastDraftIsReadOnlyAndCannotExecute(t *testing.T) {
	svc, fake, projectID, detail := dramaStudioFixture(t)
	casts, _ := svc.repo.DramaCasts(projectID)
	if err := svc.repo.UpdateDramaCastFields(casts[0].ID, map[string]any{"locked": true}); err != nil {
		t.Fatal(err)
	}
	before, _ := svc.repo.DramaCast(projectID, casts[0].ID)
	pBefore, _ := svc.repo.DramaProduction(projectID)
	appearance, prompt := "尚未保存的角色外观", "只用本次草稿里的蓝色服装"
	req := DramaStudioActionRequest{Action: "cast_image", TargetID: before.ID, EpisodeID: detail.Episode.ID, TargetRevision: &before.Revision, BaseRevision: &pBefore.Revision, CastDraft: &DramaStudioCastDraft{Appearance: &appearance, ImagePrompt: &prompt, Unlock: true}}
	view, err := svc.PreflightDramaStudioAction("usr-drama", projectID, req)
	if err != nil || !view.Ready || view.TargetRevision != before.Revision || view.EpisodeID != detail.Episode.ID {
		t.Fatalf("draft preflight = %+v %v", view, err)
	}
	after, _ := svc.repo.DramaCast(projectID, before.ID)
	pAfter, _ := svc.repo.DramaProduction(projectID)
	if !reflect.DeepEqual(before, after) || !reflect.DeepEqual(pBefore, pAfter) || fake.byKind["image"] != 0 || fake.byKind["video"] != 0 {
		t.Fatal("draft preflight persisted configuration, unlock or media work")
	}
	req.ConfirmationToken = view.ConfirmationToken
	if _, err := svc.ExecuteDramaStudioAction("usr-drama", projectID, req); !isAppErrorStatus(err, 400) {
		t.Fatalf("draft execution accepted: %v", err)
	}
	for _, scope := range []struct{ user, target, episode string }{{"other", before.ID, detail.Episode.ID}, {"usr-drama", "foreign-cast", detail.Episode.ID}, {"usr-drama", before.ID, "foreign-episode"}} {
		foreign := req
		foreign.TargetID, foreign.EpisodeID = scope.target, scope.episode
		if _, err := svc.PreflightDramaStudioAction(scope.user, projectID, foreign); err == nil {
			t.Fatalf("foreign draft scope accepted: %+v", scope)
		}
	}
}

func TestDramaStudioCastDraftValidatesTextOptionsAndAction(t *testing.T) {
	svc, fake, projectID, detail := dramaStudioFixture(t)
	casts, _ := svc.repo.DramaCasts(projectID)
	tooLong := strings.Repeat("字", 1001)
	tooLongPrompt := strings.Repeat("字", 12001)
	for _, draft := range []DramaStudioCastDraft{
		{Appearance: &tooLong},
		{ImagePrompt: &tooLongPrompt},
		{ImageOptions: &DramaCastImageOptions{Model: DramaModelChoice{ChannelID: "incomplete"}}},
	} {
		view, err := svc.PreflightDramaStudioAction("usr-drama", projectID, DramaStudioActionRequest{Action: "cast_image", TargetID: casts[0].ID, CastDraft: &draft})
		if err == nil && view.Ready {
			t.Fatalf("invalid draft accepted: %+v", draft)
		}
	}
	if _, err := svc.PreflightDramaStudioAction("usr-drama", projectID, DramaStudioActionRequest{Action: "segment_video", TargetID: detail.Segments[0].ID, CastDraft: &DramaStudioCastDraft{}}); !isAppErrorStatus(err, 400) {
		t.Fatalf("image draft accepted for video: %v", err)
	}
	staleRevision := casts[0].Revision + 1
	if _, err := svc.PreflightDramaStudioAction("usr-drama", projectID, DramaStudioActionRequest{Action: "cast_image", TargetID: casts[0].ID, TargetRevision: &staleRevision, CastDraft: &DramaStudioCastDraft{}}); !isAppErrorStatus(err, 409) {
		t.Fatalf("stale asset draft accepted: %v", err)
	}
	var queued int64
	if err := fake.db.Model(&model.DramaJob{}).Where("project_id = ? AND kind = ?", projectID, model.DramaJobCastImage).Count(&queued).Error; err != nil || queued != 0 {
		t.Fatalf("invalid quote queued image work: %d %v", queued, err)
	}
}

func TestDramaStudioCastDraftScopeSurvivesSavingAndDetectsSamePriceChanges(t *testing.T) {
	svc, fake, projectID, detail := dramaStudioFixture(t)
	seedDramaStudioBatchImagePrice(t, fake)
	casts, _ := svc.repo.DramaCasts(projectID)
	cast := casts[0]
	p, _ := svc.repo.DramaProduction(projectID)
	name, appearance, prompt := "新角色名称", "蓝衣短发", "一张角色设定图"
	styleID, styleName, stylePrompt := "custom", "暖色电影", "暖色电影灯光"
	options := DramaCastImageOptions{Ratio: "16:9", Resolution: "1k"}
	draft := DramaStudioCastDraft{Name: &name, Appearance: &appearance, ImagePrompt: &prompt, ImageStyleID: &styleID, ImageStyleName: &styleName, ImageStylePrompt: &stylePrompt, ImageOptions: &options}
	req := DramaStudioActionRequest{Action: "cast_image", TargetID: cast.ID, EpisodeID: detail.Episode.ID, CastDraft: &draft}
	quoted, err := svc.PreflightDramaStudioAction("usr-drama", projectID, req)
	if err != nil || !quoted.Ready || !quoted.Priced || quoted.ScopeHash == "" {
		t.Fatalf("draft scope quote: %+v %v", quoted, err)
	}
	batchReq := DramaStudioBatchRequest{Action: "cast_image", TargetIDs: []string{cast.ID}, EpisodeID: detail.Episode.ID, Regenerate: true, CastDrafts: map[string]DramaStudioCastDraft{cast.ID: draft}}
	batchQuote, err := svc.PreflightDramaStudioBatch("usr-drama", projectID, batchReq)
	if err != nil || !batchQuote.Ready || batchQuote.ScopeHash == "" {
		t.Fatalf("draft batch scope quote: %+v %v", batchQuote, err)
	}
	if _, err := svc.UpdateDramaCast("usr-drama", projectID, cast.ID, UpdateDramaCastRequest{EpisodeID: detail.Episode.ID, ExpectedRevision: &p.Revision, ExpectedCastRevision: &cast.Revision, Name: &name, Appearance: &appearance, ImagePrompt: &prompt, ImageStyleID: &styleID, ImageStyleName: &styleName, ImageStylePrompt: &stylePrompt, ImageOptions: &options}); err != nil {
		t.Fatal(err)
	}
	req.CastDraft = nil
	fresh, err := svc.PreflightDramaStudioAction("usr-drama", projectID, req)
	if err != nil || !fresh.Ready || fresh.ScopeHash != quoted.ScopeHash || fresh.ConfirmationToken == quoted.ConfirmationToken || fresh.AmountMicrocredits != quoted.AmountMicrocredits {
		t.Fatalf("saving identical draft must preserve scope but refresh execution token: before=%+v after=%+v %v", quoted, fresh, err)
	}
	batchReq.CastDrafts = nil
	batchFresh, err := svc.PreflightDramaStudioBatch("usr-drama", projectID, batchReq)
	if err != nil || batchFresh.ScopeHash != batchQuote.ScopeHash || batchFresh.ConfirmationToken == batchQuote.ConfirmationToken {
		t.Fatalf("batch scope changed only because draft was saved: before=%+v after=%+v %v", batchQuote, batchFresh, err)
	}
	differentPrompt, differentStyle := "一张完全不同的角色设定图", "冷色电影灯光"
	reference := fake.resource("usr-drama", "image", "image/png")
	changedRatio := options
	changedRatio.Ratio = "1:1"
	changedReference := options
	changedReference.SubjectReferenceIDs = []string{reference}
	for _, change := range []DramaStudioCastDraft{{ImagePrompt: &differentPrompt}, {ImageStylePrompt: &differentStyle}, {ImageOptions: &changedRatio}, {ImageOptions: &changedReference}} {
		req.CastDraft = &change
		changed, err := svc.PreflightDramaStudioAction("usr-drama", projectID, req)
		if err != nil || !changed.Ready || changed.ScopeHash == fresh.ScopeHash || changed.AmountMicrocredits != fresh.AmountMicrocredits {
			t.Fatalf("same-price changed generation inputs must alter scope: draft=%+v before=%+v after=%+v %v", change, fresh, changed, err)
		}
		batchReq.CastDrafts = map[string]DramaStudioCastDraft{cast.ID: change}
		changedBatch, err := svc.PreflightDramaStudioBatch("usr-drama", projectID, batchReq)
		if err != nil || changedBatch.ScopeHash == batchFresh.ScopeHash || changedBatch.AmountMicrocredits != batchFresh.AmountMicrocredits {
			t.Fatalf("same-price batch generation inputs must alter scope: %+v %v", changedBatch, err)
		}
	}
}

func TestDramaStudioLookDraftNameAndParentReferenceScope(t *testing.T) {
	svc, fake, projectID, _ := dramaStudioFixture(t)
	casts, _ := svc.repo.DramaCasts(projectID)
	base := casts[0]
	resource := fake.resource("usr-drama", "image", "image/png")
	if err := svc.repo.UpdateDramaCastFields(base.ID, map[string]any{"image_status": model.DramaMediaReady, "image_resource_id": resource}); err != nil {
		t.Fatal(err)
	}
	look := model.DramaCast{ID: newID(), ProjectID: projectID, ParentID: base.ID, Kind: "character", Name: base.Name, LookName: "旧造型", Appearance: "黑衣", Revision: 1}
	if err := fake.db.Create(&look).Error; err != nil {
		t.Fatal(err)
	}
	name := "新造型"
	req := DramaStudioActionRequest{Action: "cast_image", TargetID: look.ID, CastDraft: &DramaStudioCastDraft{Name: &name}}
	quoted, err := svc.PreflightDramaStudioAction("usr-drama", projectID, req)
	if err != nil || !quoted.Ready {
		t.Fatalf("look draft quote: %+v %v", quoted, err)
	}
	if _, err := svc.UpdateDramaCastLook("usr-drama", projectID, look.ID, DramaCastLookRequest{LookName: name, Appearance: look.Appearance}); err != nil {
		t.Fatal(err)
	}
	req.CastDraft = nil
	saved, err := svc.PreflightDramaStudioAction("usr-drama", projectID, req)
	stored, _ := svc.repo.DramaCast(projectID, look.ID)
	if err != nil || saved.ScopeHash != quoted.ScopeHash || stored.Name != base.Name || stored.LookName != name {
		t.Fatalf("look name draft changed identity or scope: %+v %+v %v", saved, stored, err)
	}
	replacement := fake.resource("usr-drama", "image", "image/png")
	if err := svc.repo.UpdateDramaCastFields(base.ID, map[string]any{"image_resource_id": replacement}); err != nil {
		t.Fatal(err)
	}
	changed, err := svc.PreflightDramaStudioAction("usr-drama", projectID, req)
	if err != nil || changed.ScopeHash == saved.ScopeHash || changed.AmountMicrocredits != saved.AmountMicrocredits {
		t.Fatalf("parent reference must participate in stable generation scope: %+v %v", changed, err)
	}
}
