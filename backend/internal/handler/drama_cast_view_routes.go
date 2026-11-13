package handler

import (
	"github.com/gin-gonic/gin"
	"yingce/backend/internal/service"
)

func registerDramaCastViewRoutes(r *gin.RouterGroup, svc *service.Service) {
	const root = "/dramas/:id/cast/:castId/views"
	r.GET(root, dramaRoute(svc, 0, func(c *gin.Context, userID string) (any, error) {
		views, err := svc.DramaCastViews(userID, c.Param("id"), c.Param("castId"))
		return gin.H{"views": views}, err
	}))
	save := dramaRoute(svc, 128<<10, func(c *gin.Context, userID string) (any, error) {
		var req service.DramaCastViewSaveRequest
		if err := bindDramaJSON(c, &req); err != nil {
			return nil, err
		}
		return svc.SaveDramaCastView(userID, c.Param("id"), c.Param("castId"), c.Param("viewId"), req)
	})
	r.POST(root, save)
	r.PUT(root+"/:viewId", save)
	r.DELETE(root+"/:viewId", dramaRoute(svc, 8<<10, func(c *gin.Context, userID string) (any, error) {
		var req service.DramaCastViewActionRequest
		if err := bindDramaJSON(c, &req); err != nil {
			return nil, err
		}
		err := svc.DeleteDramaCastView(userID, c.Param("id"), c.Param("castId"), c.Param("viewId"), req)
		return gin.H{"deleted": err == nil}, err
	}))
	r.POST(root+"/:viewId/preflight", dramaRoute(svc, 8<<10, func(c *gin.Context, userID string) (any, error) {
		var req service.DramaCastViewActionRequest
		if err := bindDramaJSON(c, &req); err != nil {
			return nil, err
		}
		return svc.PreflightDramaCastView(userID, c.Param("id"), c.Param("castId"), c.Param("viewId"), req)
	}))
	r.POST(root+"/:viewId/execute", dramaRoute(svc, 8<<10, func(c *gin.Context, userID string) (any, error) {
		var req service.DramaCastViewActionRequest
		if err := bindDramaJSON(c, &req); err != nil {
			return nil, err
		}
		return svc.ExecuteDramaCastView(userID, c.Param("id"), c.Param("castId"), c.Param("viewId"), req)
	}))
	r.POST(root+"/:viewId/adopt", dramaRoute(svc, 8<<10, func(c *gin.Context, userID string) (any, error) {
		var req service.DramaCastViewAdoptRequest
		if err := bindDramaJSON(c, &req); err != nil {
			return nil, err
		}
		return svc.AdoptDramaCastView(userID, c.Param("id"), c.Param("castId"), c.Param("viewId"), req)
	}))
}
