package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"testing"
	"time"

	"gorm.io/gorm"
	"yingce/backend/internal/model"
)

func model3DStandaloneRequest() Model3DCreateRequest {
	req := model3DTextRequest()
	req.Scope, req.CanvasID, req.NodeID = "standalone", "", ""
	req.GroupID, req.CandidateIndex, req.CandidateCount = "candidate-group", 1, 2
	return req
}

func requireNoModel3DCanvas(t *testing.T, db *gorm.DB) {
	t.Helper()
	var count int64
	if err := db.Model(&model.CanvasProject{}).Count(&count).Error; err != nil || count != 0 {
		t.Fatalf("standalone workflow created a canvas: count=%d error=%v", count, err)
	}
}

func TestModel3DStandaloneLifecycleNeverCreatesCanvas(t *testing.T) {
	s, db, mock, admin := setupModel3DTest(t)
	enableModel3DTest(t, s, admin)
	if err := db.Delete(&model.CanvasProject{}, "id = ?", "3d-canvas").Error; err != nil {
		t.Fatal(err)
	}
	req := model3DStandaloneRequest()
	view := createModel3DTest(t, s, req)
	if view.Scope != "standalone" || view.ClientContext.Scope != "standalone" || view.ClientContext.CanvasID != "" || view.ClientContext.NodeID != "" || view.GroupID != req.GroupID || view.CandidateIndex != 1 || view.CandidateCount != 2 || view.ClientContext.GroupID != req.GroupID || view.Prompt != req.Prompt || view.RequestID != req.RequestID || view.Parameters.Model != req.Parameters.Model {
		t.Fatalf("incomplete standalone recovery view: %+v", view)
	}
	task, err := s.repo.Task(view.ID)
	if err != nil || task.ProjectID != "" || task.WorkbenchKind != model.WorkbenchKindModel3D || task.Type != model.TaskTypeCanvasModel3D {
		t.Fatalf("standalone persistence linked a canvas: %+v %v", task, err)
	}
	if replay := createModel3DTest(t, s, req); replay.ID != view.ID {
		t.Fatal("standalone replay created another task")
	}
	if lookup, err := s.Model3DTaskByRequest("3d-user", req.RequestID); err != nil || lookup.ID != view.ID {
		t.Fatalf("standalone request recovery: %+v %v", lookup, err)
	}
	if _, err := s.Model3DTask("3d-other", view.ID); err == nil {
		t.Fatal("foreign standalone task was readable")
	}
	if lookup, err := s.Model3DTaskByRequest("3d-other", req.RequestID); err != nil || lookup != nil {
		t.Fatal("standalone request recovery crossed users")
	}
	requireNoModel3DCanvas(t, db)

	mock.downloadErr = errors.New("temporary download failure")
	processModel3DTest(t, s)
	failed, err := s.Model3DTask("3d-user", view.ID)
	if err != nil || !failed.CanRetryStorage || failed.Scope != "standalone" {
		t.Fatalf("standalone storage recovery unavailable: %+v %v", failed, err)
	}
	if _, err := s.RecoverModel3DTask("3d-other", view.ID); err == nil {
		t.Fatal("foreign user recovered standalone task")
	}
	if _, err := s.RecoverModel3DTask("3d-user", view.ID); err != nil {
		t.Fatal(err)
	}
	requireNoModel3DCanvas(t, db)
	mock.downloadErr = nil
	processModel3DTest(t, s)
	done, err := s.Model3DTask("3d-user", view.ID)
	if err != nil || done.Status != model.TaskStatusSucceeded || done.Result == nil || mock.submits != 1 {
		t.Fatalf("standalone completion or original submission failed: %+v %v submits=%d", done, err, mock.submits)
	}
	asset, err := s.repo.AssetForUser("3d-user", done.Result.AssetID)
	if err != nil {
		t.Fatal(err)
	}
	var payload struct {
		Metadata map[string]any `json:"metadata"`
	}
	if err := json.Unmarshal([]byte(asset.PayloadJSON), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Metadata["scope"] != "standalone" || payload.Metadata["taskId"] != view.ID || payload.Metadata["groupId"] != req.GroupID || payload.Metadata["candidateIndex"] != float64(1) || payload.Metadata["candidateCount"] != float64(2) {
		t.Fatalf("standalone asset lost workflow identity: %+v", payload.Metadata)
	}
	if _, ok := payload.Metadata["canvasId"]; ok {
		t.Fatal("standalone asset contains canvas linkage")
	}
	if _, ok := payload.Metadata["nodeId"]; ok {
		t.Fatal("standalone asset contains node linkage")
	}
	page, err := s.Model3DTasks("3d-user", Model3DTaskListOptions{Scope: "standalone"})
	if err != nil || len(page.Tasks) != 1 || page.Tasks[0].Result == nil {
		t.Fatalf("saved standalone result cannot be restored: %+v %v", page, err)
	}
	requireNoModel3DCanvas(t, db)
}

func TestModel3DScopeCandidatesAndIdempotency(t *testing.T) {
	s, db, _, admin := setupModel3DTest(t)
	enableModel3DTest(t, s, admin)
	cases := []struct {
		name   string
		change func(*Model3DCreateRequest)
	}{
		{"standalone canvas", func(r *Model3DCreateRequest) { r.CanvasID = "3d-canvas" }},
		{"standalone node", func(r *Model3DCreateRequest) { r.NodeID = "3d-node" }},
		{"unknown scope", func(r *Model3DCreateRequest) { r.Scope = "project" }},
		{"canvas missing identity", func(r *Model3DCreateRequest) { r.Scope = "canvas" }},
		{"missing group", func(r *Model3DCreateRequest) { r.GroupID = "" }},
		{"invalid group", func(r *Model3DCreateRequest) { r.GroupID = "unsafe/group" }},
		{"missing index", func(r *Model3DCreateRequest) { r.CandidateIndex = 0 }},
		{"missing count", func(r *Model3DCreateRequest) { r.CandidateCount = 0 }},
		{"negative index", func(r *Model3DCreateRequest) { r.CandidateIndex = -1 }},
		{"excess count", func(r *Model3DCreateRequest) { r.CandidateCount = 5 }},
		{"index after count", func(r *Model3DCreateRequest) { r.CandidateIndex = 3 }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := model3DStandaloneRequest()
			tc.change(&req)
			if _, err := s.CreateModel3DTask("3d-user", req); err == nil {
				t.Fatal("invalid task identity was admitted")
			}
		})
	}
	var count int64
	if err := db.Model(&model.Task{}).Count(&count).Error; err != nil || count != 0 {
		t.Fatalf("rejected requests persisted tasks: %d %v", count, err)
	}
	req := model3DStandaloneRequest()
	first := createModel3DTest(t, s, req)
	for _, change := range []func(*Model3DCreateRequest){
		func(r *Model3DCreateRequest) { r.GroupID = "another-group" },
		func(r *Model3DCreateRequest) { r.CandidateIndex = 2 },
		func(r *Model3DCreateRequest) { r.CandidateCount = 3 },
		func(r *Model3DCreateRequest) { r.Scope, r.CanvasID, r.NodeID = "canvas", "3d-canvas", "3d-node" },
	} {
		changed := req
		change(&changed)
		if _, err := s.CreateModel3DTask("3d-user", changed); err == nil {
			t.Fatal("requestId reused across different scope or candidate identity")
		}
	}
	if replay := createModel3DTest(t, s, req); replay.ID != first.ID {
		t.Fatal("candidate replay duplicated work")
	}
	req.CandidateIndex, req.RequestID = 2, "candidate-two"
	second := createModel3DTest(t, s, req)
	if second.ID == first.ID || second.GroupID != first.GroupID || second.CandidateIndex != 2 {
		t.Fatal("candidate versions did not retain independent task identity")
	}
	canvas := model3DTextRequest()
	canvas.RequestID, canvas.Scope = "canvas-request", "canvas"
	canvasView := createModel3DTest(t, s, canvas)
	canvas.Scope = ""
	if replay := createModel3DTest(t, s, canvas); replay.ID != canvasView.ID || replay.Scope != "canvas" || replay.ClientContext.CanvasID != "3d-canvas" {
		t.Fatal("explicit and omitted canvas scopes changed the existing entry")
	}
}

