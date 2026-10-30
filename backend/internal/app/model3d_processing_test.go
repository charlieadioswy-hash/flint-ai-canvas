package app

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"testing"

	"yingce/backend/internal/model"
	"yingce/backend/internal/model3d"
	"yingce/backend/internal/repository"
)

func processingTestRequest(p model3d.Processing) Model3DCreateRequest {
	revision := int64(1)
	return Model3DCreateRequest{RequestID: "process-" + p.Operation, SourceFingerprint: "fingerprint", Scope: "standalone", Processing: &p, ExpectedPolicyRevision: &revision}
}

func TestModel3DProcessingLifecycle(t *testing.T) {
	s, db, mock, admin := setupModel3DTest(t)
	enableModel3DTest(t, s, admin)
	db.Delete(&model.CanvasProject{}, "id = ?", "3d-canvas")
	original := createModel3DTest(t, s, model3DStandaloneRequest())
	processModel3DTest(t, s)
	original, _ = s.Model3DTask("3d-user", original.ID)
	if err := db.Model(&model.Task{}).Where("id = ?", original.ID).Update("provider_request_id", "original-generation-id").Error; err != nil {
		t.Fatal(err)
	}
	originalResource := original.Result.ResourceID

	segmentReq := processingTestRequest(model3d.Processing{Operation: "segment", SourceTaskID: original.ID, Model: "v1.0-20250506"})
	segment := createModel3DTest(t, s, segmentReq)
	if replay := createModel3DTest(t, s, segmentReq); replay.ID != segment.ID {
		t.Fatal("duplicate local processing task")
	}
	if err := s.repo.RequireNoModel3DReferences([]string{originalResource}); !errors.Is(err, repository.ErrModel3DReferenced) {
		t.Fatalf("source not protected: %v", err)
	}
	// A minimal GLB proves that the actual saved result supplies the selectable node names.
	doc := []byte(`{"asset":{"version":"2.0"},"nodes":[{"name":"tripo_part_0","mesh":0}]}`)
	for len(doc)%4 != 0 {
		doc = append(doc, ' ')
	}
	data := make([]byte, 20+len(doc))
	copy(data, model3DTestGLB()[:20])
	copy(data[20:], doc)
	binary.LittleEndian.PutUint32(data[8:], uint32(len(data)))
	binary.LittleEndian.PutUint32(data[12:], uint32(len(doc)))
	mock.data = data
	processModel3DTest(t, s)
	segment, _ = s.Model3DTask("3d-user", segment.ID)
	if segment.Status != model.TaskStatusSucceeded || len(segment.Result.Parts) != 1 || segment.Result.ResourceID == originalResource || mock.requests[1].SourceProviderTaskID != "original-generation-id" {
		t.Fatalf("invalid segment: %+v", segment)
	}
	db.Model(&model.Task{}).Where("id = ?", segment.ID).Update("provider_request_id", "segmented-upstream-id")
	complete := createModel3DTest(t, s, processingTestRequest(model3d.Processing{Operation: "complete", SourceTaskID: segment.ID, CompletionMode: "quick_cap", PartNames: []string{"tripo_part_0"}}))
	processModel3DTest(t, s)
	complete, _ = s.Model3DTask("3d-user", complete.ID)
	if complete.Status != model.TaskStatusSucceeded || mock.requests[2].SourceProviderTaskID != "segmented-upstream-id" {
		t.Fatalf("invalid completion: %+v", complete)
	}

	check := createModel3DTest(t, s, processingTestRequest(model3d.Processing{Operation: "rig_check", SourceTaskID: original.ID}))
	mock.state = model3d.State{Status: "success", RigCheck: &model3d.RigCheck{Riggable: true, RigType: "biped"}}
	var before int64
	db.Model(&model.Asset{}).Count(&before)
	processModel3DTest(t, s)
	check, _ = s.Model3DTask("3d-user", check.ID)
	var after int64
	db.Model(&model.Asset{}).Count(&after)
	if check.RigCheck == nil || !check.RigCheck.Riggable || check.Result != nil || before != after {
		t.Fatalf("check created an asset or lost result: %+v", check)
	}
	rig := createModel3DTest(t, s, processingTestRequest(model3d.Processing{Operation: "rig", SourceTaskID: check.ID, Model: "v3.0-20260909", RigType: "biped", Spec: "tripo", OutFormat: "glb"}))
	mock.state = model3d.State{Status: "success", Artifact: model3d.Artifact{URL: "https://artifact.invalid/model", Format: "glb"}}
	processModel3DTest(t, s)
	if mock.requests[4].SourceProviderTaskID != "original-generation-id" {
		t.Fatal("rig used the check task instead of the checked model")
	}
	animated := createModel3DTest(t, s, processingTestRequest(model3d.Processing{Operation: "animate", SourceTaskID: rig.ID, RigType: "biped", Animation: "preset:walk", OutFormat: "glb"}))
	processModel3DTest(t, s)
	animated, _ = s.Model3DTask("3d-user", animated.ID)
	if animated.Status != model.TaskStatusSucceeded || animated.Processing.SourceTaskID != rig.ID || animated.Result.ResourceID == originalResource {
		t.Fatalf("invalid animation: %+v", animated)
	}
	var asset model.Asset
	db.First(&asset, "id = ?", animated.Result.AssetID)
	var payload map[string]any
	json.Unmarshal([]byte(asset.PayloadJSON), &payload)
	if payload["metadata"].(map[string]any)["parentTaskId"] != rig.ID {
		t.Fatal("asset lost parent provenance")
	}
	originalAfter, _ := s.Model3DTask("3d-user", original.ID)
	if originalAfter.Result.ResourceID != originalResource || originalAfter.Processing != nil || mock.submits != 6 {
		t.Fatal("processing overwrote original or submitted twice")
	}
	requireNoModel3DCanvas(t, db)
}

