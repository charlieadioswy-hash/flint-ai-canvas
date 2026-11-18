package app

import (
	"encoding/json"
	"strings"
	"testing"

	"yingce/backend/internal/model"
)

func TestDramaSegmentReferenceTokensKeepAuthoringIdentity(t *testing.T) {
	raw := "甲（@参考图 01）把参考图03递给参考图2，走到参考图4旁。"
	authored := []dramaSegmentPromptLabel{
		{Identity: "cast:a", Label: "参考图1", Name: "甲"},
		{Identity: "cast:b", Label: "参考图2", Name: "乙"},
		{Identity: "resource:x", Label: "参考图3", Name: "上传图"},
		{Identity: "cast:c", Label: "参考图4", Name: "院门"},
	}
	stored := dramaSegmentEditorPrompt(raw, authored)
	if stored != "甲（@[segment-cast:a]）把参考图3递给乙@[segment-cast:b]，走到院门@[segment-cast:c]旁。" {
		t.Fatalf("authoring text lost identity: %q", stored)
	}
	snapshot, err := json.Marshal(dramaSegmentReferenceLabels{dramaShotMediaDigest(stored): authored})
	if err != nil {
		t.Fatal(err)
	}
	segment := model.DramaSegment{VideoPrompt: stored, ReferenceLabelsJSON: string(snapshot)}
	actual := []DramaSegmentReference{{ResourceID: "x", Label: "参考图1", Name: "上传图"}, {CastID: "b", Label: "参考图2", Name: "乙"}}
	if got := dramaSegmentEditorViewPrompt(segment, stored, actual, false); got != "甲（@[segment-cast:a]）把参考图1递给乙@[segment-cast:b]，走到院门@[segment-cast:c]旁。" {
		t.Fatalf("editor did not reassign the uploaded image to the current label: %q", got)
	}
	if got := resolveDramaSegmentPromptForReferences(segment, actual, actual); got != "甲把参考图1递给乙（参考图2），走到院门旁。" {
		t.Fatalf("unexpected provider order or missing prose: %q", got)
	}
	if got := removeDeletedDramaSegmentCastTokens(stored, map[string]model.DramaCast{"b": {ID: "b"}}); got != "甲把参考图3递给乙@[segment-cast:b]，走到院门旁。" {
		t.Fatalf("deleted assets still present or prose changed: %q", got)
	}
	empty := ""
	if got := dramaSegmentRequestPrompt(segment, DramaSegmentRequest{ResolvedPrompt: &empty}); got != "" {
		t.Fatalf("empty provider prompt fell back to tokens: %q", got)
	}
}

func TestDramaSegmentReferenceEditKeepsReadyDraftAndOriginalNumbers(t *testing.T) {
	f := newDramaGuideRevisionFixture(t, model.DramaGuideStory)
	projectID := f.summary.Project.ID
	references := []string{f.cast.ID, "other"}
	if err := f.fake.db.Create(&model.DramaCast{ID: "other", ProjectID: projectID, Kind: "prop", Name: "钥匙"}).Error; err != nil {
		t.Fatal(err)
	}
	raw := "参考图01走向参考图02。"
	if err := f.fake.db.Model(&f.segment).Updates(map[string]any{"reference_cast_ids_json": encodeStringList(references), "video_prompt": raw, "prompt_status": model.DramaMediaReady, "video_status": model.DramaMediaReady}).Error; err != nil {
		t.Fatal(err)
	}
	visible := []string{"other"}
	revision := f.summary.Production.Revision
	if err := f.svc.UpdateDramaSegment("usr-drama", projectID, f.shot.EpisodeID, f.segment.SegmentIndex, UpdateDramaSegmentRequest{
		ExpectedRevision: &revision, ReferenceCastIDs: &visible,
	}); err != nil {
		t.Fatal(err)
	}
	row, err := f.svc.repo.DramaSegment(projectID, f.segment.ID)
	if err != nil || row.VideoPrompt != raw || row.PromptStatus != model.DramaMediaReady || row.VideoStatus != model.DramaMediaStale {
		t.Fatalf("reference-only adjustment changed the written draft or did not invalidate video: %+v %v", row, err)
	}
	editor := dramaSegmentEditorPrompt(row.VideoPrompt, dramaSegmentAuthoredLabels(*row, row.VideoPrompt, nil, false))
	if !strings.Contains(editor, "@[segment-cast:"+f.cast.ID+"]") || !strings.Contains(editor, "钥匙@[segment-cast:other]") {
		t.Fatalf("old labels took on the new order: %q", editor)
	}
}