func TestModel3DStandaloneListPaginationAndActiveRecovery(t *testing.T) {
	s, db, _, admin := setupModel3DTest(t)
	enableModel3DTest(t, s, admin)
	canvasView := createModel3DTest(t, s, model3DTextRequest())
	if err := db.Delete(&model.CanvasProject{}, "id = ?", "3d-canvas").Error; err != nil {
		t.Fatal(err)
	}
	baseTime := time.Now().UTC().Add(-time.Hour).Truncate(time.Microsecond)
	ids := map[string]bool{}
	var activeID string
	for i := 0; i < 4; i++ {
		req := model3DStandaloneRequest()
		req.RequestID, req.CandidateIndex, req.CandidateCount = fmt.Sprintf("candidate-%d", i), i+1, 4
		view := createModel3DTest(t, s, req)
		ids[view.ID] = true
		createdAt := baseTime
		status := model.TaskStatusSucceeded
		if i == 0 {
			createdAt, status, activeID = baseTime.Add(-time.Minute), model.TaskStatusRunning, view.ID
		}
		if err := db.Model(&model.Task{}).Where("id = ?", view.ID).Updates(map[string]any{"created_at": createdAt, "status": status}).Error; err != nil {
			t.Fatal(err)
		}
	}
	foreignReq := model3DStandaloneRequest()
	foreignReq.RequestID = "other-user"
	if _, err := s.CreateModel3DTask("3d-other", foreignReq); err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	options := Model3DTaskListOptions{Scope: "standalone", Limit: 2}
	for pageIndex := 0; ; pageIndex++ {
		page, err := s.Model3DTasks("3d-user", options)
		if err != nil {
			t.Fatal(err)
		}
		for _, task := range page.Tasks {
			if seen[task.ID] || !ids[task.ID] || task.Scope != "standalone" {
				t.Fatalf("pagination duplicated or leaked task: %+v", task)
			}
			seen[task.ID] = true
		}
		if pageIndex == 0 && (page.NextCursor == "" || seen[activeID]) {
			t.Fatal("first history page should precede the older active task")
		}
		if page.NextCursor == "" {
			break
		}
		if pageIndex > 3 {
			t.Fatal("pagination did not terminate")
		}
		options.Cursor = page.NextCursor
	}
	if len(seen) != len(ids) {
		t.Fatalf("pagination lost tasks sharing a timestamp: got %d want %d", len(seen), len(ids))
	}
	active, err := s.Model3DTasks("3d-user", Model3DTaskListOptions{Scope: "standalone", ActiveOnly: true})
	if err != nil || len(active.Tasks) != 1 || active.Tasks[0].ID != activeID {
		t.Fatalf("active task outside history's first page was not restored: %+v %v", active, err)
	}
	canvas, err := s.Model3DTasks("3d-user", Model3DTaskListOptions{})
	if err != nil || len(canvas.Tasks) != 1 || canvas.Tasks[0].ID != canvasView.ID || canvas.Tasks[0].Scope != "canvas" {
		t.Fatalf("canvas and standalone lists overlap: %+v %v", canvas, err)
	}
	for _, options := range []Model3DTaskListOptions{{Scope: "invalid"}, {Scope: "standalone", Limit: -1}, {Scope: "standalone", Limit: 101}, {Scope: "standalone", Cursor: "invalid cursor"}} {
		if _, err := s.Model3DTasks("3d-user", options); err == nil {
			t.Fatalf("invalid list options accepted: %+v", options)
		}
	}
	if _, err := s.Model3DTasks("", Model3DTaskListOptions{Scope: "standalone"}); err == nil {
		t.Fatal("anonymous list was readable")
	}
	requireNoModel3DCanvas(t, db)
}

