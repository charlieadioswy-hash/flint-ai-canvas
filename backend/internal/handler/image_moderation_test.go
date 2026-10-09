package handler

import (
	"testing"

	"github.com/gin-gonic/gin"
	"yingce/backend/internal/service"
)

func TestImageModerationRoutesRegisterWithExistingResourcePaths(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	api := router.Group("/api")
	RegisterTaskRoutes(api, &service.Service{})
	RegisterImageModerationRoutes(api, &service.Service{})
	wanted := map[string]bool{
		"GET /api/admin/image-moderation":                         false,
		"POST /api/admin/image-moderation/providers":              false,
		"PUT /api/admin/image-moderation/providers/:id":           false,
		"DELETE /api/admin/image-moderation/providers/:id":        false,
		"POST /api/admin/image-moderation/providers/:id/activate": false,
		"POST /api/admin/image-moderation/providers/:id/validate": false,
		"POST /api/admin/image-moderation/disable":                false,
		"GET /api/image-moderation/availability":                  false,
		"POST /api/resources/:id/moderation-checks":               false,
		"GET /api/resources/:id/moderation-checks/latest":         false,
		"GET /api/moderation-checks/:checkId":                     false,
	}
	for _, route := range router.Routes() {
		key := route.Method + " " + route.Path
		if _, exists := wanted[key]; exists {
			wanted[key] = true
		}
	}
	for route, found := range wanted {
		if !found {
			t.Errorf("route missing: %s", route)
		}
	}
}
