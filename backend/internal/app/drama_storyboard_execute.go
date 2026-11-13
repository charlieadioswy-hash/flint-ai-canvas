package app

import (
	"encoding/json"
	"errors"
	"fmt"

	"gorm.io/gorm"
	"yingce/backend/internal/model"
	"yingce/backend/internal/repository"
)

func (s *Service) ExecuteDramaStoryboard(userID, projectID, boardID string, req DramaStoryboardActionRequest) (*model.Task, error) {
	if _, err := s.dramaStoryboardScope(userID, projectID, boardID); err != nil {
		return nil, err
	}
	if req.ExpectedRevision == nil || req.BaseRevision == nil || req.ConfirmationToken == "" || req.ClientOperationID == "" {
		return nil, BadAuthRequest("请先预检并确认故事板生成")
	}
	submission, err := newTaskSubmission(userID, req.ClientOperationID, "drama_storyboard_image", []any{projectID, boardID, req})
	if err != nil {
		return nil, err
	}
	if replay, err := s.replayDramaStoryboardTask(userID, boardID, submission); replay != nil || err != nil {
		return replay, err
	}
	plan, err := s.prepareDramaStoryboard(s.repo, userID, projectID, boardID, req)
	if err != nil {
		return nil, dramaStoryboardError(err)
	}
	if !plan.view.Ready || plan.view.ConfirmationToken != req.ConfirmationToken {
		return nil, dramaGuideConflict("故事板原稿、参数或报价已变化，请重新预检")
	}
	metadata := plan.request.Input["metadata"].(map[string]any)
	metadata["dramaStoryboardRequestHash"] = submission.Hash
	prepare := &creationTaskPreparation{}
	plan.request.creationPrepare = prepare
	plan.request.admission = &taskAdmission{ID: submission.ID, MaxCharge: plan.view.AmountMicrocredits}
	task, err := s.CreateTask(userID, plan.request)
	if err != nil {
		return nil, err
	}
	if err := s.protectPreparedDramaShotTask(task); err != nil {
		return nil, err
	}
	if prepare.Order != nil {
		task.BillingOrderID = prepare.Order.ID
	}
	policy, err := s.RuntimePolicy()
	if err != nil {
		return nil, err
	}
	s.storageMu.Lock()
	err = s.repo.Transaction(func(repo *repository.Repository) error {
		if _, err := repo.DramaProductionForUpdate(projectID); err != nil {
			return err
		}
		if err := repo.LockDramaCastImageReferences(userID, plan.config.ReferenceResourceIDs); err != nil {
			return BadAuthRequest("参考图片已变化，请重新预检")
		}
		fresh, err := s.prepareDramaStoryboard(repo, userID, projectID, boardID, req)
		if err != nil {
			return err
		}
		if !fresh.view.Ready || fresh.view.ConfirmationToken != req.ConfirmationToken {
			return repository.ErrDramaStoryboardChanged
		}
		if err := createTaskWithStorageQuotaRepository(repo, task, prepare.Order, policy); err != nil {
			return err
		}
		return repo.BindDramaStoryboardTask(&fresh.board, task.ID, fresh.board.Revision)
	})
	s.storageMu.Unlock()
	if err != nil {
		if replay, replayErr := s.replayDramaStoryboardTask(userID, boardID, submission); replay != nil || replayErr != nil {
			return replay, replayErr
		}
		if errors.Is(err, repository.ErrActiveTaskLimit) {
			return nil, BadAuthRequest(fmt.Sprintf("同时排队或运行的任务最多 %d 个，请等待已有任务完成", policy.Task.ActiveTaskLimit))
		}
		if errors.Is(err, repository.ErrInsufficientCredits) {
			return nil, BadAuthRequest("积分不足，请先充值")
		}
		return nil, dramaStoryboardError(err)
	}
	s.recordActivity(userID, "task", 1)
	_ = s.log(userID, task.ID, "info", "宫格故事板任务已入队", "")
	s.wakeTaskDispatcher()
	return taskForOutput(*task), nil
}

func (s *Service) replayDramaStoryboardTask(userID, boardID string, submission *taskSubmission) (*model.Task, error) {
	task, err := s.repo.TaskForUser(userID, submission.ID)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var input struct {
		Metadata struct{ Source, BoardID, Hash string }
	}
	var raw map[string]any
	if json.Unmarshal([]byte(task.InputJSON), &raw) != nil {
		return nil, dramaGuideConflict("故事板任务回执损坏")
	}
	metadata, _ := raw["metadata"].(map[string]any)
	input.Metadata.Source, _ = metadata["source"].(string)
	input.Metadata.BoardID, _ = metadata["dramaStoryboardBoardId"].(string)
	input.Metadata.Hash, _ = metadata["dramaStoryboardRequestHash"].(string)
	if input.Metadata.Source != "drama_storyboard_board" || input.Metadata.BoardID != boardID || input.Metadata.Hash != submission.Hash {
		return nil, dramaGuideConflict("同一提交标识的故事板生成内容不同")
	}
	return taskForOutput(*task), nil
}

func (s *Service) RegisterDramaStoryboardTaskOutput(task model.Task) (bool, error) {
	var input struct {
		Metadata struct {
			Source  string `json:"source"`
			BoardID string `json:"dramaStoryboardBoardId"`
		} `json:"metadata"`
	}
	if json.Unmarshal([]byte(task.InputJSON), &input) != nil || input.Metadata.Source != "drama_storyboard_board" {
		return false, nil
	}
	if task.Status != model.TaskStatusSucceeded {
		return true, nil
	}
	if task.Type != "canvas_image" || input.Metadata.BoardID == "" {
		return true, errors.New("故事板任务类型或归属无效")
	}
	if _, _, err := s.dramaForUser(task.UserID, task.ProjectID); err != nil {
		return true, err
	}
	resourceID := dramaTaskResource(&task)
	if resourceID == "" {
		return true, errors.New("故事板任务尚未保存真实图片")
	}
	err := s.repo.Transaction(func(repo *repository.Repository) error {
		if _, err := repo.DramaProductionForUpdate(task.ProjectID); err != nil {
			return err
		}
		board, err := repo.DramaStoryboard(task.ProjectID, input.Metadata.BoardID)
		if err != nil {
			return err
		}
		if board.UserID != task.UserID || board.TaskID != task.ID {
			return errors.New("故事板任务未绑定当前生成记录")
		}
		if err := repo.LockDramaCastImageReferences(task.UserID, []string{resourceID}); err != nil {
			return err
		}
		resource, err := repo.ResourceForUser(task.UserID, resourceID)
		if err != nil || resource.Status != model.ResourceStatusReady || resource.Kind != "image" {
			return errors.New("故事板产物尚未就绪或不是图片")
		}
		return repo.CompleteDramaStoryboard(board, resource)
	})
	return true, err
}
