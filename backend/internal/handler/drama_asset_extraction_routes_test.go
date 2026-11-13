package handler

import (
	"encoding/json"
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

func TestDramaAssetExtractionRouteKeepsExplicitScope(t *testing.T) {
	gin.SetMode(gin.TestMode)
	for _, tc := range []struct {
		name, body string
		want       int
	}{
		{"valid", `{"expectedRevision":1,"kind":"scene","episodeIds":["episode"]}`, http.StatusOK},
		{"empty-episodes", `{"expectedRevision":1,"kind":"scene","episodeIds":[]}`, http.StatusBadRequest},
		{"empty-chapters", `{"expectedRevision":1,"kind":"scene","chapterIds":[]}`, http.StatusBadRequest},
		{"wrong-kind", `{"expectedRevision":1,"kind":"location"}`, http.StatusBadRequest},
		{"foreign-episode", `{"expectedRevision":1,"kind":"scene","episodeIds":["foreign-episode"]}`, http.StatusNotFound},
		{"stale", `{"expectedRevision":0,"kind":"scene","episodeIds":["episode"]}`, http.StatusConflict},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db, err := gorm.Open(sqlite.Open(":memory:"), &gorm.Config{})
			if err != nil {
				t.Fatal(err)
			}
			sqlDB, _ := db.DB()
			sqlDB.SetMaxOpenConns(1)
			t.Cleanup(func() { _ = sqlDB.Close() })
			if err := db.AutoMigrate(&model.User{}, &model.AuthSession{}, &model.Project{}, &model.ProjectUnit{}, &model.DramaProduction{}, &model.DramaEpisode{}, &model.DramaJob{}); err != nil {
				t.Fatal(err)
			}
			for _, row := range []any{
				&model.User{ID: "owner", Username: "owner", Email: "owner@example.invalid", Role: model.UserRoleUser, Status: model.UserStatusActive},
				&model.AuthSession{ID: "owner", UserID: "owner", TokenHash: auth.HashToken("test-token"), ExpiresAt: time.Now().Add(time.Hour)},
				&model.Project{ID: "project", UserID: "owner", Name: "作品"},
				&model.DramaProduction{ProjectID: "project", UserID: "owner", GuideStep: model.DramaGuideAssets, Stage: model.DramaStageProduce, Status: model.DramaStatusPaused, Revision: 1},
				&model.ProjectUnit{ID: "chapter", ProjectID: "project", Kind: model.ProjectUnitKindChapter, Status: model.ProjectUnitStatusReady, Title: "来源", SourceText: "庭院中下起雨。"},
				&model.DramaEpisode{ID: "episode", ProjectID: "project", Number: 1, ChapterIDsJSON: `["chapter"]`},
				&model.DramaEpisode{ID: "foreign-episode", ProjectID: "another-project", Number: 1, ChapterIDsJSON: `["chapter"]`},
			} {
				if err := db.Create(row).Error; err != nil {
					t.Fatal(err)
				}
			}
			svc := service.New(repository.New(db), t.TempDir())
			router := gin.New()
			registerDramaRoutes(router.Group("/api"), svc)
			req := httptest.NewRequest(http.MethodPost, "/api/dramas/project/cast/extract", strings.NewReader(tc.body))
			req.Header.Set("Content-Type", "application/json")
			req.AddCookie(&http.Cookie{Name: service.SessionCookieName, Value: "owner.test-token"})
			response := httptest.NewRecorder()
			router.ServeHTTP(response, req)
			if response.Code != tc.want {
				t.Fatalf("got %d want %d: %s", response.Code, tc.want, response.Body.String())
			}
			var jobs []model.DramaJob
			if err := db.Find(&jobs).Error; err != nil {
				t.Fatal(err)
			}
			if tc.want != http.StatusOK {
				if len(jobs) != 0 {
					t.Fatalf("rejected scope queued work: %+v", jobs)
				}
				return
			}
			var envelope struct {
				Code int `json:"code"`
				Data struct {
					Revision int64 `json:"revision"`
					Job      struct {
						AssetKind        string   `json:"assetKind"`
						SourceChapterIDs []string `json:"sourceChapterIds"`
						SourceEpisodeIDs []string `json:"sourceEpisodeIds"`
					} `json:"job"`
				} `json:"data"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &envelope); err != nil {
				t.Fatal(err)
			}
			if envelope.Code != 0 || envelope.Data.Revision != 2 || envelope.Data.Job.AssetKind != "scene" || len(envelope.Data.Job.SourceChapterIDs) != 1 || envelope.Data.Job.SourceChapterIDs[0] != "chapter" || len(envelope.Data.Job.SourceEpisodeIDs) != 1 || envelope.Data.Job.SourceEpisodeIDs[0] != "episode" || len(jobs) != 1 {
				t.Fatalf("response must expose exact accepted scope: %s jobs=%+v", response.Body.String(), jobs)
			}
		})
	}
}
