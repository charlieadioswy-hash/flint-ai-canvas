package app

import (
	"strings"
	"testing"

	"yingce/backend/internal/model"
	"yingce/backend/internal/production"
)

func TestDramaSourceReferenceExcludedFromEpisodeDirectory(t *testing.T) {
	svc, _ := newDramaTestService(t)
	request := CreateDramaRequest{
		Name: "带人物小传的剧本", Guided: true, SourceFormat: production.SourceScript,
		Settings: DramaSettings{Models: fakeDramaModels}, ReferenceText: "  人物小传\r\n乙是楼上的邻居。  ",
		Chapters: []DramaChapterInput{{Title: "第一集", Text: "甲走进大厅。"}, {Title: "第二集", Text: "甲走到窗边。"}},
	}
	draft, err := svc.CreateDrama("usr-drama", request)
	if err != nil {
		t.Fatal(err)
	}
	projectID := draft.Project.ID
	if len(draft.Episodes) != 2 || draft.Episodes[0].Number != 1 || draft.Episodes[0].Title != "第一集" {
		t.Fatalf("reference must not occupy an episode: %+v", draft.Episodes)
	}
	reference, err := svc.repo.DramaSourceReference(projectID)
	if err != nil || reference == nil || reference.SourceText != "人物小传\n乙是楼上的邻居。" {
		t.Fatalf("reference source was not saved verbatim: %+v, %v", reference, err)
	}
	outline, err := svc.DramaChapterOutline("usr-drama", projectID)
	if err != nil || len(outline) != 2 {
		t.Fatalf("reference must be out of the chapter outline: %+v, %v", outline, err)
	}
	if units, err := svc.repo.DramaChaptersByIDs(projectID, []string{reference.ID}); err != nil || len(units) != 0 {
		t.Fatalf("reference cannot be selected as episode source: %+v, %v", units, err)
	}
	if _, err := svc.GetProjectUnit("usr-drama", projectID, reference.ID); err == nil {
		t.Fatal("reference must be outside the generic chapter API")
	}
	if source, err := svc.DramaSourceExport("usr-drama", projectID); err != nil || source.Revision != draft.Production.Revision || source.SourceFormat != production.SourceScript || source.ReferenceText != reference.SourceText || len(source.Chapters) != 2 || source.Chapters[0].ID != outline[0].ID || source.Chapters[1].DramaChapterInput != request.Chapters[1] {
		t.Fatalf("read source export: %+v, %v", source, err)
	}
	if _, err := svc.DramaSourceExport("other-user", projectID); err == nil {
		t.Fatal("source export is only available to the project owner")
	}
	updated, err := svc.UpdateDramaGuideSource("usr-drama", projectID, UpdateDramaGuideSourceRequest{
		ExpectedRevision: draft.Production.Revision, SourceFormat: production.SourceScript,
	})
	if err != nil {
		t.Fatal(err)
	}
	if kept, err := svc.repo.DramaSourceReference(projectID); err != nil || kept == nil || kept.ID != reference.ID {
		t.Fatalf("metadata edit must keep reference source: %+v, %v", kept, err)
	}
	oversized := strings.Repeat("甲", production.ScriptSourceChapterRunes+1)
	if _, err := svc.UpdateDramaGuideSource("usr-drama", projectID, UpdateDramaGuideSourceRequest{
		ExpectedRevision: updated.Production.Revision, Chapters: request.Chapters, ReferenceText: &oversized,
	}); err == nil {
		t.Fatal("oversized source reference must be rejected")
	}
	if kept, err := svc.repo.DramaSourceReference(projectID); err != nil || kept == nil || kept.ID != reference.ID {
		t.Fatalf("invalid replacement changed source reference: %+v, %v", kept, err)
	}
	updated, err = svc.UpdateDramaGuideSource("usr-drama", projectID, UpdateDramaGuideSourceRequest{
		ExpectedRevision: updated.Production.Revision, Chapters: request.Chapters,
	})
	if err != nil {
		t.Fatal(err)
	}
	if kept, err := svc.repo.DramaSourceReference(projectID); err != nil || kept == nil || kept.ID != reference.ID {
		t.Fatalf("replacement omitting reference must keep it: %+v, %v", kept, err)
	}
	empty := ""
	updated, err = svc.UpdateDramaGuideSource("usr-drama", projectID, UpdateDramaGuideSourceRequest{
		ExpectedRevision: updated.Production.Revision, Chapters: request.Chapters, ReferenceText: &empty,
	})
	if err != nil {
		t.Fatal(err)
	}
	if cleared, err := svc.repo.DramaSourceReference(projectID); err != nil || cleared != nil {
		t.Fatalf("explicit empty reference must remove stored context: %+v, %v", cleared, err)
	}
	newReference := "世界设定\n在海边的旅馆里。"
	newChapters := []DramaChapterInput{{Title: "夜渡", Text: "甲乘船离开旅馆。"}}
	updated, err = svc.UpdateDramaGuideSource("usr-drama", projectID, UpdateDramaGuideSourceRequest{
		ExpectedRevision: updated.Production.Revision, Chapters: newChapters,
		ReferenceText: &newReference, SourceFormat: production.SourceNovel,
	})
	if err != nil {
		t.Fatal(err)
	}
	if source, err := svc.DramaSourceExport("usr-drama", projectID); err != nil || source.Revision != updated.Production.Revision || source.SourceFormat != production.SourceNovel || source.ReferenceText != newReference || len(source.Chapters) != 1 || source.Chapters[0].DramaChapterInput != newChapters[0] || source.Chapters[0].ID == outline[0].ID {
		t.Fatalf("read source export after replacement: %+v, %v", source, err)
	}
}

func TestDramaSourceReferenceReplacedWithDraft(t *testing.T) {
	svc, _ := newDramaTestService(t)
	request := CreateDramaRequest{
		Name: "高级台剧本草稿", SourceFormat: production.SourceScript,
		Settings: DramaSettings{Models: fakeDramaModels}, ReferenceText: "人物小传\n甲是老师。",
		Chapters: []DramaChapterInput{{Title: "第一集", Text: "甲走进教室。"}},
	}
	draft, err := svc.CreateDrama("usr-drama", request)
	if err != nil {
		t.Fatal(err)
	}
	request.ReferenceText = "人物小传\n甲是医生。"
	if _, err := svc.SaveDramaDraft("usr-drama", draft.Project.ID, request); err != nil {
		t.Fatal(err)
	}
	reference, err := svc.repo.DramaSourceReference(draft.Project.ID)
	if err != nil || reference == nil || reference.Kind != model.ProjectUnitKindSourceReference || reference.SourceText != request.ReferenceText {
		t.Fatalf("full draft replacement must update reference source: %+v, %v", reference, err)
	}
}
