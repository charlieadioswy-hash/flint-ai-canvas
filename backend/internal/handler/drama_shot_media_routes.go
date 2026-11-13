package handler

import (
	"github.com/gin-gonic/gin"
	"yingce/backend/internal/service"
)

func registerDramaShotMediaRoutes(r *gin.RouterGroup, svc *service.Service) {
	const path = "/dramas/:id/shots/:shotId/media/:kind"
	r.GET(path, dramaRoute(svc, 0, func(c *gin.Context, userID string) (any, error) {
		return svc.DramaShotMedia(userID, c.Param("id"), c.Param("shotId"), c.Param("kind"))
	}))
	r.PUT(path, dramaRoute(svc, 256<<10, func(c *gin.Context, userID string) (any, error) {
		var req service.DramaShotMediaSaveRequest
		if err := bindDramaJSON(c, &req); err != nil {
			return nil, err
		}
		return svc.SaveDramaShotMedia(userID, c.Param("id"), c.Param("shotId"), c.Param("kind"), req)
	}))
	r.POST(path+"/preflight", dramaRoute(svc, 8<<10, func(c *gin.Context, userID string) (any, error) {
		var req service.DramaShotMediaActionRequest
		if err := bindDramaJSON(c, &req); err != nil {
			return nil, err
		}
		return svc.PreflightDramaShotMedia(userID, c.Param("id"), c.Param("shotId"), c.Param("kind"), req)
	}))
	r.POST(path+"/execute", dramaRoute(svc, 8<<10, func(c *gin.Context, userID string) (any, error) {
		var req service.DramaShotMediaActionRequest
		if err := bindDramaJSON(c, &req); err != nil {
			return nil, err
		}
		return svc.ExecuteDramaShotMedia(userID, c.Param("id"), c.Param("shotId"), c.Param("kind"), req)
	}))
	r.POST(path+"/adopt", dramaRoute(svc, 8<<10, func(c *gin.Context, userID string) (any, error) {
		var req service.DramaShotMediaAdoptRequest
		if err := bindDramaJSON(c, &req); err != nil {
			return nil, err
		}
		return svc.AdoptDramaShotMedia(userID, c.Param("id"), c.Param("shotId"), c.Param("kind"), req)
	}))
}
