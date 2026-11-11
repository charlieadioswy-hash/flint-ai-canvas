package app

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"yingce/backend/internal/model"
	"yingce/backend/internal/repository"

	"gorm.io/gorm"
)

func newDramaCastGuide(t *testing.T) (*Service, *fakeDramaBackend, string, int64) {
	t.Helper()
	svc, fake := newDramaTestService(t)
	summary := createGuidedDrama(t, svc)
	if err := fake.db.Model(&model.DramaProduction{}).Where("project_id = ?", summary.Project.ID).
		Updates(map[string]any{"guide_step": model.DramaGuideAssets, "stage": model.DramaStageProduce}).Error; err != nil {
		t.Fatal(err)
	}
	return svc, fake, summary.Project.ID, summary.Production.Revision
}

func TestDramaCastCreateUsesGuideRevisionAndLeavesMediaManual(t *testing.T) {
	svc, fake, projectID, revision := newDramaCastGuide(t)
	request := CreateDramaCastRequest{ExpectedRevision: &revision, Kind: "character", Name: "  林夏  ", Aliases: []string{" 小夏 ", ""}, Appearance: "  黑色短发  ", Description: "  调查员  ", VoiceInstructions: " 冷静 "}
	cast, err := svc.CreateDramaCast("usr-drama", projectID, request)
	if err != nil {
		t.Fatal(err)
	}
	if cast.ID == "" || cast.Name != "林夏" || cast.Appearance != "黑色短发" || cast.Description != "调查员" || cast.VoiceInstructions != "冷静" || cast.AliasesJSON != `["小夏"]` || cast.ImageStatus != "" || cast.ImageResourceID != "" {
		t.Fatalf("unexpected text asset: %+v", cast)
	}
	p, _ := svc.repo.DramaProduction(projectID)
	if p.Revision != revision+1 {
		t.Fatalf("create must advance production revision once: %+v", p)
	}
	_, err = svc.CreateDramaCast("usr-drama", projectID, request)
	requireGuideConflict(t, err)
	request.ExpectedRevision = &p.Revision
	_, err = svc.CreateDramaCast("usr-drama", projectID, request)
	requireGuideConflict(t, err)
	request.Kind = "scene"
	if _, err = svc.CreateDramaCast("usr-drama", projectID, request); err != nil {
		t.Fatalf("same name is allowed for another kind: %v", err)
	}
	p, _ = svc.repo.DramaProduction(projectID)
	if err := fake.db.Model(p).Update("guide_step", model.DramaGuideStory).Error; err != nil {
		t.Fatal(err)
	}
	request.Kind, request.Name, request.ExpectedRevision = "prop", "证件", &p.Revision
	if _, err = svc.CreateDramaCast("usr-drama", projectID, request); err != nil {
		t.Fatal(err)
	}
	p, _ = svc.repo.DramaProduction(projectID)
	if p.GuideStep != model.DramaGuideAssets || p.Revision != revision+3 {
		t.Fatalf("story text edit must return to asset confirmation: %+v", p)
	}
	var jobs int64
	if err := fake.db.Model(&model.DramaJob{}).Where("project_id = ?", projectID).Count(&jobs).Error; err != nil || jobs != 0 || len(fake.requests) != 0 {
		t.Fatalf("text creation must not dispatch media: jobs=%d requests=%d error=%v", jobs, len(fake.requests), err)
	}
}

func TestDramaCastCreateRejectsInvalidOrUnavailableEdits(t *testing.T) {
	svc, fake, projectID, revision := newDramaCastGuide(t)
	for _, request := range []CreateDramaCastRequest{
		{Kind: "character", Name: "角色"},
		{ExpectedRevision: &revision, Kind: "environment", Name: "场景"},
		{ExpectedRevision: &revision, Kind: "character", Name: " "},
		{ExpectedRevision: &revision, Kind: "character", Name: strings.Repeat("名", 61)},
	} {
		if _, err := svc.CreateDramaCast("usr-drama", projectID, request); err == nil {
			t.Fatalf("accepted invalid request: %+v", request)
		}
	}
	request := CreateDramaCastRequest{ExpectedRevision: &revision, Kind: "character", Name: "角色"}
	if _, err := svc.CreateDramaCast("other-user", projectID, request); err == nil {
		t.Fatal("another user must not create assets")
	}
	for _, step := range []string{model.DramaGuideConfiguring} {
		if err := fake.db.Model(&model.DramaProduction{}).Where("project_id = ?", projectID).Update("guide_step", step).Error; err != nil {
			t.Fatal(err)
		}
		_, err := svc.CreateDramaCast("usr-drama", projectID, request)
		requireGuideConflict(t, err)
	}
	if err := fake.db.Model(&model.DramaProduction{}).Where("project_id = ?", projectID).Update("guide_step", model.DramaGuideAssets).Error; err != nil {
		t.Fatal(err)
	}
	if err := fake.db.Create(&model.DramaJob{ID: "text-job", ProjectID: projectID, Kind: model.DramaJobBible, Status: model.DramaJobRunning}).Error; err != nil {
		t.Fatal(err)
	}
	_, err := svc.CreateDramaCast("usr-drama", projectID, request)
	requireGuideConflict(t, err)
	p, _ := svc.repo.DramaProduction(projectID)
	if p.Revision != revision {
		t.Fatal("rejected edits must not advance revision")
	}
}

