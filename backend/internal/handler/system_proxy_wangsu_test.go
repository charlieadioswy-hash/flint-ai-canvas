package handler

import (
	"encoding/json"
	"fmt"
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

func TestWangsuSystemProxyHTTP(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	t.Setenv("REDIS_URL", "")
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
	if err := db.AutoMigrate(&model.User{}, &model.AuthSession{}, &model.ModelChannel{}, &model.ChannelModel{}, &model.ChannelModelPriceTier{}, &model.IDSequence{}, &model.SystemSetting{}, &model.Asset{}, &model.CanvasProject{}, &model.Task{}, &model.TaskLog{}, &model.Result{}, &model.TaskTextDelta{}, &model.ApiCallLog{}); err != nil {
		t.Fatal(err)
	}
	for _, row := range []any{
		&model.User{ID: "wangsu-user", Username: "wangsu-user", Email: "wangsu@example.invalid", Role: model.UserRoleUser, Status: model.UserStatusActive},
		&model.AuthSession{ID: "wangsu-session", UserID: "wangsu-user", TokenHash: auth.HashToken("test-token"), ExpiresAt: time.Now().Add(time.Hour)},
		&model.SystemSetting{Key: "feature_availability", ValueJSON: `{"creditsEnabled":false}`},
	} {
		if err := db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	svc := service.New(repository.New(db), t.TempDir())
	previous := runtimeService
	ConfigureRuntime(svc)
	t.Cleanup(func() { ConfigureRuntime(previous) })
	gin.SetMode(gin.TestMode)
	router := gin.New()
	RegisterSystemProxyRoutes(router.Group("/api"), svc)
	for _, tc := range []struct{ id, path, upstreamPath, authHeader, authValue string }{
		{"wangsu-chat", "/chat/completions", "/chat/completions", "Authorization", "Bearer configured-key"},
		{"wangsu-openai-chat", "/chat/completions", "/openai/chat/completions", "Authorization", "Bearer configured-key"},
		{"wangsu-responses", "/responses", "/responses", "Authorization", "Bearer configured-key"},
		{"wangsu-openai-responses", "/responses", "/openai/responses", "Authorization", "Bearer configured-key"},
		{"wangsu-anthropic", "/messages", "/anthropic/v1/messages", "x-api-key", "configured-key"},
		{"wangsu-gemini", "/models/model:generateContent", "/gemini/v1beta/models/model:generateContent", "x-goog-api-key", "configured-key"},
	} {
		t.Run(tc.id, func(t *testing.T) {
			calls := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				if r.URL.Path != "/v2/gws/route"+tc.upstreamPath || r.URL.RawQuery != "alt=sse" {
					t.Errorf("upstream URL = %s", r.URL.String())
				}
				for _, name := range []string{"Authorization", "x-api-key", "x-goog-api-key"} {
					want := ""
					if strings.EqualFold(name, tc.authHeader) {
						want = tc.authValue
					}
					if got := r.Header.Get(name); got != want {
						t.Errorf("%s = %q, want %q", name, got, want)
					}
				}
				if tc.id == "wangsu-anthropic" && r.Header.Get("anthropic-version") != "2023-06-01" {
					t.Errorf("missing Anthropic API version")
				}
				var payload map[string]any
				if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
					t.Error(err)
				}
				if strings.HasSuffix(tc.id, "chat") {
					options, _ := payload["stream_options"].(map[string]any)
					if options["include_usage"] != true {
						t.Errorf("stream token usage not requested: %#v", payload)
					}
				}
				w.Header().Set("Content-Type", "application/json")
				fmt.Fprint(w, `{"text":"hello"}`)
			}))
			defer server.Close()
			for _, row := range []any{
				&model.ModelChannel{ID: tc.id, Name: tc.id, Scope: model.ChannelScopeSystem, Enabled: true, BaseURL: server.URL + "/v2/gws/route", APIKey: "configured-key", HeadersJSON: "[]", ModelsJSON: `["model"]`, APIFormat: "openai"},
				&model.ChannelModel{ID: tc.id, ChannelID: tc.id, ModelKey: "model", ProviderModelKey: "model", Capability: "text", Protocol: model.ChannelInterfaceType(tc.id), Enabled: true, BillingMode: "token"},
			} {
				if err := db.Create(row).Error; err != nil {
					t.Fatal(err)
				}
			}
			body := `{"model":"model","stream":true}`
			if tc.id == "wangsu-gemini" {
				body = `{"contents":[{"role":"user","parts":[{"text":"hello"}]}]}`
			}
			request := httptest.NewRequest(http.MethodPost, "/api/ai/system/"+tc.id+tc.path+"?key=browser-secret&alt=sse", strings.NewReader(body))
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("Authorization", "Bearer browser-secret")
			request.Header.Set("x-goog-api-key", "browser-secret")
			request.AddCookie(&http.Cookie{Name: service.SessionCookieName, Value: "wangsu-session.test-token"})
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			if response.Code != http.StatusOK || response.Body.String() != `{"text":"hello"}` || calls != 1 {
				t.Fatalf("proxy response: status=%d body=%s calls=%d", response.Code, response.Body.String(), calls)
			}
			var call model.ApiCallLog
			if err := db.Where("channel_id = ?", tc.id).First(&call).Error; err != nil {
				t.Fatalf("proxy log was not stored: %v", err)
			}
			format := "openai"
			if tc.id == "wangsu-gemini" {
				format = "gemini"
			} else if tc.id == "wangsu-anthropic" {
				format = "claude"
			}
			if call.APIFormat != format || call.Model != "model" {
				t.Errorf("logged format/model = %q/%q, want %q/model", call.APIFormat, call.Model, format)
			}
			var stored model.ChannelModel
			if err := db.First(&stored, "id = ?", tc.id).Error; err != nil || stored.Protocol != model.ChannelInterfaceType(tc.id) {
				t.Fatalf("stored protocol was lost: %#v, err=%v", stored.Protocol, err)
			}
		})
	}
}

func TestWangsuSystemProxyAuthorization(t *testing.T) {
	channel := &model.ModelChannel{ModelsJSON: `["model"]`}
	for _, id := range []string{"wangsu-chat", "wangsu-openai-chat", "wangsu-responses", "wangsu-openai-responses", "wangsu-anthropic", "wangsu-gemini", "wangsu-gemini-image", "wangsu-images", "wangsu-openai-images", "wangsu-chat-image", "wangsu-audio", "wangsu-openai-audio", "wangsu-videos", "wangsu-openai-videos"} {
		if err := authorizeSystemProxy(channel, model.ChannelInterfaceType(id), http.MethodPost, "/unsupported", "application/json", []byte(`{"model":"model"}`)); err == nil {
			t.Errorf("%s accepted unsupported path", id)
		}
	}
	for _, tc := range []struct{ id, path string }{
		{"wangsu-chat", "/chat/completions"},
		{"wangsu-gemini", "/models/unauthorized:generateContent"},
		{"wangsu-videos", "/videos"},
		{"wangsu-openai-videos", "/videos"},
	} {
		if err := authorizeSystemProxy(channel, model.ChannelInterfaceType(tc.id), http.MethodPost, tc.path, "application/json", []byte(`{"model":"unauthorized"}`)); err == nil {
			t.Errorf("%s accepted unauthorized request", tc.id)
		}
	}
}
