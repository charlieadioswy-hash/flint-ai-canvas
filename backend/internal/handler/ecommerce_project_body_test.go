package handler

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
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

func newEcommerceProjectBodyRouter(t *testing.T) (*gin.Engine, *gorm.DB) {
	t.Helper()
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
	if err := db.AutoMigrate(database.Models()...); err != nil {
		t.Fatal(err)
	}
	for _, value := range []any{
		&model.User{ID: "commerce-owner", Username: "commerce-owner", Role: model.UserRoleAdmin, Status: model.UserStatusActive},
		&model.AuthSession{ID: "commerce-session", UserID: "commerce-owner", TokenHash: auth.HashToken("fixture-token"), ExpiresAt: time.Now().Add(time.Hour)},
		&model.SystemSetting{Key: "feature_availability", ValueJSON: `{"ecommerceEnabled":true,"imageWorkbenchEnabled":true}`},
		&model.EcommerceProject{ID: "commerce-project", UserID: "commerce-owner", Name: "history", DraftJSON: "{}", PlanJSON: "{}", Revision: 1},
		&model.Task{ID: "image-history", UserID: "commerce-owner", Type: "canvas_image", Status: model.TaskStatusSucceeded},
	} {
		if err := db.Create(value).Error; err != nil {
			t.Fatal(err)
		}
	}
	svc := service.New(repository.New(db), t.TempDir())
	t.Cleanup(func() { _ = svc.Close() })
	previous := runtimeService
	ConfigureRuntime(svc)
	t.Cleanup(func() { ConfigureRuntime(previous) })
	router := gin.New()
	RegisterEcommerceRoutes(router.Group("/api"), svc)
	return router, db
}

func ecommerceProjectSaveRequest(body io.Reader) *http.Request {
	req := httptest.NewRequest(http.MethodPut, "/api/ecommerce/projects/commerce-project", body)
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(&http.Cookie{Name: service.SessionCookieName, Value: "commerce-session.fixture-token"})
	return req
}

func TestEcommerceProjectSaveAcceptsLargePlanAndHistory(t *testing.T) {
	router, db := newEcommerceProjectBodyRouter(t)
	plan := &model.EcommercePlan{ProductSummary: "商品分析", VisualStrategy: "视觉策略"}
	for i := 0; i < 30; i++ {
		plan.Images = append(plan.Images, model.EcommercePlanTask{
			ID: fmt.Sprintf("current-%d", i), ImageType: "main", Platform: "custom", Language: "zh-CN",
			Goal: "展示商品", Theme: "商品主题", Composition: "居中构图", MainVisual: "商品主体", Fidelity: "保真",
			Prompt: strings.Repeat("p", 32000), ImageModel: "image-model", Ratio: "1:1", Resolution: "1K",
		})
	}
	for i := 0; i < 470; i++ {
		image := model.EcommercePlanTask{ID: fmt.Sprintf("history-%d", i), TaskID: "image-history"}
		if i < 3 {
			snapshot, err := json.Marshal(map[string]string{"instruction": strings.Repeat("s", (128<<10)-32)})
			if err != nil {
				t.Fatal(err)
			}
			image.SourceDraft = snapshot
		}
		plan.PreviousImages = append(plan.PreviousImages, image)
	}
	save := service.SaveEcommerceProjectRequest{Revision: 1, Name: "大项目", Plan: plan}
	save.Draft.Count, save.Draft.Platform, save.Draft.ImageType = 30, "custom", "main"
	body, err := json.Marshal(save)
	if err != nil {
		t.Fatal(err)
	}
	if len(body) <= 1<<20 {
		t.Fatalf("fixture should exercise a valid save larger than 1MiB, got %d bytes", len(body))
	}
	out := httptest.NewRecorder()
	router.ServeHTTP(out, ecommerceProjectSaveRequest(bytes.NewReader(body)))
	if out.Code != http.StatusOK {
		t.Fatalf("large supported project save status=%d: %s", out.Code, out.Body.String())
	}
	var stored model.EcommerceProject
	if err := db.First(&stored, "id = ?", "commerce-project").Error; err != nil {
		t.Fatal(err)
	}
	var savedPlan model.EcommercePlan
	if err := json.Unmarshal([]byte(stored.PlanJSON), &savedPlan); err != nil {
		t.Fatal(err)
	}
	if stored.Revision != 2 || len(savedPlan.Images) != 30 || len(savedPlan.PreviousImages) != 470 || savedPlan.Images[29].Prompt != plan.Images[29].Prompt || !bytes.Equal(savedPlan.PreviousImages[2].SourceDraft, plan.PreviousImages[2].SourceDraft) {
		t.Fatal("large save did not persist all current images, historical snapshots, and revision")
	}
}

func TestEcommerceProjectSaveRejectsOversizedBody(t *testing.T) {
	router, db := newEcommerceProjectBodyRouter(t)
	// ContentLength permits rejection before decoding; the streamed body needs no 128MiB allocation.
	req := ecommerceProjectSaveRequest(io.LimitReader(ecommerceProjectPaddingReader{}, maxEcommerceProjectSaveBytes+1))
	req.ContentLength = maxEcommerceProjectSaveBytes + 1
	out := httptest.NewRecorder()
	router.ServeHTTP(out, req)
	if out.Code != http.StatusRequestEntityTooLarge || !strings.Contains(out.Body.String(), "128MiB") {
		t.Fatalf("oversized save status=%d: %s", out.Code, out.Body.String())
	}
	var stored model.EcommerceProject
	if err := db.First(&stored, "id = ?", "commerce-project").Error; err != nil {
		t.Fatal(err)
	}
	if stored.Revision != 1 || stored.PlanJSON != "{}" {
		t.Fatal("oversized save changed the persisted project")
	}
}

type ecommerceProjectPaddingReader struct{}

func (ecommerceProjectPaddingReader) Read(p []byte) (int, error) {
	for i := range p {
		p[i] = ' '
	}
	return len(p), nil
}
