package handler

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"yingce/backend/internal/service"
)

func registerModel3DExportRoutes(r *gin.RouterGroup, svc *service.Service) {
	r.GET("/model3d/exports/capabilities", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		view, err := svc.Model3DExportCapabilities(user.ID)
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, view)
	})
	r.POST("/model3d/exports", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		if !enforceRateLimit(c, "model3d-export:"+user.ID, 10, time.Minute) {
			return
		}
		var view *service.Model3DExportView
		var req service.Model3DExportRequest
		if strings.HasPrefix(c.ContentType(), "multipart/form-data") {
			c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, (128<<20)+(64<<10))
			if c.Request.ParseMultipartForm(8<<20) != nil {
				failService(c, service.BadAuthRequest("模型上传无效或超过 128MB"))
				return
			}
			defer c.Request.MultipartForm.RemoveAll()
			files := c.Request.MultipartForm.File["file"]
			if len(files) != 1 || len(c.Request.MultipartForm.File) != 1 {
				failService(c, service.BadAuthRequest("每次只能上传一个模型文件"))
				return
			}
			req = service.Model3DExportRequest{RequestID: c.PostForm("requestId"), ResourceID: c.PostForm("resourceId"), SourceFormat: c.PostForm("sourceFormat"), FileName: c.PostForm("fileName"), Format: c.PostForm("format"), Animation: c.PostForm("animation")}
			if fps := c.PostForm("fps"); fps != "" {
				req.FPS, err = strconv.Atoi(fps)
				if err != nil {
					failService(c, service.BadAuthRequest("导出帧率须为 1–120 的整数"))
					return
				}
			}
			view, err = svc.CreateModel3DExportUpload(c.Request.Context(), user.ID, req, files[0])
		} else {
			c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, 16<<10)
			if c.ShouldBindJSON(&req) != nil {
				failService(c, service.BadAuthRequest("模型导出请求格式无效"))
				return
			}
			view, err = svc.CreateModel3DExport(user.ID, req)
		}
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, view)
	})
	r.GET("/model3d/exports/:id", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		view, err := svc.Model3DExport(user.ID, c.Param("id"))
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, view)
	})
	r.DELETE("/model3d/exports/:id", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		view, err := svc.CancelModel3DExport(user.ID, c.Param("id"))
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, view)
	})
	r.DELETE("/model3d/exports/by-request/:requestId", func(c *gin.Context) {
		user, err := currentUser(c, svc)
		if err != nil {
			failService(c, err)
			return
		}
		if !enforceRateLimit(c, "model3d-export-cancel:"+user.ID, 30, time.Minute) {
			return
		}
		view, err := svc.CancelModel3DExportByRequest(user.ID, c.Param("requestId"))
		if err != nil {
			failService(c, err)
			return
		}
		ok(c, view)
	})
}
