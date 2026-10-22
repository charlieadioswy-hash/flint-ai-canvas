package handler

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"yingce/backend/internal/auth"
	"yingce/backend/internal/database"
	"yingce/backend/internal/model"
	"yingce/backend/internal/repository"
	"yingce/backend/internal/service"
)

func TestModel3DRoutesRequireAuthentication(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	RegisterModel3DRoutes(router.Group("/api"), &service.Service{})
	for _, path := range []string{"/api/model3d/capabilities", "/api/model3d/tasks", "/api/model3d/tasks/task", "/api/model3d/requests/request", "/api/admin/model3d"} {
		response := httptest.NewRecorder()
		router.ServeHTTP(response, httptest.NewRequest("GET", path, nil))
		if response.Code != 401 {
			t.Fatalf("%s status %d: %s", path, response.Code, response.Body.String())
		}
	}
}

func TestModel3DCreateRequestPreservesStandaloneIdentityAndRejectsFractionalCandidates(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.POST("/model3d/tasks", func(c *gin.Context) {
		req, err := bindModel3DCreateRequest(c)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, req)
	})
	for _, tc := range []struct {
		identity string
		status   int
	}{
		{`"candidateIndex":1,"candidateCount":4`, http.StatusOK},
		{`"candidateIndex":1.5,"candidateCount":4`, http.StatusBadRequest},
		{`"candidateIndex":1,"candidateCount":2.5`, http.StatusBadRequest},
		{`"candidateIndex":"1","candidateCount":4`, http.StatusBadRequest},
	} {
		body := `{"scope":"standalone","groupId":"group-one",` + tc.identity + `,"parameters":{"texture":true,"pbr":false}}`
		req := httptest.NewRequest(http.MethodPost, "/model3d/tasks", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		response := httptest.NewRecorder()
		router.ServeHTTP(response, req)
		if response.Code != tc.status {
			t.Fatalf("identity %s: status %d body %s", tc.identity, response.Code, response.Body.String())
		}
		if tc.status == http.StatusOK {
			var result struct {
				Data service.Model3DCreateRequest `json:"data"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
				t.Fatal(err)
			}
			if result.Data.Scope != "standalone" || result.Data.CanvasID != "" || result.Data.NodeID != "" || result.Data.GroupID != "group-one" || result.Data.CandidateIndex != 1 || result.Data.CandidateCount != 4 {
				t.Fatalf("standalone identity was lost: %+v", result.Data)
			}
		}
	}
}

func TestModel3DTaskListHTTPScopesAndQueryValidation(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db, err := database.Open(database.Config{Driver: "sqlite", DSN: ":memory:"})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, _ := db.DB()
	sqlDB.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := db.AutoMigrate(database.Models()...); err != nil {
		t.Fatal(err)
	}
	for _, record := range []any{
		&model.User{ID: "3d-http-user", Username: "3d-http-user", Role: model.UserRoleUser, Status: model.UserStatusActive},
		&model.AuthSession{ID: "3d-session", UserID: "3d-http-user", TokenHash: auth.HashToken("test-token"), ExpiresAt: time.Now().Add(time.Hour)},
	} {
		if err := db.Create(record).Error; err != nil {
			t.Fatal(err)
		}
	}
	baseTime := time.Now().Add(-time.Hour)
	for i, task := range []model.Task{
		{ID: "active", UserID: "3d-http-user", WorkbenchKind: model.WorkbenchKindModel3D, Status: model.TaskStatusRunning},
		{ID: "completed", UserID: "3d-http-user", WorkbenchKind: model.WorkbenchKindModel3D, Status: model.TaskStatusSucceeded},
		{ID: "canvas", UserID: "3d-http-user", ProjectID: "existing-canvas", Status: model.TaskStatusQueued},
		{ID: "foreign", UserID: "other-user", WorkbenchKind: model.WorkbenchKindModel3D, Status: model.TaskStatusRunning},
	} {
		task.Type, task.InputJSON, task.CreatedAt = model.TaskTypeCanvasModel3D, `{"mode":"text","prompt":"a vase","parameters":{"model":"v3.1-20260211","texture":true,"pbr":false}}`, baseTime.Add(time.Duration(i)*time.Minute)
		if err := db.Create(&task).Error; err != nil {
			t.Fatal(err)
		}
		if err := db.Create(&model.Model3DSubmission{TaskID: task.ID, UserID: task.UserID, RequestID: "request-" + task.ID}).Error; err != nil {
			t.Fatal(err)
		}
	}
	router := gin.New()
	RegisterModel3DRoutes(router.Group("/api"), service.New(repository.New(db), t.TempDir()))
	call := func(query string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, "/api/model3d/tasks"+query, nil)
		req.AddCookie(&http.Cookie{Name: service.SessionCookieName, Value: "3d-session.test-token"})
		response := httptest.NewRecorder()
		router.ServeHTTP(response, req)
		return response
	}
	for _, tc := range []struct {
		query  string
		wantID string
		scope  string
	}{
		{"?scope=standalone&limit=1&activeOnly=true", "active", "standalone"},
		{"?scope=standalone&limit=1", "completed", "standalone"},
		{"", "canvas", "canvas"},
	} {
		response := call(tc.query)
		if response.Code != http.StatusOK {
			t.Fatalf("list %s: status %d body %s", tc.query, response.Code, response.Body.String())
		}
		var result struct {
			Data service.Model3DTaskPage `json:"data"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		if len(result.Data.Tasks) != 1 || result.Data.Tasks[0].ID != tc.wantID || result.Data.Tasks[0].Scope != tc.scope {
			t.Fatalf("wrong HTTP task scope or active filter: %+v", result.Data)
		}
	}
	for _, query := range []string{"?limit=0", "?limit=101", "?limit=1.5", "?activeOnly=maybe", "?scope=unknown", "?cursor=invalid"} {
		response := call(query)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("invalid query %s: status %d body %s", query, response.Code, response.Body.String())
		}
	}
	var count int64
	if err := db.Model(&model.CanvasProject{}).Count(&count).Error; err != nil || count != 0 {
		t.Fatalf("HTTP task list created a canvas: count %d error %v", count, err)
	}
}

func TestModel3DCreateRequestRequiresExplicitBooleans(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	router.POST("/model3d/tasks", func(c *gin.Context) {
		req, err := bindModel3DCreateRequest(c)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, req)
	})
	cases := []struct {
		name       string
		parameters string
		wantStatus int
		texture    bool
		pbr        bool
	}{
		{name: "missing both", parameters: `{}`, wantStatus: http.StatusBadRequest},
		{name: "missing texture", parameters: `{"pbr":false}`, wantStatus: http.StatusBadRequest},
		{name: "missing pbr", parameters: `{"texture":false}`, wantStatus: http.StatusBadRequest},
		{name: "null both", parameters: `{"texture":null,"pbr":null}`, wantStatus: http.StatusBadRequest},
		{name: "null texture", parameters: `{"texture":null,"pbr":false}`, wantStatus: http.StatusBadRequest},
		{name: "null pbr", parameters: `{"texture":false,"pbr":null}`, wantStatus: http.StatusBadRequest},
		{name: "null parameters", parameters: `null`, wantStatus: http.StatusBadRequest},
		{name: "wrong texture type", parameters: `{"texture":"false","pbr":false}`, wantStatus: http.StatusBadRequest},
		{name: "wrong pbr type", parameters: `{"texture":false,"pbr":0}`, wantStatus: http.StatusBadRequest},
		{name: "explicit false", parameters: `{"model":"v3.1-20260211","texture":false,"pbr":false,"faceLimit":10000,"exportUv":false}`, wantStatus: http.StatusOK},
		{name: "texture true pbr false", parameters: `{"model":"v3.1-20260211","texture":true,"pbr":false,"faceLimit":10000,"exportUv":false}`, wantStatus: http.StatusOK, texture: true},
		{name: "explicit true", parameters: `{"model":"v3.1-20260211","texture":true,"pbr":true,"faceLimit":10000,"exportUv":false}`, wantStatus: http.StatusOK, texture: true, pbr: true},
	}
	for _, mode := range []string{"text", "image", "multiview"} {
		for _, tc := range cases {
			t.Run(mode+"/"+tc.name, func(t *testing.T) {
				body := fmt.Sprintf(`{"requestId":"request","sourceFingerprint":"fingerprint","canvasId":"canvas","nodeId":"node","mode":%q,"prompt":"a vase","imageResourceId":"image","views":{"front":"front","left":"left"},"parameters":%s,"expectedPolicyRevision":3}`, mode, tc.parameters)
				request := httptest.NewRequest(http.MethodPost, "/model3d/tasks", strings.NewReader(body))
				request.Header.Set("Content-Type", "application/json")
				response := httptest.NewRecorder()
				router.ServeHTTP(response, request)
				if response.Code != tc.wantStatus {
					t.Fatalf("status %d, want %d: %s", response.Code, tc.wantStatus, response.Body.String())
				}
				if tc.wantStatus != http.StatusOK {
					return
				}
				var envelope struct {
					Data service.Model3DCreateRequest `json:"data"`
				}
				if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
					t.Fatal(err)
				}
				req := envelope.Data
				if req.Parameters.Texture != tc.texture || req.Parameters.PBR != tc.pbr {
					t.Fatalf("boolean values changed: %+v", req.Parameters)
				}
				if req.Parameters.Model != "v3.1-20260211" || req.Parameters.FaceLimit == nil || *req.Parameters.FaceLimit != 10000 || req.Parameters.ExportUV == nil || *req.Parameters.ExportUV {
					t.Fatalf("other parameters were lost: %+v", req.Parameters)
				}
				if req.RequestID != "request" || req.SourceFingerprint != "fingerprint" || req.CanvasID != "canvas" || req.NodeID != "node" || req.Mode != mode || req.Prompt != "a vase" || req.ImageResourceID != "image" || req.Views == nil || req.Views.Front != "front" || req.Views.Left != "left" || req.ExpectedPolicyRevision == nil || *req.ExpectedPolicyRevision != 3 {
					t.Fatalf("create fields were lost: %+v", req)
				}
			})
		}
	}
}