func TestDramaSegmentOverrideRebindsEditedNumberWithoutChangingGeneratedDraft(t *testing.T) {
	f := newDramaGuideRevisionFixture(t, model.DramaGuideCompleted)
	first := model.DramaReferenceImage{ResourceID: "first-upload", Name: "楼梯间"}
	second := model.DramaReferenceImage{ResourceID: "second-upload", Name: "窗台"}
	for _, id := range []string{first.ResourceID, second.ResourceID} {
		if err := f.fake.db.Create(&model.Resource{ID: id, UserID: "usr-drama", Kind: "image", MimeType: "image/png", Status: model.ResourceStatusReady}).Error; err != nil {
			t.Fatal(err)
		}
	}
	prompt := "她走向参考图2里的窗户。"
	initial, err := json.Marshal([]model.DramaReferenceImage{first, second})
	if err != nil {
		t.Fatal(err)
	}
	if err := f.fake.db.Model(&f.segment).Updates(map[string]any{"reference_images_json": string(initial), "video_prompt": prompt, "video_prompt_override": prompt}).Error; err != nil {
		t.Fatal(err)
	}
	update := func(patch UpdateDramaSegmentRequest) model.DramaSegment {
		t.Helper()
		if err := f.svc.UpdateDramaSegment("usr-drama", f.summary.Project.ID, f.shot.EpisodeID, f.segment.SegmentIndex, patch); err != nil {
			t.Fatal(err)
		}
		row, err := f.svc.repo.DramaSegment(f.summary.Project.ID, f.segment.ID)
		if err != nil {
			t.Fatal(err)
		}
		return *row
	}
	refs := []DramaSegmentReference{{ResourceID: second.ResourceID, Label: "参考图1", Name: second.Name}, {ResourceID: first.ResourceID, Label: "参考图2", Name: first.Name}}
	reordered := []model.DramaReferenceImage{second, first}
	row := update(UpdateDramaSegmentRequest{ReferenceImages: &reordered})
	if got := dramaSegmentEditorViewPrompt(row, row.VideoPromptOverride, refs, true); got != "她走向参考图1里的窗户。" {
		t.Fatalf("existing override no longer follows its original upload: %q", got)
	}
	row = update(UpdateDramaSegmentRequest{VideoPromptOverride: &prompt})
	if got := resolveDramaSegmentPromptForReferences(row, refs, refs); got != prompt {
		t.Fatalf("saved override did not bind the currently selected slot 2: %q", got)
	}
	if got := dramaSegmentEditorViewPrompt(row, row.VideoPrompt, refs, false); got != "她走向参考图1里的窗户。" {
		t.Fatalf("saving identical override text changed the original model draft: %q", got)
	}
}

func TestDramaSegmentAuthoringIncludesUnselectedShotCast(t *testing.T) {
	cast := model.DramaCast{ID: "actor", Name: "甲", Kind: "character"}
	casts := map[string]model.DramaCast{cast.ID: cast}
	rows := []model.DramaSegment{{ReferenceCastIDsJSON: "[]"}}
	shots := []model.DramaShot{{CastIDsJSON: `["actor"]`}}
	draft := buildDramaSegmentDrafts(DramaSettings{}, dramaBibleMeta{}, shots, casts, rows)[0]
	refs := dramaSegmentAuthoringReferences(DramaSettings{}, dramaBibleMeta{}, draft, casts)
	view := buildDramaSegmentViews(DramaSettings{}, dramaBibleMeta{}, shots, casts, rows)[0]
	if len(draft.view.Request.References) != 0 || len(view.Request.References) != 0 || len(refs) != 1 || refs[0].CastID != cast.ID || len(view.PromptSubjects) != 1 || view.PromptSubjects[0].Name != "甲" {
		t.Fatalf("author/editor subjects and selected attachments disagreed: %+v %+v", refs, view)
	}
}

func TestDramaSegmentWriterPersistsAuthoringSnapshotWithDraft(t *testing.T) {
	f := newDramaGuideRevisionFixture(t, model.DramaGuideStory)
	raw := "参考图01从门边走到参考图02附近。窗口外的冷光照进来，人物缓慢侧身抬手，保持安静，目光跟随画外的脚步声。"
	refs := []dramaSegmentPromptLabel{
		{Identity: "cast:" + f.cast.ID, Label: "参考图1", Name: "原角色"},
		{Identity: "resource:upload", Label: "参考图2", Name: "窗台照片"},
	}
	payload, err := json.Marshal(dramaRevisionPayload{Revision: f.segment.Revision, Seconds: 5, PromptReferences: refs})
	if err != nil {
		t.Fatal(err)
	}
	result, err := json.Marshal(map[string]any{"text": raw})
	if err != nil {
		t.Fatal(err)
	}
	run := &dramaRun{s: f.svc, project: &f.summary.Project}
	if err := run.applySegmentPrompt(&model.DramaJob{ShotID: f.segment.ID, PayloadJSON: string(payload)}, &model.Task{ResultJSON: string(result)}); err != nil {
		t.Fatal(err)
	}
	row, err := f.svc.repo.DramaSegment(f.summary.Project.ID, f.segment.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(row.VideoPrompt, "原角色@[segment-cast:"+f.cast.ID+"]从门边走到参考图2附近") || row.PromptStatus != model.DramaMediaReady || row.VideoPromptOverride != f.segment.VideoPromptOverride {
		t.Fatalf("writer output did not persist subject identity: %+v", row)
	}
	row.VideoPromptOverride = ""
	actual := []DramaSegmentReference{{ResourceID: "upload", Label: "参考图1", Name: "窗台照片"}, {ResourceID: "different", Label: "参考图2", Name: "不相关图片"}}
	if got := resolveDramaSegmentPromptForReferences(*row, actual, actual); !strings.Contains(got, "原角色从门边走到参考图1附近") {
		t.Fatalf("persisted authoring order was lost after removing the subject: %q", got)
	}
}
