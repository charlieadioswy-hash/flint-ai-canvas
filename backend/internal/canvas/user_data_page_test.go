package canvas

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"yingce/backend/internal/kernel"
	"yingce/backend/internal/model"
	"yingce/backend/internal/repository"

	"gorm.io/driver/postgres"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func TestCanvasLibrarySceneFilter(t *testing.T) {
	t.Run("sqlite", func(t *testing.T) {
		db, err := gorm.Open(sqlite.Open(filepath.Join(t.TempDir(), "canvas.db")), &gorm.Config{})
		if err != nil {
			t.Fatal(err)
		}
		connection, _ := db.DB()
		t.Cleanup(func() { _ = connection.Close() })
		testCanvasLibrarySceneFilter(t, db)
	})
	t.Run("postgres", func(t *testing.T) {
		dsn := os.Getenv("CANVAS_TEST_POSTGRES_DSN")
		if dsn == "" {
			t.Skip("set CANVAS_TEST_POSTGRES_DSN to an isolated test database")
		}
		config := &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)}
		admin, err := gorm.Open(postgres.Open(dsn), config)
		if err != nil {
			t.Fatal(err)
		}
		adminConnection, _ := admin.DB()
		t.Cleanup(func() { _ = adminConnection.Close() })
		schema := fmt.Sprintf("canvas_library_scene_%d", time.Now().UnixNano())
		if err := admin.Exec("CREATE SCHEMA " + schema).Error; err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = admin.Exec("DROP SCHEMA " + schema + " CASCADE").Error })
		parsed, err := url.Parse(dsn)
		if err != nil {
			t.Fatal(err)
		}
		query := parsed.Query()
		query.Set("search_path", schema)
		parsed.RawQuery = query.Encode()
		db, err := gorm.Open(postgres.Open(parsed.String()), config)
		if err != nil {
			t.Fatal(err)
		}
		connection, _ := db.DB()
		t.Cleanup(func() { _ = connection.Close() })
		testCanvasLibrarySceneFilter(t, db)
	})
}

