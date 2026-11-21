package app

import (
	"encoding/json"
	"errors"
	"strings"
	"time"

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
			EpisodeID string `json:"dramaEpisodeId"`
			CastID    string `json:"dramaCastId"`
			ViewID    string `json:"dramaCastViewId"`
			Revision  int64  `json:"dramaCastViewRevision"`
			Hash      string `json:"dramaCastViewSourceHash"`
		} `json:"metadata"`
	}
	if err := json.Unmarshal([]byte(task.InputJSON), &input); err != nil {
		return true, err
	}
	if _, _, err := s.dramaForUser(task.UserID, task.ProjectID); err != nil {
		return true, err
	}
	take, err := s.repo.DramaCastViewTakeForTask(task.ProjectID, input.Metadata.ViewID, task.ID)
	if err != nil {
		return true, err
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
			currentHash, err = dramaCastViewContextSource(repo, *cast, input.Metadata.EpisodeID)
			var appErr *AppError
			if err != nil && (input.Metadata.EpisodeID == "" || !errors.As(err, &appErr) || appErr.Status != 404) {
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
	req.TakeID = strings.TrimSpace(req.TakeID)
	if req.ExpectedRevision == nil || req.ViewRevision == nil || req.TakeID == "" {
		return DramaCastViewResult{}, BadAuthRequest("请指定作品、视图版本和采用结果")
	}
	sourceViewID := viewID
	if req.SourceViewID != nil {
		sourceViewID = strings.TrimSpace(*req.SourceViewID)
	}
	err := s.withDramaTextEdit(projectID, req.ExpectedRevision, false, func(repo *repository.Repository) error {
		row, err := repo.DramaCastView(projectID, castID, viewID)
		if err != nil {
			return dramaLookupError(err)
		}
		if row.Revision != *req.ViewRevision {
			return repository.ErrDramaCastViewChanged
		}
		take, err := dramaAssetImageTake(repo, projectID, castID, sourceViewID, req.TakeID)
		if err != nil {
			return err
		}
		if err := requireDramaAssetImageTakeReady(repo, userID, *take); err != nil {
			return err
		}
		createTake := false
		if sourceViewID != viewID {
			if row.PendingTakeID != "" && row.TaskID != "" {
				task, err := repo.TaskForUser(userID, row.TaskID)
				if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
					return err
				}
				if task != nil && (task.Status == model.TaskStatusQueued || task.Status == model.TaskStatusRunning) {
					return dramaGuideConflict("目标视图正在生成，请完成后再替换")
				}
			}
			take, createTake, err = dramaAssetImageTakeForTarget(repo, *take, viewID, "cast_view")
			if err != nil {
				return err
			}
		}
		cast, err := repo.DramaCast(projectID, castID)
		if err != nil {
			return err
		}
		sourceHash, err := dramaCastViewSource(repo, *cast)
		if err != nil {
			return err
		}
		if row.CurrentTakeID == take.ID && row.ResourceID == take.ResourceID && row.Status == "ready" && row.PendingTakeID == "" && row.SourceHash == sourceHash {
			return errDramaCastViewTakeUnchanged
		}
		if createTake {
			if err := repo.CreateDramaTake(take); err != nil {
				return err
			}
		}
		row.SourceHash = sourceHash
		return repo.AdoptDramaCastViewTake(row, take, *req.ViewRevision)
	})
	if err != nil && !errors.Is(err, errDramaCastViewTakeUnchanged) {
		return DramaCastViewResult{}, dramaCastViewError(err)
	}
	return s.DramaCastView(userID, projectID, castID, viewID)
}

var errDramaCastViewTakeUnchanged = errors.New("已使用此视图版本")

func dramaAssetImageTake(repo *repository.Repository, projectID, castID, sourceViewID, takeID string) (*model.DramaTake, error) {
	if sourceViewID == "" {
		take, err := repo.DramaCastTake(projectID, castID, takeID)
		return take, dramaLookupError(err)
	}
	if _, err := repo.DramaCastView(projectID, castID, sourceViewID); err != nil {
		return nil, dramaLookupError(err)
	}
	take, err := repo.DramaCastViewTake(projectID, sourceViewID, takeID)
	return take, dramaLookupError(err)
}

func requireDramaAssetImageTakeReady(repo *repository.Repository, userID string, take model.DramaTake) error {
	if take.ResourceID == "" {
		return BadAuthRequest("只能采用已就绪的历史图片")
	}
	if err := repo.LockDramaCastImageReferences(userID, []string{take.ResourceID}); err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return BadAuthRequest("历史版本的图片不存在或无权使用")
		}
		return err
	}
	resource, err := repo.ResourceForUser(userID, take.ResourceID)
	if err != nil {
		return err
	}
	if resource.Status != model.ResourceStatusReady || !strings.HasPrefix(resource.MimeType, "image/") {
		return BadAuthRequest("只能采用已就绪的历史图片")
	}
	return nil
}

func dramaAssetImageTakeForTarget(repo *repository.Repository, source model.DramaTake, ownerID, kind string) (*model.DramaTake, bool, error) {
	originTakeID := firstNonEmpty(source.OriginTakeID, source.ID)
	existing, err := repo.DramaTakeForOrigin(source.ProjectID, ownerID, kind, originTakeID)
	if err == nil {
		if existing.ResourceID != source.ResourceID {
			return nil, false, dramaGuideConflict("目标视图的历史图片已变化，请刷新后重试")
		}
		return existing, false, nil
	}
	if !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, false, err
	}
	return &model.DramaTake{
		ID: newID(), OriginTakeID: originTakeID, ProjectID: source.ProjectID, OwnerID: ownerID, Kind: kind,
		ResourceID: source.ResourceID, TaskID: source.TaskID, Prompt: source.Prompt, CreatedAt: time.Now(),
	}, true, nil
}
