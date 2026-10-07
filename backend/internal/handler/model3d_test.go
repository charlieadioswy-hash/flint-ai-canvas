package handler

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"infinite-canvas/backend/internal/service"
)

func TestModel3DRoutesRequireAuthentication(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	RegisterModel3DRoutes(router.Group("/api"), &service.Service{})
	for _, path := range []string{"/api/model3d/capabilities", "/api/model3d/tasks/task", "/api/model3d/requests/request", "/api/admin/model3d"} {
		response := httptest.NewRecorder()
		router.ServeHTTP(response, httptest.NewRequest("GET", path, nil))
		if response.Code != 401 {
			t.Fatalf("%s status %d: %s", path, response.Code, response.Body.String())
		}
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
