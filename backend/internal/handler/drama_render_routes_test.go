package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"yingce/backend/internal/auth"
	"yingce/backend/internal/database"
	"yingce/backend/internal/model"
	"yingce/backend/internal/repository"
	"yingce/backend/internal/service"

	"github.com/gin-gonic/gin"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func TestDramaRenderRouteRequiresFreshEpisodeAndQueuesOnlyAssembly(t *testing.T) {
	gin.SetMode(gin.TestMode)
	db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, _ := db.DB()
	sqlDB.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := db.AutoMigrate(database.Models()...); err != nil {
		t.Fatal(err)
	}
	for _, row := range []any{
		&model.User{ID: "owner", Username: "owner", Email: "owner@example.invalid", Role: model.UserRoleUser, Status: model.UserStatusActive},
		&model.AuthSession{ID: "owner", UserID: "owner", TokenHash: auth.HashToken("test-token"), ExpiresAt: time.Now().Add(time.Hour)},
		&model.Project{ID: "project", UserID: "owner", Name: "作品"},
		&model.DramaProduction{ProjectID: "project", UserID: "owner", Status: model.DramaStatusPaused, GuideStep: model.DramaGuideCompleted, Revision: 1},
		&model.DramaEpisode{ID: "episode", ProjectID: "project", Number: 1, Stage: model.DramaEpisodeVideo, VideoRequestsOnly: true, Revision: 3},
		&model.DramaSegment{ID: "segment", ProjectID: "project", EpisodeID: "episode", VideoStatus: model.DramaMediaReady, VideoSeconds: 5, VideoResourceID: "video"},
		&model.Resource{ID: "video", UserID: "owner", Status: model.ResourceStatusReady, MimeType: "video/mp4", Size: 10},
	} {
		if err := db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	svc := service.New(repository.New(db), t.TempDir())
	router := gin.New()
	registerDramaRoutes(router.Group("/api"), svc)
	for _, test := range []struct {
		name, episode, body string
		status, jobs        int
	}{
		{name: "missing-version", body: `{}`, status: 400},
		{name: "null-version", body: `{"expectedRevision":null}`, status: 400},
		{name: "string-version", body: `{"expectedRevision":"3"}`, status: 400},
		{name: "fraction-version", body: `{"expectedRevision":3.5}`, status: 400},
		{name: "negative-version", body: `{"expectedRevision":-1}`, status: 400},
		{name: "stale-version", body: `{"expectedRevision":2}`, status: 409},
		{name: "missing-episode", episode: "missing", body: `{"expectedRevision":3}`, status: 404},
		{name: "queue", body: `{"expectedRevision":3}`, status: 200, jobs: 1},
		{name: "duplicate", body: `{"expectedRevision":3}`, status: 200, jobs: 0},
	} {
		t.Run(test.name, func(t *testing.T) {
			episodeID := "episode"
			if test.episode != "" {
				episodeID = test.episode
			}
			req := httptest.NewRequest(http.MethodPost, "/api/dramas/project/episodes/"+episodeID+"/render", strings.NewReader(test.body))
			req.Header.Set("Content-Type", "application/json")
			req.AddCookie(&http.Cookie{Name: service.SessionCookieName, Value: "owner.test-token"})
			response := httptest.NewRecorder()
			router.ServeHTTP(response, req)
			if response.Code != test.status {
				t.Fatalf("status %d, want %d: %s", response.Code, test.status, response.Body.String())
			}
			if test.status == http.StatusOK {
				var result struct {
					Data struct {
						Jobs int `json:"jobs"`
					} `json:"data"`
				}
				if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil || result.Data.Jobs != test.jobs {
					t.Fatalf("unexpected success envelope: %s %v", response.Body.String(), err)
				}
			}
		})
	}
	var tasks []model.Task
	if err := db.Find(&tasks).Error; err != nil || len(tasks) != 1 || tasks[0].Type != model.TaskTypeTimelineRender || tasks[0].BillingOrderID != "" {
		t.Fatalf("route must queue one free render task: %+v %v", tasks, err)
	}
	var production model.DramaProduction
	if err := db.First(&production, "project_id = ?", "project").Error; err != nil || production.Status != model.DramaStatusPaused || production.MediaRequestsOnly || production.AssetsReleased {
		t.Fatalf("route must preserve production status and media authorization: %+v %v", production, err)
	}
}
