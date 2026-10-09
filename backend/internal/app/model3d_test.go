package app

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"gorm.io/gorm"
	"yingce/backend/internal/database"
	"yingce/backend/internal/model"
	"yingce/backend/internal/model3d"
	"yingce/backend/internal/repository"
)

type model3DMock struct {
	submits     int
	uploads     []string
	polls       []string
	configs     []model3d.Config
	uploadErr   error
	submitErr   error
	downloadErr error
	state       model3d.State
	data        []byte
}

func (m *model3DMock) Upload(_ context.Context, _ model3d.Config, image model3d.Image) (string, error) {
	m.uploads = append(m.uploads, image.View)
	return "token-" + image.View, m.uploadErr
}
func (m *model3DMock) Submit(_ context.Context, c model3d.Config, _ model3d.Request, _ map[string]string) (string, error) {
	m.submits++
	m.configs = append(m.configs, c)
	return "upstream-original", m.submitErr
}
func (m *model3DMock) Poll(_ context.Context, _ model3d.Config, id string, _ bool) (model3d.State, error) {
	m.polls = append(m.polls, id)
	return m.state, nil
}
func (m *model3DMock) Download(_ context.Context, _ model3d.Artifact) ([]byte, error) {
	return m.data, m.downloadErr
}

func model3DTestGLB() []byte {
	document := []byte(`{"asset":{"version":"2.0"}}`)
	for len(document)%4 != 0 {
		document = append(document, ' ')
	}
	data := make([]byte, 20+len(document))
	copy(data, "glTF")
	binary.LittleEndian.PutUint32(data[4:], 2)
	binary.LittleEndian.PutUint32(data[8:], uint32(len(data)))
	binary.LittleEndian.PutUint32(data[12:], uint32(len(document)))
	binary.LittleEndian.PutUint32(data[16:], 0x4e4f534a)
	copy(data[20:], document)
	return data
}
func setupModel3DTest(t *testing.T) (*Service, *gorm.DB, *model3DMock, *model.User) {
	t.Helper()
	db := newSQLiteTestDB(t)
	if err := db.AutoMigrate(database.Models()...); err != nil {
		t.Fatal(err)
	}
	svc := New(repository.New(db), t.TempDir())
	mock := &model3DMock{state: model3d.State{Status: "success", Progress: 100, Artifact: model3d.Artifact{URL: "https://artifact.invalid/model?signature=private", Format: "glb"}}, data: model3DTestGLB()}
	svc.model3DProviderFactory = func() model3d.Provider { return mock }
	admin := &model.User{ID: "3d-admin", Role: model.UserRoleAdmin}
	for _, user := range []model.User{*admin, {ID: "3d-user", Role: model.UserRoleUser}, {ID: "3d-other", Role: model.UserRoleUser}} {
		user.Username = user.ID
		if err := db.Create(&user).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Create(&model.CanvasProject{ID: "3d-canvas", UserID: "3d-user", Title: "3D", PayloadJSON: `{"nodes":[]}`, Revision: 1}).Error; err != nil {
		t.Fatal(err)
	}
	return svc, db, mock, admin
}
func model3DTestProvider() Model3DProviderRequest {
	return Model3DProviderRequest{Name: "Tripo", Type: "tripo3d", BaseURL: model3d.DefaultBaseURL, Enabled: true, DefaultModel: "v3.1-20260211", AllowedModels: []string{"v3.1-20260211", "v3.0-20250812", "v2.5-20250123"}, AllowedModes: []string{"text", "image", "multiview"}, TimeoutSeconds: 30, MaxTasksPerDay: 100, APIKey: "mock-secret-key"}
}
func enableModel3DTest(t *testing.T, s *Service, admin *model.User) *Model3DProviderView {
	t.Helper()
	p, err := s.SaveModel3DProvider(admin, "", model3DTestProvider())
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.ActivateModel3DProvider(admin, p.ID, p.ConfigID, 0); err != nil {
		t.Fatal(err)
	}
	return p
}
func model3DTextRequest() Model3DCreateRequest {
	revision := int64(1)
	return Model3DCreateRequest{RequestID: "request-one", SourceFingerprint: "fingerprint", CanvasID: "3d-canvas", NodeID: "3d-node", Mode: "text", Prompt: "ceramic cup", Parameters: model3d.Parameters{Model: "v3.1-20260211", Texture: true, PBR: true}, ExpectedPolicyRevision: &revision}
}
func createModel3DTest(t *testing.T, s *Service, req Model3DCreateRequest) *Model3DTaskView {
	t.Helper()
	view, err := s.CreateModel3DTask("3d-user", req)
	if err != nil {
		t.Fatal(err)
	}
	return view
}
func processModel3DTest(t *testing.T, s *Service) {
	t.Helper()
	if err := s.ProcessNextTask(); err != nil {
		t.Fatal(err)
	}
}

func TestModel3DAdminImmutableEncryptedConfigAndCAS(t *testing.T) {
	s, db, _, admin := setupModel3DTest(t)
	if _, err := s.SaveModel3DProvider(&model.User{ID: "3d-user", Role: model.UserRoleUser}, "", model3DTestProvider()); err == nil {
		t.Fatal("non-admin wrote configuration")
	}
	p := enableModel3DTest(t, s, admin)
	stored, err := s.repo.Model3DConfig(p.ConfigID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.APIKeyEncrypted == "mock-secret-key" || !strings.HasPrefix(stored.APIKeyEncrypted, "enc:v1:") {
		t.Fatal("credential was not encrypted")
	}
	req := model3DTestProvider()
	req.APIKey = ""
	req.DefaultModel = "v3.0-20250812"
	next, err := s.SaveModel3DProvider(admin, p.ID, req)
	if err != nil {
		t.Fatal(err)
	}
	if next.Version != 2 || next.ConfigID == p.ConfigID || !next.APIKeyConfigured {
		t.Fatalf("invalid new config: %+v", next)
	}
	capabilities, err := s.Model3DCapabilities("3d-user")
	if err != nil {
		t.Fatal(err)
	}
	if capabilities.DefaultModel != "v3.1-20260211" || capabilities.ActiveConfigVersion != 1 {
		t.Fatal("saving draft changed effective config")
	}
	if _, err := s.ActivateModel3DProvider(admin, p.ID, next.ConfigID, 0); err == nil {
		t.Fatal("stale activation succeeded")
	}
	if _, err := s.ActivateModel3DProvider(admin, p.ID, next.ConfigID, 1); err != nil {
		t.Fatal(err)
	}
	var count int64
	db.Model(&model.Model3DConfig{}).Count(&count)
	if count != 2 {
		t.Fatal("immutable configs lost")
	}
	state, err := s.AdminModel3D(admin)
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(state)
	if strings.Contains(string(encoded), "mock-secret") {
		t.Fatal("admin response leaked key")
	}
}

func TestModel3DAdmissionIdempotencyOwnershipAndRevision(t *testing.T) {
	s, db, _, admin := setupModel3DTest(t)
	enableModel3DTest(t, s, admin)
	req := model3DTextRequest()
	first := createModel3DTest(t, s, req)
	again := createModel3DTest(t, s, req)
	if first.ID != again.ID {
		t.Fatal("idempotent replay created another task")
	}
	changed := req
	changed.Prompt = "different"
	if _, err := s.CreateModel3DTask("3d-user", changed); err == nil {
		t.Fatal("request identity reused for different input")
	}
	lookup, err := s.Model3DTaskByRequest("3d-user", req.RequestID)
	if err != nil || lookup.ID != first.ID {
		t.Fatalf("lookup: %v %+v", err, lookup)
	}
	lookup, err = s.Model3DTaskByRequest("3d-other", req.RequestID)
	if err != nil || lookup != nil {
		t.Fatal("request lookup crossed user boundary")
	}
	if _, err := s.Model3DTask("3d-other", first.ID); err == nil {
		t.Fatal("foreign task readable")
	}
	stale := req
	stale.RequestID = "stale"
	zero := int64(0)
	stale.ExpectedPolicyRevision = &zero
	if _, err := s.CreateModel3DTask("3d-user", stale); err == nil {
		t.Fatal("stale policy admitted")
	}
	missing := req
	missing.RequestID = "missing"
	missing.ExpectedPolicyRevision = nil
	if _, err := s.CreateModel3DTask("3d-user", missing); err == nil {
		t.Fatal("missing policy admitted")
	}
	var count int64
	db.Model(&model.Task{}).Count(&count)
	if count != 1 {
		t.Fatal("rejected requests left task rows")
	}
	if _, err := s.CreateTask("3d-user", CreateTaskRequest{Type: model.TaskTypeCanvasModel3D, Prompt: "bypass"}); err == nil {
		t.Fatal("generic admission bypass")
	}
}

func TestModel3DWorkerStoresOwnedAssetAndPinnedConfig(t *testing.T) {
	s, _, mock, admin := setupModel3DTest(t)
	provider := enableModel3DTest(t, s, admin)
	view := createModel3DTest(t, s, model3DTextRequest())
	req := model3DTestProvider()
	req.APIKey = "new-secret-key"
	req.BaseURL = "https://openapi.tripo3d.com/v3"
	next, err := s.SaveModel3DProvider(admin, provider.ID, req)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.ActivateModel3DProvider(admin, provider.ID, next.ConfigID, 1); err != nil {
		t.Fatal(err)
	}
	processModel3DTest(t, s)
	view, err = s.Model3DTask("3d-user", view.ID)
	if err != nil {
		t.Fatal(err)
	}
	if view.Status != model.TaskStatusSucceeded || view.Result == nil || view.Result.Format != "glb" || view.Result.MimeType != "model/gltf-binary" || view.Result.URL != resourceFileURL(view.Result.ResourceID) {
		t.Fatalf("bad result: %+v", view)
	}
	if mock.submits != 1 || len(mock.configs) != 1 || mock.configs[0].APIKey != "mock-secret-key" || mock.configs[0].BaseURL != model3d.DefaultBaseURL || next.BaseURL != req.BaseURL {
		t.Fatal("worker did not use immutable config")
	}
	asset, err := s.repo.AssetForUser("3d-user", view.Result.AssetID)
	if err != nil || asset.Kind != "model" {
		t.Fatalf("asset: %v %+v", err, asset)
	}
	var payload struct {
		CreatedAt string  `json:"createdAt"`
		UpdatedAt string  `json:"updatedAt"`
		CoverURL  *string `json:"coverUrl"`
		Data      struct {
			StorageKey string `json:"storageKey"`
			Bytes      int64  `json:"bytes"`
		} `json:"data"`
	}
	if err := json.Unmarshal([]byte(asset.PayloadJSON), &payload); err != nil {
		t.Fatalf("model asset violates the frontend field types: %v", err)
	}
	if payload.CreatedAt != asset.CreatedAt.UTC().Format(time.RFC3339Nano) || payload.UpdatedAt != asset.UpdatedAt.UTC().Format(time.RFC3339Nano) || payload.CoverURL == nil || payload.Data.StorageKey != view.Result.StorageKey || payload.Data.Bytes != view.Result.Bytes {
		t.Fatalf("incomplete model asset contract: %+v", payload)
	}
	resource, err := s.repo.ResourceForUser("3d-user", view.Result.ResourceID)
	if err != nil || resource.Kind != "model" {
		t.Fatalf("resource: %v %+v", err, resource)
	}
	task, _ := s.repo.Task(view.ID)
	submission, _ := s.repo.Model3DSubmission(view.ID)
	if strings.Contains(task.ResultJSON, "artifact.invalid") || strings.Contains(task.InputJSON, "mock-secret") || submission.DeliveryEncrypted != "" || submission.TokensEncrypted != "" {
		t.Fatal("ephemeral credentials escaped terminal cleanup")
	}
}

func TestModel3DProviderBaseURLIsRequiredNormalizedAndVersioned(t *testing.T) {
	s, db, _, admin := setupModel3DTest(t)
	for _, value := range []string{"", "http://example.com/v3", "https://user:secret@example.com/v3", "https://example.com/v3?token=secret", "https://example.com/v2"} {
		req := model3DTestProvider()
		req.BaseURL = value
		if _, err := s.SaveModel3DProvider(admin, "", req); err == nil || strings.Contains(err.Error(), "secret") {
			t.Fatalf("unsafe or missing API URL was accepted or exposed: %v", err)
		}
	}
	var count int64
	if err := db.Model(&model.Model3DConfig{}).Count(&count).Error; err != nil || count != 0 {
		t.Fatalf("rejected input persisted config: %d %v", count, err)
	}
	first := enableModel3DTest(t, s, admin)
	req := model3DTestProvider()
	req.BaseURL = "  https://OPENAPI.tripo3d.com:443/v3///  "
	req.APIKey = ""
	next, err := s.SaveModel3DProvider(admin, first.ID, req)
	if err != nil || next.BaseURL != "https://OPENAPI.tripo3d.com:443/v3" || next.ConfigID == first.ConfigID {
		t.Fatalf("normalized config view: %+v %v", next, err)
	}
	old, err := s.repo.Model3DConfig(first.ConfigID)
	if err != nil || old.BaseURL != model3d.DefaultBaseURL {
		t.Fatalf("old endpoint mutated: %+v %v", old, err)
	}
	active, _, err := s.repo.ActiveModel3DConfig()
	if err != nil || active.ID != first.ConfigID || active.BaseURL != model3d.DefaultBaseURL {
		t.Fatalf("draft changed active endpoint: %+v %v", active, err)
	}
	encoded, err := json.Marshal(next)
	if err != nil || !strings.Contains(string(encoded), `"baseUrl":"https://OPENAPI.tripo3d.com:443/v3"`) || strings.Contains(string(encoded), "base_url") {
		t.Fatalf("wrong public field: %s %v", encoded, err)
	}
}

func TestModel3DUnknownSubmissionNeverRepostsAfterRestart(t *testing.T) {
	s, db, mock, admin := setupModel3DTest(t)
	enableModel3DTest(t, s, admin)
	mock.submitErr = errors.New("transport timeout containing secret")
	view := createModel3DTest(t, s, model3DTextRequest())
	processModel3DTest(t, s)
	failed, err := s.Model3DTask("3d-user", view.ID)
	if err != nil {
		t.Fatal(err)
	}
	if failed.SubmissionOutcome != "unknown" || failed.Error.RetryClass != "manual_review" || failed.CanRetryStorage || strings.Contains(failed.Error.Message, "secret") {
		t.Fatalf("unsafe unknown: %+v", failed)
	}
	if _, err := s.RetryTask("3d-user", view.ID); err == nil {
		t.Fatal("generic retry allowed uncertain paid POST")
	}
	if _, err := s.RecoverModel3DTask("3d-user", view.ID); err == nil {
		t.Fatal("unknown original recovered")
	}
	// Simulate a process stopping immediately after its durable dispatch fence.
	if err := db.Model(&model.Task{}).Where("id = ?", view.ID).Updates(map[string]any{"status": model.TaskStatusQueued, "lease_owner": "", "lease_expires_at": nil}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.Model3DSubmission{}).Where("task_id = ?", view.ID).Update("state", "inflight").Error; err != nil {
		t.Fatal(err)
	}
	processModel3DTest(t, s)
	if mock.submits != 1 {
		t.Fatal("restart repeated generation POST")
	}
}

func TestModel3DStorageRecoveryPollsOriginalWithoutPost(t *testing.T) {
	s, _, mock, admin := setupModel3DTest(t)
	enableModel3DTest(t, s, admin)
	mock.downloadErr = errors.New("download unavailable")
	view := createModel3DTest(t, s, model3DTextRequest())
	processModel3DTest(t, s)
	failed, err := s.Model3DTask("3d-user", view.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !failed.CanRetryStorage || failed.SubmissionOutcome != "submitted" {
		t.Fatalf("not recoverable: %+v", failed)
	}
	if _, err := s.CancelTask(context.Background(), "3d-user", view.ID); err == nil {
		t.Fatal("failed billed task cancelled")
	}
	mock.downloadErr = nil
	if _, err := s.RecoverModel3DTask("3d-user", view.ID); err != nil {
		t.Fatal(err)
	}
	processModel3DTest(t, s)
	done, err := s.Model3DTask("3d-user", view.ID)
	if err != nil || done.Status != model.TaskStatusSucceeded {
		t.Fatalf("recovery: %v %+v", err, done)
	}
	if mock.submits != 1 || len(mock.polls) != 2 || mock.polls[0] != mock.polls[1] {
		t.Fatal("storage recovery created new provider task")
	}
}

func TestModel3DUploadFailurePersistsOnlySafeDiagnostics(t *testing.T) {
	providerCode := int64(2010)
	for _, test := range []struct {
		name string
		err  error
		text string
	}{
		{"dns", &model3d.Error{Code: "provider_request_uncertain", TransportKind: "dns", Message: "secret-api-key https://secret.invalid"}, "DNS"},
		{"preflight dns", &model3d.Error{Code: "provider_request_invalid", Definite: true, TransportKind: "dns", Message: "secret-api-key https://secret.invalid"}, "DNS"},
		{"preflight ssrf", &model3d.Error{Code: "provider_request_invalid", Definite: true, TransportKind: "outbound_blocked", Message: "secret-api-key https://secret.invalid"}, "出站安全策略阻止连接"},
		{"provider rejection", &model3d.Error{Code: "provider_request_rejected", HTTPStatus: 403, ProviderCode: &providerCode, Message: "secret-file_token"}, "HTTP 403，上游错误码 2010"},
		{"unknown", errors.New("secret-api-key https://secret.invalid/?file_token=secret-token"), "参考图片上传失败，尚未创建生成任务"},
	} {
		t.Run(test.name, func(t *testing.T) {
			s, db, mock, admin := setupModel3DTest(t)
			enableModel3DTest(t, s, admin)
			front := addImageModerationResource(t, s, "3d-user", "front-resource")
			back := addImageModerationResource(t, s, "3d-user", "back-resource")
			req := model3DTextRequest()
			req.Mode, req.Prompt = "multiview", ""
			req.Views = &Model3DViews{Front: front.ID, Back: back.ID}
			mock.uploadErr = test.err
			view := createModel3DTest(t, s, req)
			processModel3DTest(t, s)
			failed, err := s.Model3DTask("3d-user", view.ID)
			if err != nil {
				t.Fatal(err)
			}
			if failed.Status != model.TaskStatusFailed || failed.Error == nil || failed.Error.Code != "model_upload_failed" || !strings.Contains(failed.Error.Message, test.text) || !strings.Contains(failed.Error.Message, "尚未创建生成任务") || strings.Contains(failed.Error.Message, "secret") {
				t.Fatalf("unsafe or missing task diagnostic: %+v", failed)
			}
			var stored model.Task
			if err := db.First(&stored, "id = ?", view.ID).Error; err != nil {
				t.Fatal(err)
			}
			submission, err := s.repo.Model3DSubmission(view.ID)
			if err != nil {
				t.Fatal(err)
			}
			if stored.Error != failed.Error.Message || stored.ProviderRequestID != "" || submission.State != "rejected" || submission.TokensEncrypted != "" || mock.submits != 0 || len(mock.polls) != 0 || len(mock.uploads) != 1 {
				t.Fatal("upload failure lost its safe message or dispatched generation")
			}
		})
	}
}

func TestModel3DMultiviewReferencesAndCancellation(t *testing.T) {
	s, _, mock, admin := setupModel3DTest(t)
	enableModel3DTest(t, s, admin)
	front := addImageModerationResource(t, s, "3d-user", "front-resource")
	back := addImageModerationResource(t, s, "3d-user", "back-resource")
	foreign := addImageModerationResource(t, s, "3d-other", "foreign-resource")
	req := model3DTextRequest()
	req.Mode = "multiview"
	req.Prompt = ""
	req.Views = &Model3DViews{Front: front.ID, Back: back.ID}
	view := createModel3DTest(t, s, req)
	if err := s.repo.DeleteResource("3d-user", front.ID); !errors.Is(err, repository.ErrModel3DReferenced) {
		t.Fatalf("running reference not protected: %v", err)
	}
	if _, err := s.CancelTask(context.Background(), "3d-user", view.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.repo.DeleteResource("3d-user", front.ID); err != nil {
		t.Fatal(err)
	}
	if mock.submits != 0 {
		t.Fatal("cancelled before queue created upstream task")
	}
	req.RequestID = "foreign"
	req.Views.Front = foreign.ID
	if _, err := s.CreateModel3DTask("3d-user", req); err == nil {
		t.Fatal("foreign input admitted")
	}
	front = addImageModerationResource(t, s, "3d-user", "front-resource-2")
	req.RequestID = "multiview"
	req.Views.Front = front.ID
	createModel3DTest(t, s, req)
	processModel3DTest(t, s)
	if strings.Join(mock.uploads, ",") != "front,back" {
		t.Fatalf("view mapping changed: %v", mock.uploads)
	}
}

func TestModel3DPendingPollReleasesLeaseAndRejectsCancellation(t *testing.T) {
	s, db, mock, admin := setupModel3DTest(t)
	enableModel3DTest(t, s, admin)
	mock.state = model3d.State{Status: "running", Progress: 37}
	view := createModel3DTest(t, s, model3DTextRequest())
	processModel3DTest(t, s)
	task, err := s.repo.Task(view.ID)
	if err != nil {
		t.Fatal(err)
	}
	if task.Status != model.TaskStatusRunning || task.Progress != 37 || task.NextPollAt == nil || task.LeaseOwner != "" {
		t.Fatalf("lease not deferred: %+v", task)
	}
	if _, err := s.CancelTask(context.Background(), "3d-user", view.ID); err == nil {
		t.Fatal("known upstream task falsely cancelled")
	}
	db.Model(&model.Task{}).Where("id = ?", view.ID).Update("next_poll_at", time.Now().Add(-time.Second))
	mock.state = model3d.State{Status: "success", Artifact: model3d.Artifact{Format: "glb"}}
	processModel3DTest(t, s)
	if mock.submits != 1 {
		t.Fatal("provider poll repeated create")
	}
}
