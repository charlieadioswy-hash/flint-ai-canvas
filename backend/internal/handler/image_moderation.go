package handler

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"infinite-canvas/backend/internal/service"
)

func RegisterImageModerationRoutes(r *gin.RouterGroup, svc *service.Service) {
	r.GET("/admin/image-moderation", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		state, err := svc.AdminImageModeration(user)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, state)
	})
	save := func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 16<<10)
		var req service.ImageModerationProviderRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, service.BadAuthRequest("检测配置格式无效"))
			return
		}
		provider, err := svc.SaveImageModerationProvider(user, c.Param("id"), req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, provider)
	}
	r.POST("/admin/image-moderation/providers", save)
	r.PUT("/admin/image-moderation/providers/:id", save)
	r.POST("/admin/image-moderation/providers/:id/activate", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		var req struct {
			ConfigID         string `json:"configId"`
			ExpectedRevision *int64 `json:"expectedRevision"`
		}
		if err := c.ShouldBindJSON(&req); err != nil || req.ExpectedRevision == nil || *req.ExpectedRevision < 0 {
			fail(c, http.StatusBadRequest, service.BadAuthRequest("生效请求格式无效"))
			return
		}
		state, err := svc.ActivateImageModerationProvider(user, c.Param("id"), service.ImageModerationActivationRequest{ConfigID: req.ConfigID, ExpectedRevision: *req.ExpectedRevision})
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, state)
	})
	r.POST("/admin/image-moderation/disable", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		var req struct {
			ExpectedRevision *int64 `json:"expectedRevision"`
		}
		if err := c.ShouldBindJSON(&req); err != nil || req.ExpectedRevision == nil || *req.ExpectedRevision < 0 {
			fail(c, http.StatusBadRequest, service.BadAuthRequest("停用请求格式无效"))
			return
		}
		state, err := svc.DisableImageModeration(user, *req.ExpectedRevision)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, state)
	})
	r.DELETE("/admin/image-moderation/providers/:id", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		state, err := svc.ArchiveImageModerationProvider(user, c.Param("id"))
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, state)
	})
	r.POST("/admin/image-moderation/providers/:id/validate", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		var req service.ImageModerationActivationRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			fail(c, http.StatusBadRequest, service.BadAuthRequest("校验请求格式无效"))
			return
		}
		if err := svc.ValidateImageModerationProvider(user, c.Param("id"), req.ConfigID); err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"valid": true, "message": "配置格式校验通过；未调用检测平台，不验证服务开通状态"})
	})
	r.GET("/image-moderation/availability", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		available, err := svc.ImageModerationAvailable(user.ID)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, gin.H{"available": available})
	})
	r.POST("/resources/:id/moderation-checks", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		if !enforceRateLimit(c, "image-moderation:"+user.ID, 6, time.Minute) {
			return
		}
		report, err := svc.CreateImageModerationCheck(user.ID, c.Param("id"))
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, report)
	})
	r.GET("/moderation-checks/:checkId", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		report, err := svc.ImageModerationCheck(user.ID, c.Param("checkId"))
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, report)
	})
	r.GET("/resources/:id/moderation-checks/latest", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		report, err := svc.LatestImageModerationCheck(user.ID, c.Param("id"))
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, report)
	})
}
