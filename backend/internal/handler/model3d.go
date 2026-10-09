package handler

import (
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
	"yingce/backend/internal/service"
)

type model3DCreateHTTPRequest struct {
	service.Model3DCreateRequest
	Parameters struct {
		service.Model3DParameters
		Texture *bool `json:"texture"`
		PBR     *bool `json:"pbr"`
	} `json:"parameters"`
}

func bindModel3DCreateRequest(c *gin.Context) (service.Model3DCreateRequest, error) {
	var req model3DCreateHTTPRequest
	if c.ShouldBindJSON(&req) != nil {
		return service.Model3DCreateRequest{}, service.BadAuthRequest("3D 生成请求格式无效")
	}
	if req.Parameters.Texture == nil || req.Parameters.PBR == nil {
		return service.Model3DCreateRequest{}, service.BadAuthRequest("须明确提供 texture 和 pbr 布尔参数")
	}
	result := req.Model3DCreateRequest
	result.Parameters = req.Parameters.Model3DParameters
	result.Parameters.Texture = *req.Parameters.Texture
	result.Parameters.PBR = *req.Parameters.PBR
	return result, nil
}

func RegisterModel3DRoutes(r *gin.RouterGroup, svc *service.Service) {
	r.GET("/admin/model3d", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		state, err := svc.AdminModel3D(user)
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
		var req service.Model3DProviderRequest
		if c.ShouldBindJSON(&req) != nil {
			failService(c, service.BadAuthRequest("3D 配置格式无效"))
			return
		}
		view, err := svc.SaveModel3DProvider(user, c.Param("id"), req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, view)
	}
	r.POST("/admin/model3d/providers", save)
	r.PUT("/admin/model3d/providers/:id", save)
	r.POST("/admin/model3d/providers/:id/activate", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		var req struct {
			ConfigID         string `json:"configId"`
			ExpectedRevision *int64 `json:"expectedRevision"`
		}
		if c.ShouldBindJSON(&req) != nil || req.ExpectedRevision == nil || *req.ExpectedRevision < 0 {
			failService(c, service.BadAuthRequest("生效请求格式无效"))
			return
		}
		state, err := svc.ActivateModel3DProvider(user, c.Param("id"), req.ConfigID, *req.ExpectedRevision)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, state)
	})
	r.POST("/admin/model3d/disable", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		var req struct {
			ExpectedRevision *int64 `json:"expectedRevision"`
		}
		if c.ShouldBindJSON(&req) != nil || req.ExpectedRevision == nil || *req.ExpectedRevision < 0 {
			failService(c, service.BadAuthRequest("停用请求格式无效"))
			return
		}
		state, err := svc.DisableModel3D(user, *req.ExpectedRevision)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, state)
	})
	r.DELETE("/admin/model3d/providers/:id", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		state, err := svc.ArchiveModel3DProvider(user, c.Param("id"))
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, state)
	})
	r.GET("/model3d/capabilities", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		view, err := svc.Model3DCapabilities(user.ID)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, view)
	})
	r.POST("/model3d/tasks", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		if !enforceRateLimit(c, "model3d:"+user.ID, 6, time.Minute) {
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 32<<10)
		req, err := bindModel3DCreateRequest(c)
		if err != nil {
			failService(c, err)
			return
		}
		view, err := svc.CreateModel3DTask(user.ID, req)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, view)
	})
	r.GET("/model3d/tasks/:id", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		view, err := svc.Model3DTask(user.ID, c.Param("id"))
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, view)
	})
	r.POST("/model3d/tasks/:id/recover", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		if !enforceRateLimit(c, "model3d-recover:"+user.ID, 6, time.Minute) {
			return
		}
		view, err := svc.RecoverModel3DTask(user.ID, c.Param("id"))
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, view)
	})
	r.GET("/model3d/requests/:requestId", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		view, err := svc.Model3DTaskByRequest(user.ID, c.Param("requestId"))
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, view)
	})
}
