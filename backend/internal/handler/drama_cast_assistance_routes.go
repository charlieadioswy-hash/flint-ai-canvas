package handler

import (
	"github.com/gin-gonic/gin"
	"yingce/backend/internal/service"
)

func registerDramaCastAssistanceRoutes(r *gin.RouterGroup, svc *service.Service) {
	const path = "/dramas/:id/cast/:castId/assistance"
	r.GET(path, dramaRoute(svc, 0, func(c *gin.Context, userID string) (any, error) {
		return svc.DramaCastAssistance(userID, c.Param("id"), c.Param("castId"))
	}))
	r.POST(path+"/preflight", dramaRoute(svc, 32<<10, func(c *gin.Context, userID string) (any, error) {
		var req service.DramaCastAssistanceRequest
		if err := bindDramaJSON(c, &req); err != nil {
			return nil, err
		}
		return svc.PreflightDramaCastAssistance(userID, c.Param("id"), c.Param("castId"), req)
	}))
	r.POST(path+"/execute", dramaRoute(svc, 32<<10, func(c *gin.Context, userID string) (any, error) {
		var req service.DramaCastAssistanceRequest
		if err := bindDramaJSON(c, &req); err != nil {
			return nil, err
		}
		return svc.ExecuteDramaCastAssistance(userID, c.Param("id"), c.Param("castId"), req)
	}))
	r.POST(path+"/adopt", dramaRoute(svc, 128<<10, func(c *gin.Context, userID string) (any, error) {
		var req service.DramaCastAssistanceAdoptRequest
		if err := bindDramaJSON(c, &req); err != nil {
			return nil, err
		}
		return svc.AdoptDramaCastAssistance(userID, c.Param("id"), c.Param("castId"), req)
	}))
}