func TestModel3DStandaloneRestoresOwnedImageInputs(t *testing.T) {
	s, db, _, admin := setupModel3DTest(t)
	enableModel3DTest(t, s, admin)
	if err := db.Delete(&model.CanvasProject{}, "id = ?", "3d-canvas").Error; err != nil {
		t.Fatal(err)
	}
	front := addImageModerationResource(t, s, "3d-user", "front-resource")
	back := addImageModerationResource(t, s, "3d-user", "back-resource")
	foreign := addImageModerationResource(t, s, "3d-other", "foreign-resource")
	req := model3DStandaloneRequest()
	req.Mode, req.Prompt, req.ImageResourceID = "image", "", front.ID
	single := createModel3DTest(t, s, req)
	if single.ImageResourceID != front.ID || single.Views != nil || single.Prompt != "" {
		t.Fatalf("single-image snapshot cannot be restored: %+v", single)
	}
	req.RequestID, req.ImageResourceID = "foreign-image", foreign.ID
	if _, err := s.CreateModel3DTask("3d-user", req); err == nil {
		t.Fatal("standalone task accepted another user's image")
	}
	req.RequestID, req.Mode, req.ImageResourceID = "multiview-request", "multiview", ""
	req.Views = &Model3DViews{Front: front.ID, Back: back.ID}
	multiview := createModel3DTest(t, s, req)
	if multiview.ImageResourceID != "" || multiview.Views == nil || *multiview.Views != *req.Views {
		t.Fatalf("multiview snapshot cannot be restored: %+v", multiview)
	}
	requireNoModel3DCanvas(t, db)
}
