package handler

import (
	"github.com/gin-gonic/gin"
	"yingce/backend/internal/service"
)

func registerDramaStoryboardRoutes(r *gin.RouterGroup, svc *service.Service) {
	r.GET("/dramas/:id/episodes/:episodeId/storyboards", dramaRoute(svc, 0, func(c *gin.Context, userID string) (any, error) {
		return svc.DramaStoryboards(userID, c.Param("id"), c.Param("episodeId"))
	}))
	r.POST("/dramas/:id/storyboards", dramaRoute(svc, 256<<10, func(c *gin.Context, userID string) (any, error) {
		var req service.DramaStoryboardCreateRequest
		if err := bindDramaJSON(c, &req); err != nil {
			return nil, err
		}
		return svc.CreateDramaStoryboard(userID, c.Param("id"), req)
	}))
	r.POST("/dramas/:id/storyboards/quote", dramaRoute(svc, 256<<10, func(c *gin.Context, userID string) (any, error) {
		var req service.DramaStoryboardCreateRequest
		if err := bindDramaJSON(c, &req); err != nil {
			return nil, err
		}
		return svc.QuoteDramaStoryboard(userID, c.Param("id"), req)
	}))
	const path = "/dramas/:id/storyboards/:boardId"
	r.GET(path, dramaRoute(svc, 0, func(c *gin.Context, userID string) (any, error) {
		return svc.DramaStoryboard(userID, c.Param("id"), c.Param("boardId"))
	}))
	r.POST(path+"/preflight", dramaRoute(svc, 8<<10, func(c *gin.Context, userID string) (any, error) {
		var req service.DramaStoryboardActionRequest
		if err := bindDramaJSON(c, &req); err != nil {
			return nil, err
		}
		return svc.PreflightDramaStoryboard(userID, c.Param("id"), c.Param("boardId"), req)
	}))
	r.POST(path+"/execute", dramaRoute(svc, 8<<10, func(c *gin.Context, userID string) (any, error) {
		var req service.DramaStoryboardActionRequest
		if err := bindDramaJSON(c, &req); err != nil {
			return nil, err
		}
		return svc.ExecuteDramaStoryboard(userID, c.Param("id"), c.Param("boardId"), req)
	}))
	r.POST(path+"/split", dramaRoute(svc, 8<<10, func(c *gin.Context, userID string) (any, error) {
		var req service.DramaStoryboardActionRequest
		if err := bindDramaJSON(c, &req); err != nil {
			return nil, err
		}
		return svc.SplitDramaStoryboard(c.Request.Context(), userID, c.Param("id"), c.Param("boardId"), req)
	}))
	r.POST(path+"/adopt", dramaRoute(svc, 8<<10, func(c *gin.Context, userID string) (any, error) {
		var req service.DramaStoryboardAdoptRequest
		if err := bindDramaJSON(c, &req); err != nil {
			return nil, err
		}
		return svc.AdoptDramaStoryboardCell(userID, c.Param("id"), c.Param("boardId"), req)
	}))
}