func TestDramaCastDeleteRetainsGeneratedMediaAndHistory(t *testing.T) {
	for _, hasTake := range []bool{false, true} {
		t.Run(map[bool]string{false: "legacy-image", true: "existing-take"}[hasTake], func(t *testing.T) {
			svc, fake, projectID, revision := newDramaCastGuide(t)
			cast := model.DramaCast{ID: "cast-delete", ProjectID: projectID, Kind: "character", Name: "待删角色", ImageResourceID: "keep-image", ImageStatus: model.DramaMediaReady}
			for _, record := range []any{
				&cast,
				&model.Resource{ID: "keep-image", UserID: "usr-drama", Kind: "image"},
				&model.Asset{ID: "keep-asset", UserID: "usr-drama", Kind: "image", PayloadJSON: `{"resourceId":"keep-image"}`},
				&model.Task{ID: "keep-task", UserID: "usr-drama", ProjectID: projectID, Status: model.TaskStatusSucceeded},
				&model.DramaJob{ID: "keep-job", ProjectID: projectID, CastID: cast.ID, Kind: model.DramaJobCastImage, Status: model.DramaJobSucceeded, TaskID: "keep-task", AttemptsJSON: `[{"taskId":"keep-task"}]`},
				&model.DramaJob{ID: "cancel-queued", ProjectID: projectID, CastID: cast.ID, Kind: model.DramaJobCastImage, Status: model.DramaJobQueued},
			} {
				if err := fake.db.Create(record).Error; err != nil {
					t.Fatal(err)
				}
			}
			if hasTake {
				if err := fake.db.Create(&model.DramaTake{ID: "keep-take", ProjectID: projectID, OwnerID: cast.ID, Kind: "cast", ResourceID: cast.ImageResourceID, TaskID: "keep-task", Version: 1}).Error; err != nil {
					t.Fatal(err)
				}
			}
			if err := svc.DeleteDramaCast("usr-drama", projectID, cast.ID, DeleteDramaCastRequest{ExpectedRevision: &revision}); err != nil {
				t.Fatal(err)
			}
			if _, err := svc.repo.DramaCast(projectID, cast.ID); !errors.Is(err, gorm.ErrRecordNotFound) {
				t.Fatalf("catalog row remains: %v", err)
			}
			for _, record := range []any{&model.Resource{}, &model.Asset{}, &model.Task{}, &model.DramaJob{}} {
				var count int64
				if err := fake.db.Model(record).Where("id LIKE ?", "keep-%").Count(&count).Error; err != nil || count != 1 {
					t.Fatalf("history/media removed: %T count=%d err=%v", record, count, err)
				}
			}
			takes, err := svc.repo.DramaTakes(projectID, cast.ID, "cast", 10)
			if err != nil || len(takes) != 1 || takes[0].ResourceID != "keep-image" {
				t.Fatalf("image must remain protected by history: %+v %v", takes, err)
			}
			var queued model.DramaJob
			if err := fake.db.First(&queued, "id = ?", "cancel-queued").Error; err != nil || queued.Status != model.DramaJobCanceled {
				t.Fatalf("unsubmitted job must be canceled: %+v %v", queued, err)
			}
			queued.Status, queued.TaskID = model.DramaJobRunning, "late-task"
			if err := svc.repo.BindDramaJobTask(&queued, model.DramaJobQueued, ""); !errors.Is(err, repository.ErrDramaJobChanged) {
				t.Fatalf("stale dispatcher must lose binding CAS: %v", err)
			}
			p, _ := svc.repo.DramaProduction(projectID)
			if p.Revision != revision+1 {
				t.Fatal("delete must advance revision once")
			}
		})
	}
}

