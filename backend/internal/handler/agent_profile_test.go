package handler

import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"

	"yingce/backend/internal/auth"
	"yingce/backend/internal/model"
	"yingce/backend/internal/repository"
	"yingce/backend/internal/service"

	"github.com/gin-gonic/gin"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func TestAgentProfileRoutesKeepScopeOwnershipAndReturnNotFound(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	sqlDB.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := db.AutoMigrate(&model.User{}, &model.AuthSession{}, &model.SystemSetting{}, &model.Project{}, &model.CanvasProject{}, &model.AgentProfile{}); err != nil {
		t.Fatal(err)
	}
	for _, record := range []any{
		&model.User{ID: "owner", Username: "owner", Role: model.UserRoleUser, Status: model.UserStatusActive},
		&model.AuthSession{ID: "profile-session", UserID: "owner", TokenHash: auth.HashToken("test-token"), ExpiresAt: time.Now().Add(time.Hour)},
		&model.Project{ID: "foreign-project", UserID: "other", Name: "private project"},
		&model.CanvasProject{ID: "foreign-canvas", UserID: "other", Title: "private canvas", PayloadJSON: `{"nodes":[]}`},
		&model.AgentProfile{ID: "foreign-profile", UserID: "other", Scope: model.AgentProfileScopeCanvas, CanvasID: "foreign-canvas", Content: "private preference", Revision: 1},
	} {
		if err := db.Create(record).Error; err != nil {
			t.Fatal(err)
		}
	}
	svc := service.New(repository.New(db), t.TempDir())
	t.Cleanup(func() { _ = svc.Close() })
	router := gin.New()
	RegisterAgentRoutes(router.Group("/api"), svc)
	cookie := "profile-session.test-token"
	for _, item := range []struct{ scope, field, id string }{
		{"project", "projectId", "missing-project"},
		{"project", "projectId", "foreign-project"},
		{"canvas", "canvasId", "unsynced-draft"},
		{"canvas", "canvasId", "foreign-canvas"},
	} {
		for _, method := range []string{http.MethodGet, http.MethodPatch} {
			t.Run(method+"/"+item.id, func(t *testing.T) {
				path, body := "/api/agent/profile", ""
				if method == http.MethodGet {
					path += fmt.Sprintf("?scope=%s&%s=%s", item.scope, item.field, item.id)
				} else {
					body = fmt.Sprintf(`{"scope":%q,%q:%q,"content":"must not be written","revision":0}`, item.scope, item.field, item.id)
				}
				rec := profileRequest(router, method, path, body, cookie)
				var envelope struct {
					Code   int             `json:"code"`
					Reason string          `json:"reason"`
					Data   json.RawMessage `json:"data"`
				}
				if err := json.Unmarshal(rec.Body.Bytes(), &envelope); err != nil {
					t.Fatal(err)
				}
				if rec.Code != http.StatusNotFound || envelope.Code != 404 || envelope.Reason != "not_found" || string(envelope.Data) != "null" {
					t.Fatalf("expected HTTP/envelope not_found, got %d %s", rec.Code, rec.Body.String())
				}
			})
		}
	}
	var profiles []model.AgentProfile
	if err := db.Find(&profiles).Error; err != nil {
		t.Fatal(err)
	}
	if len(profiles) != 1 || profiles[0].ID != "foreign-profile" || profiles[0].Content != "private preference" || profiles[0].Revision != 1 {
		t.Fatalf("rejected requests changed stored profiles: %#v", profiles)
	}
	for _, method := range []string{http.MethodGet, http.MethodPatch} {
		if rec := profileRequest(router, method, "/api/agent/profile?canvasId=unsynced-draft", `{}`, ""); rec.Code != http.StatusUnauthorized {
			t.Fatalf("anonymous %s returned %d: %s", method, rec.Code, rec.Body.String())
		}
	}
	// A local draft becomes readable only once its owned cloud canvas exists.
	if err := db.Create(&model.CanvasProject{ID: "unsynced-draft", UserID: "owner", Title: "saved draft", PayloadJSON: `{"nodes":[]}`}).Error; err != nil {
		t.Fatal(err)
	}
	rec := profileRequest(router, http.MethodGet, "/api/agent/profile?canvasId=unsynced-draft", "", cookie)
	var ready struct {
		Code int                      `json:"code"`
		Data service.AgentProfileView `json:"data"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &ready); err != nil {
		t.Fatal(err)
	}
	if rec.Code != http.StatusOK || ready.Code != 0 || len(ready.Data.Layers) != 0 || ready.Data.Revision == "" {
		t.Fatalf("owned canvas without preferences should return a valid empty view: %d %s", rec.Code, rec.Body.String())
	}
	rec = profileRequest(router, http.MethodPatch, "/api/agent/profile", `{"scope":"canvas","canvasId":"unsynced-draft","content":"owned preference","revision":0}`, cookie)
	if rec.Code != http.StatusOK {
		t.Fatalf("owned profile update failed: %d %s", rec.Code, rec.Body.String())
	}
}
