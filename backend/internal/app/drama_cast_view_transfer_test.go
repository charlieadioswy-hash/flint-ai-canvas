package app

import (
	"fmt"
	"net/http"
	"testing"

	"yingce/backend/internal/model"
	"yingce/backend/internal/platform"
)

func TestDramaCastViewTransfersHistoricalPictures(t *testing.T) {
	s, db, first := castViewsFixture(t)
	s.coordinator = platform.NewCoordinatorWithRedis(nil, t.Name())
	const userID, projectID, castID = "user", "view-project", "view-cast"
	cast, err := s.repo.DramaCast(projectID, castID)
	if err != nil {
		t.Fatal(err)
	}
	p, err := s.repo.DramaProduction(projectID)
	if err != nil {
		t.Fatal(err)
	}
	resource := model.Resource{ID: "older-main-picture", UserID: userID, Kind: "image", MimeType: "image/png", Status: model.ResourceStatusReady}
	mainTake := model.DramaTake{ID: "main-picture-take", ProjectID: projectID, OwnerID: castID, Kind: "cast", ResourceID: resource.ID, Prompt: "旧主图提示词"}
	for _, row := range []any{&resource, &mainTake} {
		if err := db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	mainViewID := ""
	req := DramaCastViewAdoptRequest{ExpectedRevision: &p.Revision, ViewRevision: &first.Revision, TakeID: mainTake.ID, SourceViewID: &mainViewID}
	if _, err := s.AdoptDramaCastView(userID, projectID, castID, first.ID, DramaCastViewAdoptRequest{ExpectedRevision: &p.Revision, ViewRevision: &first.Revision, TakeID: mainTake.ID}); !isAppErrorStatus(err, http.StatusNotFound) {
		t.Fatalf("accepted an unscoped main take: %v", err)
	}
	first, err = s.AdoptDramaCastView(userID, projectID, castID, first.ID, req)
	if err != nil || first.Status != "ready" || first.ResourceID != resource.ID || len(first.Takes) != 1 || !first.Takes[0].Current || first.Takes[0].ID == mainTake.ID || first.Takes[0].Prompt != mainTake.Prompt {
		t.Fatalf("main to independent view: %+v %v", first, err)
	}
	p, _ = s.repo.DramaProduction(projectID)
	req.ExpectedRevision, req.ViewRevision = &p.Revision, &first.Revision
	repeated, err := s.AdoptDramaCastView(userID, projectID, castID, first.ID, req)
	fresh, _ := s.repo.DramaProduction(projectID)
	if err != nil || repeated.Revision != first.Revision || len(repeated.Takes) != 1 || fresh.Revision != p.Revision {
		t.Fatalf("duplicate transfer: %+v %v", repeated, err)
	}
	roundTrip := SetDramaCastImageRequest{ExpectedCastRevision: &cast.Revision, ExpectedImageVersion: &cast.ImageVersion, TakeID: first.Takes[0].ID, SourceViewID: first.ID}
	mainResult, err := s.SetDramaCastImage(userID, projectID, castID, roundTrip)
	if err != nil || mainResult["cast"].(*model.DramaCast).ImageTakeID != mainTake.ID {
		t.Fatalf("returning the original image should select its existing version: %+v %v", mainResult, err)
	}
	cast = mainResult["cast"].(*model.DramaCast)

	generate := confirmedCastView(t, s, first.ID, "historical-view-picture")
	task, err := s.ExecuteDramaCastView(userID, projectID, castID, first.ID, generate)
	if err != nil {
		t.Fatal(err)
	}
	p, _ = s.repo.DramaProduction(projectID)
	queued, _ := s.repo.DramaCastView(projectID, castID, first.ID)
	req.ExpectedRevision, req.ViewRevision = &p.Revision, &queued.Revision
	if _, err := s.AdoptDramaCastView(userID, projectID, castID, first.ID, req); !isAppErrorStatus(err, http.StatusConflict) {
		t.Fatalf("replaced pending target view: %v", err)
	}
	completeCastView(t, s, db, task.ID, "generated-view-picture")
	first, err = s.DramaCastView(userID, projectID, castID, first.ID)
	if err != nil || len(first.Takes) != 2 || !first.Takes[0].Current {
		t.Fatalf("failed to generate source view: %+v %v", first, err)
	}
	generated := first.Takes[0]
	// 同一生成任务也可经画布作为主图写入。两条原始版本应各自保留。
	if err := s.repo.CreateDramaTake(&model.DramaTake{
		ID: "canvas-picture-take", ProjectID: projectID, OwnerID: castID, Kind: "cast",
		ResourceID: generated.ResourceID, TaskID: task.ID, Prompt: generated.Prompt,
	}); err != nil {
		t.Fatal(err)
	}
	config := first.Config
	config.Name = "背面"
	zero := int64(0)
	second, err := s.SaveDramaCastView(userID, projectID, castID, "", DramaCastViewSaveRequest{ExpectedRevision: &p.Revision, ExpectedCastRevision: &cast.Revision, ViewRevision: &zero, Config: config})
	if err != nil {
		t.Fatal(err)
	}
	p, _ = s.repo.DramaProduction(projectID)
	req = DramaCastViewAdoptRequest{ExpectedRevision: &p.Revision, ViewRevision: &second.Revision, TakeID: generated.ID, SourceViewID: &first.ID}
	otherCast := model.DramaCast{ID: "other-view-cast", ProjectID: projectID, Kind: "character", Name: "另一个角色"}
	otherView := model.DramaCastView{ID: "other-cast-view", ProjectID: projectID, CastID: otherCast.ID, ConfigJSON: first.ConfigJSON}
	foreignTake := model.DramaTake{ID: "other-view-take", ProjectID: projectID, OwnerID: otherView.ID, Kind: "cast_view", ResourceID: generated.ResourceID}
	for _, row := range []any{&otherCast, &otherView, &foreignTake} {
		if err := db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	foreignReq := req
	foreignReq.TakeID, foreignReq.SourceViewID = foreignTake.ID, &otherView.ID
	if _, err := s.AdoptDramaCastView(userID, projectID, castID, second.ID, foreignReq); !isAppErrorStatus(err, http.StatusNotFound) {
		t.Fatalf("adopted another asset's view: %v", err)
	}
	second, err = s.AdoptDramaCastView(userID, projectID, castID, second.ID, req)
	if err != nil || second.Config.Name != config.Name || second.ResourceID != generated.ResourceID || len(second.Takes) != 1 || !second.Takes[0].Current || second.Takes[0].TaskID != task.ID || second.Takes[0].Prompt != generated.Prompt {
		t.Fatalf("independent view to independent view: %+v %v", second, err)
	}
	completed, err := s.repo.Task(task.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.RegisterDramaCastViewTaskOutput(*completed); err != nil {
		t.Fatalf("reconciling the generated view after transfer: %v", err)
	}

	mainReq := SetDramaCastImageRequest{ExpectedCastRevision: &cast.Revision, ExpectedImageVersion: &cast.ImageVersion, TakeID: generated.ID, SourceViewID: first.ID}
	out, err := s.SetDramaCastImage(userID, projectID, castID, mainReq)
	if err != nil {
		t.Fatal(err)
	}
	main := out["cast"].(*model.DramaCast)
	takes, err := s.repo.DramaTakes(projectID, castID, "cast", 50)
	if err != nil || main.ImageResourceID != generated.ResourceID || main.ImageTakeID == generated.ID || len(takes) != 3 || takes[0].ID != main.ImageTakeID || takes[0].OriginTakeID != generated.ID || takes[0].Prompt != generated.Prompt || takes[1].ID != "canvas-picture-take" || takes[2].ID != mainTake.ID {
		t.Fatalf("independent view to main: %+v %v", takes, err)
	}
	out, err = s.SetDramaCastImage(userID, projectID, castID, mainReq)
	if err != nil || out["unchanged"] != true || out["cast"].(*model.DramaCast).Revision != main.Revision {
		t.Fatalf("main transfer replay: %+v %v", out, err)
	}
	copied, err := s.DramaCastView(userID, projectID, castID, second.ID)
	if err != nil || copied.ResourceID != second.ResourceID || copied.CurrentTakeID != second.CurrentTakeID {
		t.Fatalf("changed the independent view's adopted picture: %+v %v", copied, err)
	}
}

func TestDramaCastViewTransferPreservesDistinctOriginalVersions(t *testing.T) {
	s, db, view := castViewsFixture(t)
	s.coordinator = platform.NewCoordinatorWithRedis(nil, t.Name())
	const userID, projectID, castID = "user", "view-project", "view-cast"
	resource := model.Resource{ID: "shared-picture", UserID: userID, Kind: "image", MimeType: "image/png", Status: model.ResourceStatusReady}
	if err := db.Create(&resource).Error; err != nil {
		t.Fatal(err)
	}
	base := model.DramaTake{ID: "main-first-picture", ProjectID: projectID, OwnerID: castID, Kind: "cast", Version: 1, ResourceID: resource.ID, Prompt: "相同提示词"}
	later := base
	later.ID, later.Version = "main-third-picture", 3
	if err := db.Create(&[]model.DramaTake{base, later}).Error; err != nil {
		t.Fatal(err)
	}

	mainViewID := ""
	var copiedIDs []string
	for _, source := range []model.DramaTake{base, later, base} {
		p, err := s.repo.DramaProduction(projectID)
		if err != nil {
			t.Fatal(err)
		}
		view, err = s.AdoptDramaCastView(userID, projectID, castID, view.ID, DramaCastViewAdoptRequest{
			ExpectedRevision: &p.Revision, ViewRevision: &view.Revision, TakeID: source.ID, SourceViewID: &mainViewID,
		})
		if err != nil {
			t.Fatal(err)
		}
		current, err := s.repo.DramaCastViewTake(projectID, view.ID, view.CurrentTakeID)
		if err != nil || current.OriginTakeID != source.ID {
			t.Fatalf("transferred version does not match source %s: %+v %v", source.ID, current, err)
		}
		copiedIDs = append(copiedIDs, current.ID)
	}
	if len(view.Takes) != 2 || copiedIDs[0] == copiedIDs[1] || copiedIDs[0] != copiedIDs[2] {
		t.Fatalf("distinct transfers or repetition lost identity: %v", copiedIDs)
	}
	cast, err := s.repo.DramaCast(projectID, castID)
	if err != nil {
		t.Fatal(err)
	}
	out, err := s.SetDramaCastImage(userID, projectID, castID, SetDramaCastImageRequest{
		ExpectedCastRevision: &cast.Revision, ExpectedImageVersion: &cast.ImageVersion, TakeID: copiedIDs[0], SourceViewID: view.ID,
	})
	if err != nil || out["cast"].(*model.DramaCast).ImageTakeID != base.ID {
		t.Fatalf("round trip should adopt the exact original %s: %+v %v", base.ID, out, err)
	}
	main, err := s.repo.DramaTakes(projectID, castID, "cast", 50)
	if err != nil || len(main) != 2 {
		t.Fatalf("round trip appended a duplicate: %+v %v", main, err)
	}
}

func TestDramaCastViewTransferReturnsOldCurrentTake(t *testing.T) {
	s, db, view := castViewsFixture(t)
	const userID, projectID, castID = "user", "view-project", "view-cast"
	p, err := s.repo.DramaProduction(projectID)
	if err != nil {
		t.Fatal(err)
	}
	resource := model.Resource{ID: "old-view-picture", UserID: userID, Kind: "image", MimeType: "image/png", Status: model.ResourceStatusReady}
	source := model.DramaTake{ID: "old-main-take", ProjectID: projectID, OwnerID: castID, Kind: "cast", Version: 1, ResourceID: resource.ID}
	for _, row := range []any{&resource, &source} {
		if err := db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	history := make([]model.DramaTake, 101)
	for i := range history {
		history[i] = model.DramaTake{
			ID: fmt.Sprintf("view-take-%d", i+1), ProjectID: projectID, OwnerID: view.ID, Kind: "cast_view",
			Version: i + 1, ResourceID: resource.ID,
		}
	}
	history[0].OriginTakeID = source.ID
	if err := db.Create(&history).Error; err != nil {
		t.Fatal(err)
	}
	mainViewID := ""
	view, err = s.AdoptDramaCastView(userID, projectID, castID, view.ID, DramaCastViewAdoptRequest{
		ExpectedRevision: &p.Revision, ViewRevision: &view.Revision, TakeID: source.ID, SourceViewID: &mainViewID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(view.Takes) != 101 || view.CurrentTakeID != history[0].ID || view.Takes[100].ID != history[0].ID || !view.Takes[100].Current {
		t.Fatalf("selected old version missing or duplicated in history: current=%q, returned=%d", view.CurrentTakeID, len(view.Takes))
	}
}
