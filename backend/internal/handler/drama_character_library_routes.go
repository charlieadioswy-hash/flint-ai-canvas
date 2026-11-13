package handler

import (
	"yingce/backend/internal/service"

	"github.com/gin-gonic/gin"
)

func registerDramaCharacterLibraryRoutes(r *gin.RouterGroup, svc *service.Service) {
	r.POST("/dramas/:id/cast/character-library/import", dramaRoute(svc, 16<<10, func(c *gin.Context, userID string) (any, error) {
		var req service.ImportDramaCharacterLibraryRequest
		if err := bindDramaJSON(c, &req); err != nil {
			return nil, err
		}
		cast, err := svc.ImportDramaCharacterLibrary(userID, c.Param("id"), req)
		return gin.H{"cast": cast}, err
	}))
	r.POST("/dramas/:id/cast/:castId/character-library/save", dramaRoute(svc, 8<<10, func(c *gin.Context, userID string) (any, error) {
		var req service.SaveDramaCharacterLibraryRequest
		if err := bindDramaJSON(c, &req); err != nil {
			return nil, err
		}
		return svc.SaveDramaCharacterLibrary(userID, c.Param("id"), c.Param("castId"), req)
	}))
	r.PATCH("/dramas/:id/cast/:castId/definition", dramaRoute(svc, 128<<10, func(c *gin.Context, userID string) (any, error) {
		var req service.UpdateDramaCharacterDefinitionRequest
		if err := bindDramaJSON(c, &req); err != nil {
			return nil, err
		}
		cast, err := svc.UpdateDramaCharacterDefinition(userID, c.Param("id"), c.Param("castId"), req)
		return gin.H{"cast": cast}, err
	}))
	r.GET("/dramas/:id/cast/:castId/usage", dramaRoute(svc, 0, func(c *gin.Context, userID string) (any, error) {
		return svc.DramaCharacterUsage(userID, c.Param("id"), c.Param("castId"))
	}))
}
