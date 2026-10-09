package handler

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
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

func TestUserDataIncrementalRoutesAreRegistered(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	RegisterUserDataRoutes(router.Group("/api"), &service.Service{})
	wanted := map[string]bool{
		"GET /api/canvas-projects":      false,
		"GET /api/canvas-projects/:id":  false,
		"POST /api/assets/batch":        false,
		"POST /api/assets/batch-delete": false,
	}
	for _, route := range router.Routes() {
		key := route.Method + " " + route.Path
		if _, exists := wanted[key]; exists {
			wanted[key] = true
		}
	}
	for route, found := range wanted {
		if !found {
			t.Errorf("missing route: %s", route)
		}
	}
}

func TestCanvasLibrarySceneFilterHTTP(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	connection, _ := db.DB()
	connection.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = connection.Close() })
	if err := db.AutoMigrate(&model.User{}, &model.AuthSession{}, &model.CanvasProject{}); err != nil {
		t.Fatal(err)
	}
	for _, record := range []any{
		&model.User{ID: "owner", Username: "owner", Role: model.UserRoleUser, Status: model.UserStatusActive},
		&model.AuthSession{ID: "scene-session", UserID: "owner", TokenHash: auth.HashToken("test-token"), ExpiresAt: time.Now().Add(time.Hour)},
		&model.CanvasProject{ID: "regular", UserID: "owner", Title: "regular", PayloadJSON: `{"nodes":[]}`},
		&model.CanvasProject{ID: "internal", UserID: "owner", Title: "internal", PayloadJSON: `{"creationScene":{"kind":"irregular-screen"},"nodes":[]}`},
	} {
		if err := db.Create(record).Error; err != nil {
			t.Fatal(err)
		}
	}
	router := gin.New()
	RegisterUserDataRoutes(router.Group("/api"), service.New(repository.New(db), t.TempDir()))
	for _, tc := range []struct {
		query  string
		status int
		id     string
		total  int64
	}{
		{query: "?page=1", status: http.StatusOK, id: "regular", total: 1},
		{query: "?page=1&sceneKind=", status: http.StatusOK, id: "regular", total: 1},
		{query: "?page=1&sceneKind=irregular-screen", status: http.StatusOK, id: "internal", total: 1},
		{query: "?sceneKind=irregular-screen", status: http.StatusOK, id: "internal", total: 1},
		{query: "?page=1&sceneKind=unknown", status: http.StatusBadRequest},
		{query: "?sceneKind=unknown", status: http.StatusBadRequest},
		{query: "", status: http.StatusOK, total: 2},
	} {
		t.Run(tc.query, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/api/canvas-projects"+tc.query, nil)
			req.AddCookie(&http.Cookie{Name: service.SessionCookieName, Value: "scene-session.test-token"})
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, req)
			var response struct {
				Code   int                       `json:"code"`
				Reason string                    `json:"reason"`
				Data   service.CanvasLibraryPage `json:"data"`
			}
			if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
				t.Fatal(err)
			}
			if recorder.Code != tc.status {
				t.Fatalf("status=%d want=%d body=%s", recorder.Code, tc.status, recorder.Body.String())
			}
			if tc.status == http.StatusBadRequest {
				if response.Code != 400 || response.Reason != "invalid_argument" {
					t.Fatalf("unexpected error envelope: %s", recorder.Body.String())
				}
				return
			}
			if response.Code != 0 || int64(len(response.Data.Projects)) != tc.total {
				t.Fatalf("unexpected success envelope: %s", recorder.Body.String())
			}
			if tc.id != "" && (response.Data.Projects[0].ID != tc.id || response.Data.Total != tc.total) {
				t.Fatalf("unexpected scene page: %s", recorder.Body.String())
			}
		})
	}
}

