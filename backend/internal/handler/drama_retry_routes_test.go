package handler

import (
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

func TestDramaRetryRouteKeepsExplicitEpisodeScope(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for _, test := range []struct {
		name, body string
		want       int
		global     bool
		completed  bool
	}{
		{name: "legacy-no-body", want: http.StatusOK, global: true},
		{name: "legacy-empty-object", body: `{}`, want: http.StatusOK, global: true},
		{name: "episode", body: `{"episodeId":"episode"}`, want: http.StatusOK},
		{name: "episode-text", body: `{"episodeId":"episode","target":"text"}`, want: http.StatusOK},
		{name: "render-before-guide-complete", body: `{"episodeId":"episode","target":"render"}`, want: http.StatusBadRequest},
		{name: "render-completed-guide", body: `{"episodeId":"episode","target":"render"}`, want: http.StatusOK, completed: true},
		{name: "target-without-episode", body: `{"target":"render"}`, want: http.StatusBadRequest},
		{name: "unknown-target", body: `{"episodeId":"episode","target":"video"}`, want: http.StatusBadRequest},
		{name: "null-target", body: `{"episodeId":"episode","target":null}`, want: http.StatusBadRequest},
		{name: "numeric-target", body: `{"episodeId":"episode","target":7}`, want: http.StatusBadRequest},
		{name: "empty", body: `{"episodeId":""}`, want: http.StatusBadRequest},
		{name: "blank", body: `{"episodeId":"   "}`, want: http.StatusBadRequest},
		{name: "null-id", body: `{"episodeId":null}`, want: http.StatusBadRequest},
		{name: "numeric-id", body: `{"episodeId":9}`, want: http.StatusBadRequest},
		{name: "missing-id", body: `{"episodeId":"missing"}`, want: http.StatusNotFound},
		{name: "null-body", body: `null`, want: http.StatusBadRequest},
		{name: "malformed-body", body: `{"episodeId":`, want: http.StatusBadRequest},
	} {
		t.Run(test.name, func(t *testing.T) {
			db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
			if err != nil {
				t.Fatal(err)
			}
			sqlDB, _ := db.DB()
			sqlDB.SetMaxOpenConns(1)
			t.Cleanup(func() { _ = sqlDB.Close() })
			if err := db.AutoMigrate(&model.User{}, &model.AuthSession{}, &model.Project{}, &model.DramaProduction{}, &model.DramaEpisode{}, &model.DramaSegment{}, &model.DramaCast{}, &model.DramaJob{}, &model.Task{}); err != nil {
				t.Fatal(err)
			}
			guideStep := model.DramaGuideStory
			if test.completed {
				guideStep = model.DramaGuideCompleted
			}
			for _, row := range []any{
				&model.User{ID: "owner", Username: "owner", Email: "owner@example.invalid", Role: model.UserRoleUser, Status: model.UserStatusActive},
				&model.AuthSession{ID: "owner", UserID: "owner", TokenHash: auth.HashToken("test-token"), ExpiresAt: time.Now().Add(time.Hour)},
				&model.Project{ID: "project", UserID: "owner", Name: "作品"},
				&model.DramaProduction{ProjectID: "project", UserID: "owner", Status: model.DramaStatusRunning, GuideStep: guideStep, Revision: 1},
				&model.DramaEpisode{ID: "episode", ProjectID: "project", Number: 1, Stage: model.DramaEpisodeScript, Error: "剧本失败", Revision: 1},
				&model.DramaCast{ID: "cast", ProjectID: "project", Kind: "character", ImageStatus: model.DramaMediaFailed},
			} {
				if err := db.Create(row).Error; err != nil {
					t.Fatal(err)
				}
			}
			svc := service.New(repository.New(db), t.TempDir())
			router := gin.New()
			registerDramaRoutes(router.Group("/api"), svc)
			req := httptest.NewRequest(http.MethodPost, "/api/dramas/project/retry-failed", strings.NewReader(test.body))
			req.Header.Set("Content-Type", "application/json")
			req.AddCookie(&http.Cookie{Name: service.SessionCookieName, Value: "owner.test-token"})
			response := httptest.NewRecorder()
			router.ServeHTTP(response, req)
			if response.Code != test.want {
				t.Fatalf("got %d want %d: %s", response.Code, test.want, response.Body.String())
			}
			var cast model.DramaCast
			var episode model.DramaEpisode
			if err := db.First(&cast, "id = ?", "cast").Error; err != nil {
				t.Fatal(err)
			}
			if err := db.First(&episode, "id = ?", "episode").Error; err != nil {
				t.Fatal(err)
			}
			if test.global {
				if cast.ImageStatus != model.DramaMediaQueued || episode.Error != "" {
					t.Fatalf("legacy no-scope request must retain project retry behavior: %+v %+v", cast, episode)
				}
			} else if cast.ImageStatus != model.DramaMediaFailed || episode.Error != "剧本失败" {
				t.Fatalf("explicit episode requests must never fall back to project retry: %+v %+v", cast, episode)
			}
		})
	}
}