func testCanvasLibrarySceneFilter(t *testing.T, db *gorm.DB) {
	t.Helper()
	if err := db.AutoMigrate(&model.CanvasProject{}, &model.Asset{}); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	for _, project := range []model.CanvasProject{
		{ID: "regular-a", UserID: "owner", Title: "01 Shared", PayloadJSON: `{"nodes":[]}`},
		{ID: "internal-a", UserID: "owner", Title: "00 Shared", PayloadJSON: `{"creationScene":{"kind":"irregular-screen"},"nodes":[]}`, UpdatedAt: now.Add(time.Hour)},
		{ID: "regular-b", UserID: "owner", ProjectID: "project-a", Title: "03 Shared", PayloadJSON: `{"creationScene":null,"nodes":[]}`},
		{ID: "internal-b", UserID: "owner", ProjectID: "project-a", Title: "02 Shared", PayloadJSON: `{"creationScene":{"kind":"irregular-screen"},"nodes":[]}`, UpdatedAt: now},
		{ID: "regular-c", UserID: "owner", ProjectID: "project-a", Title: "04 Other", PayloadJSON: `{"creationScene":{"kind":"storyboard"},"nodes":[{"id":"node"}]}`},
		{ID: "regular-d", UserID: "owner", ProjectID: "project-b", Title: "05 Shared", PayloadJSON: `{"creationScene":{},"nodes":[]}`},
		{ID: "regular-e", UserID: "owner", Title: "异形屏 - 普通画布", PayloadJSON: `{"creationScene":{"kind":null},"nodes":[]}`},
		{ID: "foreign-regular", UserID: "other", ProjectID: "project-a", Title: "00 Shared", PayloadJSON: `{"nodes":[]}`},
		{ID: "foreign-internal", UserID: "other", ProjectID: "project-a", Title: "00 Shared", PayloadJSON: `{"creationScene":{"kind":"irregular-screen"},"nodes":[]}`},
	} {
		if err := db.Create(&project).Error; err != nil {
			t.Fatal(err)
		}
	}
	svc := New(repository.New(db), nil)
	for _, tc := range []struct {
		name      string
		userID    string
		page      int
		projectID string
		search    string
		sort      string
		sceneKind string
		ids       []string
		total     int64
		hasMore   bool
	}{
		{name: "first page", page: 1, ids: []string{"regular-a", "regular-b"}, total: 5, hasMore: true},
		{name: "second page", page: 2, ids: []string{"regular-c", "regular-d"}, total: 5, hasMore: true},
		{name: "last page includes regular screen title", page: 3, ids: []string{"regular-e"}, total: 5},
		{name: "all projects", page: 1, projectID: "all", ids: []string{"regular-a", "regular-b"}, total: 5, hasMore: true},
		{name: "independent", page: 1, projectID: "independent", ids: []string{"regular-a", "regular-e"}, total: 2},
		{name: "project and search", page: 1, projectID: "project-a", search: " sHaReD ", ids: []string{"regular-b"}, total: 1},
		{name: "nodes sort", page: 1, sort: "nodes", ids: []string{"regular-c", "regular-a"}, total: 5, hasMore: true},
		{name: "scenes newest first", page: 1, sort: "updated", sceneKind: "irregular-screen", ids: []string{"internal-a", "internal-b"}, total: 2},
		{name: "scenes project and search", page: 1, projectID: "project-a", search: "shared", sceneKind: "irregular-screen", ids: []string{"internal-b"}, total: 1},
		{name: "scenes independent", page: 1, projectID: "independent", sceneKind: "irregular-screen", ids: []string{"internal-a"}, total: 1},
		{name: "scenes empty search result", page: 1, search: "Other", sceneKind: "irregular-screen", ids: []string{}, total: 0},
		{name: "other user regular", userID: "other", page: 1, ids: []string{"foreign-regular"}, total: 1},
		{name: "other user scenes", userID: "other", page: 1, sceneKind: "irregular-screen", ids: []string{"foreign-internal"}, total: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if tc.userID == "" {
				tc.userID = "owner"
			}
			if tc.sort == "" {
				tc.sort = "name"
			}
			page, err := svc.UserCanvasProjectsPage(tc.userID, tc.page, 2, tc.projectID, tc.search, tc.sort, tc.sceneKind)
			if err != nil {
				t.Fatal(err)
			}
			ids := make([]string, 0, len(page.Projects))
			for _, project := range page.Projects {
				ids = append(ids, project.ID)
			}
			if !reflect.DeepEqual(ids, tc.ids) || page.Total != tc.total || page.HasMore != tc.hasMore {
				t.Fatalf("ids=%v total=%d hasMore=%v, want ids=%v total=%d hasMore=%v", ids, page.Total, page.HasMore, tc.ids, tc.total, tc.hasMore)
			}
		})
	}
	for _, sceneKind := range []string{"unknown", "IRREGULAR-SCREEN", " irregular-screen "} {
		_, err := svc.UserCanvasProjectsPage("owner", 1, 2, "", "", "", sceneKind)
		var appError *kernel.AppError
		if !errors.As(err, &appError) || appError.Status != 400 || appError.Reason != kernel.ReasonInvalidArgument {
			t.Fatalf("sceneKind=%q: expected invalid_argument, got %v", sceneKind, err)
		}
	}

	snapshot, err := svc.UserDataSnapshot("owner")
	if err != nil || len(snapshot.Projects) != 7 {
		t.Fatalf("snapshot must retain all owner canvases: count=%d err=%v", len(snapshot.Projects), err)
	}
	foundInternal := false
	for _, raw := range snapshot.Projects {
		var document struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(raw, &document); err != nil {
			t.Fatal(err)
		}
		foundInternal = foundInternal || document.ID == "internal-a"
	}
	if !foundInternal {
		t.Fatal("snapshot omitted the internal scene")
	}
	summaries, err := svc.UserCanvasProjectSummaries("owner")
	if err != nil || len(summaries) != 7 {
		t.Fatalf("summaries must retain all owner canvases: count=%d err=%v", len(summaries), err)
	}
	raw, err := svc.UserCanvasProject("owner", "internal-a")
	if err != nil {
		t.Fatal(err)
	}
	var document struct {
		CreationScene struct {
			Kind string `json:"kind"`
		} `json:"creationScene"`
	}
	if err := json.Unmarshal(raw, &document); err != nil || document.CreationScene.Kind != "irregular-screen" {
		t.Fatalf("single canvas lost scene: %s err=%v", raw, err)
	}
	if _, err := svc.UserCanvasProject("other", "internal-a"); !errors.Is(err, gorm.ErrRecordNotFound) {
		t.Fatalf("another user must not read the internal canvas: %v", err)
	}
}