func TestModel3DProcessingRejectsUnsafeSources(t *testing.T) {
	s, db, mock, admin := setupModel3DTest(t)
	provider := enableModel3DTest(t, s, admin)
	original := createModel3DTest(t, s, model3DStandaloneRequest())
	processModel3DTest(t, s)
	valid := model3d.Processing{Operation: "segment", SourceTaskID: original.ID, Model: "v1.0-20250506"}
	for _, p := range []model3d.Processing{
		{Operation: "complete", SourceTaskID: original.ID, CompletionMode: "ai_completion"},
		{Operation: "rig", SourceTaskID: original.ID, Model: "v3.0-20260909", RigType: "biped", Spec: "tripo", OutFormat: "glb"},
		{Operation: "animate", SourceTaskID: original.ID, RigType: "biped", Animation: "preset:walk", OutFormat: "glb"},
	} {
		if _, err := s.CreateModel3DTask("3d-user", processingTestRequest(p)); err == nil {
			t.Fatalf("invalid predecessor accepted: %+v", p)
		}
	}
	if _, err := s.CreateModel3DTask("3d-other", processingTestRequest(valid)); err == nil {
		t.Fatal("foreign source accepted")
	}
	if _, err := s.CreateModel3DTask("", processingTestRequest(valid)); err == nil {
		t.Fatal("anonymous processing accepted")
	}
	check := createModel3DTest(t, s, processingTestRequest(model3d.Processing{Operation: "rig_check", SourceTaskID: original.ID}))
	mock.state = model3d.State{Status: "success", RigCheck: &model3d.RigCheck{Riggable: false}}
	processModel3DTest(t, s)
	if _, err := s.CreateModel3DTask("3d-user", processingTestRequest(model3d.Processing{Operation: "rig", SourceTaskID: check.ID, Model: "v3.0-20260909", RigType: "biped", Spec: "tripo", OutFormat: "glb"})); err == nil {
		t.Fatal("failed compatibility check accepted")
	}
	changed := model3DTestProvider()
	changed.APIKey = "another-account-key"
	next, err := s.SaveModel3DProvider(admin, provider.ID, changed)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.ActivateModel3DProvider(admin, provider.ID, next.ConfigID, 1); err != nil {
		t.Fatal(err)
	}
	req := processingTestRequest(valid)
	*req.ExpectedPolicyRevision = 2
	if _, err := s.CreateModel3DTask("3d-user", req); err == nil {
		t.Fatal("cross-account upstream task accepted")
	}
	var tasks int64
	db.Model(&model.Task{}).Count(&tasks)
	if tasks != 2 || mock.submits != 2 {
		t.Fatalf("rejected requests reached queue: %d/%d", tasks, mock.submits)
	}
}
