package app

import (
	"encoding/json"
	"errors"

	"gorm.io/gorm"
	"yingce/backend/internal/model"
	"yingce/backend/internal/repository"
)

func (s *Service) RegisterDramaCastViewTaskOutput(task model.Task) (bool, error) {
	if !taskHasDramaCastViewOrigin(task.InputJSON) {
		return false, nil
	}
	if task.Status != model.TaskStatusSucceeded {
		return true, nil
	}
	var input struct {
		Metadata struct {
			CastID   string `json:"dramaCastId"`
			ViewID   string `json:"dramaCastViewId"`
			Revision int64  `json:"dramaCastViewRevision"`
			Hash     string `json:"dramaCastViewSourceHash"`
		} `json:"metadata"`
	}
	if err := json.Unmarshal([]byte(task.InputJSON), &input); err != nil {
		return true, err
	}
	if _, _, err := s.dramaForUser(task.UserID, task.ProjectID); err != nil {
		return true, err
	}
	take, err := s.repo.DramaCastViewTakeForTask(task.ProjectID, task.ID)
	if err != nil {
		return true, err
	}
	if take.OwnerID != input.Metadata.ViewID {
		return true, BadAuthRequest("视图任务归属不一致")
	}
	take.ResourceID, err = dramaCastImageResource(&task)
	if err != nil {
		return true, BadAuthRequest(err.Error())
	}
	err = s.repo.Transaction(func(repo *repository.Repository) error {
		if _, err := repo.DramaProductionForUpdate(task.ProjectID); err != nil {
			return err
		}
		if err := repo.LockDramaCastImageReferences(task.UserID, []string{take.ResourceID}); err != nil {
			return err
		}
		resource, err := repo.ResourceForUser(task.UserID, take.ResourceID)
		if err != nil || resource.Kind != "image" || resource.Status != model.ResourceStatusReady {
			return BadAuthRequest("视图图片未就绪或类型不符")
		}
		row, err := repo.DramaCastView(task.ProjectID, input.Metadata.CastID, take.OwnerID)
		if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		cast, castErr := repo.DramaCast(task.ProjectID, input.Metadata.CastID)
		if castErr != nil && !errors.Is(castErr, gorm.ErrRecordNotFound) {
			return castErr
		}
		currentHash := ""
		if cast != nil {
			currentHash, err = dramaCastViewSource(repo, *cast)
			if err != nil {
				return err
			}
		}
		activate := row != nil && cast != nil && row.Revision == input.Metadata.Revision && row.SourceHash == input.Metadata.Hash && currentHash == input.Metadata.Hash
		if row == nil {
			row = &model.DramaCastView{}
		}
		return repo.CompleteDramaCastViewTask(take, row, input.Metadata.Revision, activate)
	})
	return true, err
}

func (s *Service) AdoptDramaCastView(userID, projectID, castID, viewID string, req DramaCastViewAdoptRequest) (DramaCastViewResult, error) {
	if err := s.dramaCastViewScope(userID, projectID, castID); err != nil {
		return DramaCastViewResult{}, err
	}
	if req.ExpectedRevision == nil || req.ViewRevision == nil || req.TakeID == "" {
		return DramaCastViewResult{}, BadAuthRequest("请指定作品、视图版本和采用结果")
	}
	err := s.withDramaTextEdit(projectID, req.ExpectedRevision, false, func(repo *repository.Repository) error {
		row, err := repo.DramaCastView(projectID, castID, viewID)
		if err != nil {
			return err
		}
		take, err := repo.DramaCastViewTake(projectID, viewID, req.TakeID)
		if err != nil {
			return err
		}
		if err := repo.LockDramaCastImageReferences(userID, []string{take.ResourceID}); err != nil {
			return BadAuthRequest("视图产物不可用")
		}
		resource, err := repo.ResourceForUser(userID, take.ResourceID)
		if err != nil || resource.Status != model.ResourceStatusReady || resource.Kind != "image" {
			return BadAuthRequest("只能采用当前视图已就绪的图片")
		}
		task, err := repo.TaskForUser(userID, take.TaskID)
		if err != nil || task.Status != model.TaskStatusSucceeded {
			return BadAuthRequest("视图任务尚未成功")
		}
		cast, err := repo.DramaCast(projectID, castID)
		if err != nil {
			return err
		}
		row.SourceHash, err = dramaCastViewSource(repo, *cast)
		if err != nil {
			return err
		}
		return repo.AdoptDramaCastViewTake(row, take, *req.ViewRevision)
	})
	if err != nil {
		return DramaCastViewResult{}, dramaCastViewError(err)
	}
	return s.DramaCastView(userID, projectID, castID, viewID)
}
