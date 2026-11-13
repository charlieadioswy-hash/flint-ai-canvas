package handler

import (
	"github.com/gin-gonic/gin"
	"yingce/backend/internal/service"
)

func registerDramaSceneSplitRoutes(r *gin.RouterGroup, svc *service.Service) {
	const path = "/dramas/:id/episodes/:episodeId/scene-splits"
	r.GET(path, dramaRoute(svc, 0, func(c *gin.Context, userID string) (any, error) {
		return svc.DramaSceneSplits(userID, c.Param("id"), c.Param("episodeId"))
	}))
	r.POST(path+"/preflight", dramaRoute(svc, 64<<10, func(c *gin.Context, userID string) (any, error) {
		var req service.DramaSceneSplitRequest
		if err := bindDramaJSON(c, &req); err != nil {
			return nil, err
		}
		return svc.PreflightDramaSceneSplit(userID, c.Param("id"), c.Param("episodeId"), req)
	}))
	r.POST(path+"/execute", dramaRoute(svc, 64<<10, func(c *gin.Context, userID string) (any, error) {
		var req service.DramaSceneSplitRequest
		if err := bindDramaJSON(c, &req); err != nil {
			return nil, err
		}
		return svc.ExecuteDramaSceneSplit(userID, c.Param("id"), c.Param("episodeId"), req)
	}))
	r.POST(path+"/adopt", dramaRoute(svc, 16<<10, func(c *gin.Context, userID string) (any, error) {
		var req service.DramaSceneSplitAdoptRequest
		if err := bindDramaJSON(c, &req); err != nil {
			return nil, err
		}
		return svc.AdoptDramaSceneSplit(userID, c.Param("id"), c.Param("episodeId"), req)
	}))
}
