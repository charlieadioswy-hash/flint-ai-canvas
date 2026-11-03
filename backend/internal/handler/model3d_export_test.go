package handler

import (
	"bytes"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"yingce/backend/internal/auth"
	"yingce/backend/internal/database"
	"yingce/backend/internal/model"
	"yingce/backend/internal/repository"
	"yingce/backend/internal/service"
)

func TestModel3DExportRoutesRequireAuthentication(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	RegisterModel3DRoutes(router.Group("/api"), &service.Service{})
	for _, route := range []struct{ method, path string }{
		{"GET", "/api/model3d/exports/capabilities"},
		{"POST", "/api/model3d/exports"},
		{"GET", "/api/model3d/exports/task"},
		{"DELETE", "/api/model3d/exports/task"},
		{"DELETE", "/api/model3d/exports/by-request/request"},
	} {
		response := httptest.NewRecorder()
		router.ServeHTTP(response, httptest.NewRequest(route.method, route.path, nil))
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("%s %s: %d %s", route.method, route.path, response.Code, response.Body.String())
		}
	}
}

func TestModel3DExportMultipartNativeFBXAndCancellation(t *testing.T) {
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
		&model.User{ID: "export-http-user", Username: "export-http-user", Role: model.UserRoleUser, Status: model.UserStatusActive},
		&model.AuthSession{ID: "export-session", UserID: "export-http-user", TokenHash: auth.HashToken("test-token"), ExpiresAt: time.Now().Add(time.Hour)},
	} {
		if err := db.Create(record).Error; err != nil {
			t.Fatal(err)
		}
	}
	svc := service.New(repository.New(db), t.TempDir())
	previousRuntime := runtimeService
	ConfigureRuntime(svc)
	t.Cleanup(func() { ConfigureRuntime(previousRuntime) })
	router := gin.New()
	RegisterModel3DRoutes(router.Group("/api"), svc)
	call := func(req *http.Request) *httptest.ResponseRecorder {
		req.AddCookie(&http.Cookie{Name: service.SessionCookieName, Value: "export-session.test-token"})
		response := httptest.NewRecorder()
		router.ServeHTTP(response, req)
		return response
	}
	data := []byte("Kaydara FBX Binary  \x00\x1a\x00original-file")
	upload := func(id, fps string) *httptest.ResponseRecorder {
		var body bytes.Buffer
		writer := multipart.NewWriter(&body)
		for key, value := range map[string]string{"requestId": id, "sourceFormat": "fbx", "format": "fbx", "fileName": "人物.fbx", "fps": fps} {
			_ = writer.WriteField(key, value)
		}
		file, err := writer.CreateFormFile("file", "人物.fbx")
		if err != nil {
			t.Fatal(err)
		}
		_, _ = file.Write(data)
		_ = writer.Close()
		req := httptest.NewRequest(http.MethodPost, "/api/model3d/exports", &body)
		req.Header.Set("Content-Type", writer.FormDataContentType())
		return call(req)
	}
	t.Setenv("CANVAS_BLENDER_BIN", "/nonexistent/blender")
	response := upload("native-upload", "30")
	if response.Code != http.StatusOK {
		t.Fatalf("multipart: %d %s", response.Code, response.Body.String())
	}
	var envelope struct {
		Data service.Model3DExportView `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Data.Status != model.TaskStatusSucceeded || envelope.Data.Result == nil || envelope.Data.Result.FileName != "人物.fbx" {
		t.Fatalf("invalid result: %+v", envelope.Data)
	}
	_, reader, err := svc.OpenResource("export-http-user", envelope.Data.Result.ResourceID)
	if err != nil {
		t.Fatal(err)
	}
	stored, _ := io.ReadAll(reader)
	_ = reader.Close()
	if !bytes.Equal(stored, data) {
		t.Fatal("native FBX bytes changed")
	}
	if response := upload("invalid-fps", "29.97"); response.Code != http.StatusBadRequest {
		t.Fatalf("fractional FPS accepted: %d %s", response.Code, response.Body.String())
	}
	response = call(httptest.NewRequest(http.MethodDelete, "/api/model3d/exports/by-request/late-upload", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("cancel before upload: %d %s", response.Code, response.Body.String())
	}
	response = upload("late-upload", "30")
	if response.Code != http.StatusOK {
		t.Fatalf("late upload: %d %s", response.Code, response.Body.String())
	}
	if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
		t.Fatal(err)
	}
	if envelope.Data.Status != model.TaskStatusCancelled {
		t.Fatalf("late upload started: %+v", envelope.Data)
	}
}
