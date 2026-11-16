package handler

import (
	"github.com/gin-gonic/gin"
	"yingce/backend/internal/service"
)

func registerDramaEpisodeStyleRoutes(r *gin.RouterGroup, svc *service.Service) {
	const path = "/dramas/:id/episodes/:episodeId/style"
	r.GET(path, dramaRoute(svc, 0, func(c *gin.Context, userID string) (any, error) {
		return svc.DramaEpisodeStyle(userID, c.Param("id"), c.Param("episodeId"))
	}))
	r.PATCH(path, dramaRoute(svc, 128<<10, func(c *gin.Context, userID string) (any, error) {
		var req service.UpdateDramaEpisodeStyleRequest
		if err := bindDramaJSON(c, &req); err != nil {
			return nil, err
		}
		return svc.UpdateDramaEpisodeStyle(userID, c.Param("id"), c.Param("episodeId"), req)
	}))
}