func TestCanvasProjectReadErrorHTTP(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for _, tc := range []struct {
		name       string
		id         string
		payload    string
		failRead   int
		readError  error
		noSession  bool
		wantStatus int
		wantReason string
	}{
		{name: "missing", id: "missing", wantStatus: http.StatusNotFound, wantReason: "not_found"},
		{name: "other owner", id: "other", wantStatus: http.StatusNotFound, wantReason: "not_found"},
		{name: "deleted after metadata", failRead: 2, readError: gorm.ErrRecordNotFound, wantStatus: http.StatusNotFound, wantReason: "not_found"},
		{name: "metadata storage failure", failRead: 1, readError: errors.New("private storage failure"), wantStatus: http.StatusInternalServerError, wantReason: "internal"},
		{name: "content storage failure", failRead: 2, readError: errors.New("private storage failure"), wantStatus: http.StatusInternalServerError, wantReason: "internal"},
		{name: "invalid stored content", payload: "{", wantStatus: http.StatusInternalServerError, wantReason: "internal"},
		{name: "no session", noSession: true, wantStatus: http.StatusUnauthorized, wantReason: "unauthorized"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
			if err != nil {
				t.Fatal(err)
			}
			connection, err := db.DB()
			if err != nil {
				t.Fatal(err)
			}
			connection.SetMaxOpenConns(1)
			t.Cleanup(func() { _ = connection.Close() })
			if err := db.AutoMigrate(&model.User{}, &model.AuthSession{}, &model.CanvasProject{}); err != nil {
				t.Fatal(err)
			}
			payload := tc.payload
			if payload == "" {
				payload = `{"nodes":[]}`
			}
			for _, record := range []any{
				&model.User{ID: "owner", Username: "owner", Role: model.UserRoleUser, Status: model.UserStatusActive},
				&model.AuthSession{ID: "read-session", UserID: "owner", TokenHash: auth.HashToken("test-token"), ExpiresAt: time.Now().Add(time.Hour)},
				&model.CanvasProject{ID: "canvas", UserID: "owner", Title: "canvas", PayloadJSON: payload},
				&model.CanvasProject{ID: "other", UserID: "other-owner", Title: "other", PayloadJSON: `{"nodes":[]}`},
			} {
				if err := db.Create(record).Error; err != nil {
					t.Fatal(err)
				}
			}
			reads := 0
			if err := db.Callback().Query().Before("gorm:query").Register("test:canvas-read-failure", func(tx *gorm.DB) {
				if tx.Statement.Table == "canvas_projects" {
					reads++
					if reads == tc.failRead {
						tx.AddError(tc.readError)
					}
				}
			}); err != nil {
				t.Fatal(err)
			}
			router := gin.New()
			RegisterUserDataRoutes(router.Group("/api"), service.New(repository.New(db), t.TempDir()))
			id := tc.id
			if id == "" {
				id = "canvas"
			}
			req := httptest.NewRequest(http.MethodGet, "/api/canvas-projects/"+id, nil)
			if !tc.noSession {
				req.AddCookie(&http.Cookie{Name: service.SessionCookieName, Value: "read-session.test-token"})
			}
			recorder := httptest.NewRecorder()
			router.ServeHTTP(recorder, req)
			var response struct {
				Code   int    `json:"code"`
				Reason string `json:"reason"`
				Msg    string `json:"msg"`
			}
			if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
				t.Fatal(err)
			}
			if recorder.Code != tc.wantStatus || response.Code != tc.wantStatus || response.Reason != tc.wantReason {
				t.Fatalf("unexpected error envelope: status=%d body=%s", recorder.Code, recorder.Body.String())
			}
			if tc.wantStatus == http.StatusInternalServerError && response.Msg != internalErrorMessage {
				t.Fatalf("internal error must use the safe public message: %s", recorder.Body.String())
			}
			if tc.failRead != 0 && reads != tc.failRead {
				t.Fatalf("canvas reads=%d want=%d", reads, tc.failRead)
			}
		})
	}
}

func TestCanvasProjectResponseETagChangesWithRevisionMetadata(t *testing.T) {
	project := &model.CanvasProject{Revision: 7, UpdatedAt: time.Date(2026, 9, 28, 12, 0, 0, 123000000, time.UTC)}
	first := canvasProjectResponseETag(project)
	if first != `W/"canvas-7"` {
		t.Fatalf("unexpected canvas ETag: %s", first)
	}
	if !ifNoneMatch(`"canvas-7"`, first) || !ifNoneMatch(first, first) {
		t.Fatal("strong and weak validators should match for conditional GET")
	}
	project.Revision++
	if first == canvasProjectResponseETag(project) {
		t.Fatal("revision change must invalidate the canvas ETag")
	}
}

func TestAcceptsGzipHonorsQualityAndWildcard(t *testing.T) {
	for _, test := range []struct {
		header string
		want   bool
	}{
		{header: "gzip, br", want: true},
		{header: "gzip;q=0, *;q=1", want: false},
		{header: "br, *;q=0.5", want: true},
		{header: "br, gzip;q=0.2", want: true},
		{header: "br, gzip;q=0", want: false},
	} {
		if got := acceptsGzip(test.header); got != test.want {
			t.Errorf("acceptsGzip(%q) = %v, want %v", test.header, got, test.want)
		}
	}
}

func TestOkCanvasProjectCompressesLargeResponses(t *testing.T) {
	gin.SetMode(gin.TestMode)
	recorder := httptest.NewRecorder()
	ctx, _ := gin.CreateTestContext(recorder)
	ctx.Request = httptest.NewRequest("GET", "/api/canvas-projects/canvas", nil)
	ctx.Request.Header.Set("Accept-Encoding", "gzip")
	project := json.RawMessage(`{"nodes":["` + strings.Repeat("x", 2048) + `"]}`)

	okCanvasProject(ctx, project)

	if got := recorder.Header().Get("Content-Encoding"); got != "gzip" {
		t.Fatalf("Content-Encoding = %q, want gzip", got)
	}
	reader, err := gzip.NewReader(bytes.NewReader(recorder.Body.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	body, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	if err := reader.Close(); err != nil {
		t.Fatal(err)
	}
	if !json.Valid(body) {
		t.Fatalf("decompressed response is not valid JSON: %s", body)
	}
}