func TestDramaCastDeleteRejectsLiveReferencesAndInflightTasks(t *testing.T) {
	for _, reference := range []string{"look", "shot-scene", "shot-character", "shot-prop", "shot-look", "segment", "canvas", "running-job", "bound-queued-job", "historical-active-task", "running-image"} {
		t.Run(reference, func(t *testing.T) {
			svc, fake, projectID, revision := newDramaCastGuide(t)
			cast := model.DramaCast{ID: "protected-cast", ProjectID: projectID, Kind: "character", Name: "被引用角色"}
			if reference == "running-image" {
				cast.ImageStatus = model.DramaMediaRunning
			}
			if err := fake.db.Create(&cast).Error; err != nil {
				t.Fatal(err)
			}
			var record any
			switch reference {
			case "look":
				record = &model.DramaCast{ID: "look", ProjectID: projectID, Kind: "character", ParentID: cast.ID}
			case "shot-scene":
				record = &model.DramaShot{ID: "shot", ProjectID: projectID, SceneCastID: cast.ID}
			case "shot-character":
				record = &model.DramaShot{ID: "shot", ProjectID: projectID, CastIDsJSON: `["protected-cast"]`}
			case "shot-prop":
				record = &model.DramaShot{ID: "shot", ProjectID: projectID, PropIDsJSON: `["protected-cast"]`}
			case "shot-look":
				record = &model.DramaShot{ID: "shot", ProjectID: projectID, LookCastIDsJSON: `["protected-cast"]`}
			case "segment":
				record = &model.DramaSegment{ID: "segment", ProjectID: projectID, ReferenceCastIDsJSON: `["protected-cast"]`}
			case "canvas":
				payload, _ := json.Marshal(map[string]any{"nodes": []any{map[string]any{"metadata": map[string]any{"dramaRef": map[string]any{"projectId": projectID, "kind": "cast", "id": cast.ID}}}}})
				record = &model.CanvasProject{ID: "canvas", UserID: "usr-drama", PayloadJSON: string(payload)}
			case "running-job":
				record = &model.DramaJob{ID: "job", ProjectID: projectID, CastID: cast.ID, Status: model.DramaJobRunning}
			case "bound-queued-job":
				record = &model.DramaJob{ID: "job", ProjectID: projectID, CastID: cast.ID, Status: model.DramaJobQueued, TaskID: "submitted-task"}
			case "historical-active-task":
				if err := fake.db.Create(&model.Task{ID: "active-task", UserID: "usr-drama", ProjectID: projectID, Status: model.TaskStatusRunning}).Error; err != nil {
					t.Fatal(err)
				}
				record = &model.DramaJob{ID: "job", ProjectID: projectID, CastID: cast.ID, Status: model.DramaJobFailed, AttemptsJSON: `[{"taskId":"active-task"}]`}
			}
			if record != nil {
				if err := fake.db.Create(record).Error; err != nil {
					t.Fatal(err)
				}
			}
			err := svc.DeleteDramaCast("usr-drama", projectID, cast.ID, DeleteDramaCastRequest{ExpectedRevision: &revision})
			requireGuideConflict(t, err)
			if _, err := svc.repo.DramaCast(projectID, cast.ID); err != nil {
				t.Fatalf("rejected deletion must preserve asset: %v", err)
			}
			p, _ := svc.repo.DramaProduction(projectID)
			if p.Revision != revision {
				t.Fatal("rejected deletion must not advance revision")
			}
		})
	}
}

func TestDramaCastDeleteRequiresCurrentGuideAndExactReferences(t *testing.T) {
	svc, fake, projectID, revision := newDramaCastGuide(t)
	cast := model.DramaCast{ID: "cast-id", ProjectID: projectID, Kind: "scene", Name: "旧仓库"}
	for _, record := range []any{
		&cast,
		&model.DramaShot{ID: "other-shot", ProjectID: "other-project", SceneCastID: cast.ID},
		&model.DramaSegment{ID: "suffix-segment", ProjectID: projectID, ReferenceCastIDsJSON: `["cast-id-extra"]`},
		&model.CanvasProject{ID: "canvas", UserID: "usr-drama", PayloadJSON: `{"nodes":[{"metadata":{"prompt":"cast-id","dramaRef":{"projectId":"other-project","kind":"cast","id":"cast-id"}}}]}`},
	} {
		if err := fake.db.Create(record).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err := svc.DeleteDramaCast("other-user", projectID, cast.ID, DeleteDramaCastRequest{ExpectedRevision: &revision}); err == nil {
		t.Fatal("another user must not delete assets")
	}
	requireGuideConflict(t, svc.DeleteDramaCast("usr-drama", projectID, cast.ID, DeleteDramaCastRequest{}))
	stale := revision - 1
	requireGuideConflict(t, svc.DeleteDramaCast("usr-drama", projectID, cast.ID, DeleteDramaCastRequest{ExpectedRevision: &stale}))
	for _, step := range []string{"", model.DramaGuideConfiguring, model.DramaGuideCompleted} {
		if err := fake.db.Model(&model.DramaProduction{}).Where("project_id = ?", projectID).Update("guide_step", step).Error; err != nil {
			t.Fatal(err)
		}
		requireGuideConflict(t, svc.DeleteDramaCast("usr-drama", projectID, cast.ID, DeleteDramaCastRequest{ExpectedRevision: &revision}))
	}
	if err := fake.db.Model(&model.DramaProduction{}).Where("project_id = ?", projectID).Update("guide_step", model.DramaGuideStory).Error; err != nil {
		t.Fatal(err)
	}
	if err := svc.DeleteDramaCast("usr-drama", projectID, cast.ID, DeleteDramaCastRequest{ExpectedRevision: &revision}); err != nil {
		t.Fatalf("unrelated text and other-project references must not block deletion: %v", err)
	}
	p, _ := svc.repo.DramaProduction(projectID)
	if p.GuideStep != model.DramaGuideAssets || p.Revision != revision+1 {
		t.Fatal("story deletion must return to asset confirmation")
	}
}
