package app

import (
	"strings"

	"yingce/backend/internal/model"
	"yingce/backend/internal/repository"
)

// 保存付费试听版本只绑定历史资源；角色声音仍由独立的采用操作决定。
func (s *Service) RegisterDramaCastAssistanceTaskOutput(task model.Task) (bool, error) {
	metadata, err := dramaCastAssistanceTaskMetadata(&task)
	if metadata.Source != "drama_cast_assistance" {
		return false, nil
	}
	if err != nil {
		return true, err
	}
	if task.Status != model.TaskStatusSucceeded || metadata.Purpose != "voice_sample" {
		return true, nil
	}
	if _, _, err := s.dramaForUser(task.UserID, task.ProjectID); err != nil {
		return true, err
	}
	resourceID := dramaTaskResource(&task)
	err = s.repo.Transaction(func(repo *repository.Repository) error {
		if _, err := repo.DramaProductionForUpdate(task.ProjectID); err != nil {
			return err
		}
		if err := repo.LockDramaCastImageReferences(task.UserID, []string{resourceID}); err != nil {
			return BadAuthRequest("声音任务未返回有效音频资源")
		}
		resource, err := repo.ResourceForUser(task.UserID, resourceID)
		if err != nil || resource.Kind != "audio" || resource.Status != model.ResourceStatusReady || !strings.HasPrefix(resource.MimeType, "audio/") {
			return BadAuthRequest("声音任务未返回已就绪的音频资源")
		}
		return repo.BindDramaCastAssistanceResource(task.ProjectID, metadata.CastID, task.ID, resourceID)
	})
	return true, err
}
