package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"gorm.io/gorm"
	"yingce/backend/internal/model"
	"yingce/backend/internal/repository"
)

func (s *Service) ExecuteDramaShotMedia(userID, projectID, shotID, kind string, req DramaShotMediaActionRequest) (*model.Task, error) {
	if _, _, err := s.dramaShotMediaScope(userID, projectID, shotID, kind); err != nil {
		return nil, err
	}
	if req.ExpectedRevision == nil || req.BaseRevision == nil || req.ConfirmationToken == "" || req.ClientOperationID == "" {
		return nil, BadAuthRequest("请先预检并确认本次镜头生成")
	}
	submission, err := newTaskSubmission(userID, req.ClientOperationID, "drama_shot_media", []any{projectID, shotID, kind, req})
	if err != nil {
		return nil, err
	}
	if replay, err := s.replayDramaShotMediaSubmission(userID, submission); replay != nil || err != nil {
		return replay, err
	}
	plan, err := s.prepareDramaShotMedia(s.repo, userID, projectID, shotID, kind, req)
	if err != nil {
		return nil, dramaShotMediaError(err)
	}
	if !plan.view.Ready || plan.view.ConfirmationToken != req.ConfirmationToken {
		return nil, dramaGuideConflict("镜头内容、依赖或报价已改变，请重新预检")
	}
	metadata := plan.request.Input["metadata"].(map[string]any)
	metadata["dramaShotMediaId"], metadata["dramaShotMediaRevision"] = plan.row.ID, plan.row.Revision+1
	metadata["dramaShotScriptHash"], metadata["dramaShotMediaRequestHash"] = dramaShotScriptHash(plan.shot), submission.Hash
	if kind == "video" {
		metadata["dramaShotPromptHash"] = dramaShotMediaDigest(stringValue(plan.request.Input["prompt"]))
		metadata["dramaShotCameraPromptVersion"] = dramaShotCameraPromptVersion
	}
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
	take := model.DramaTake{ID: newID(), ProjectID: projectID, OwnerID: shotID, Kind: "shot_" + kind, TaskID: task.ID, Prompt: task.Prompt, CreatedAt: time.Now()}
	s.storageMu.Lock()
	err = s.repo.Transaction(func(repo *repository.Repository) error {
		if _, err := repo.DramaProductionForUpdate(projectID); err != nil {
			return err
		}
		if err := lockDramaShotReferenceSubjects(repo, projectID, kind, plan.view.Config); err != nil {
			return err
		}
		if err := repo.LockDramaCastImageReferences(userID, dramaShotMediaReferenceIDs(plan.view.Config)); err != nil {
			return BadAuthRequest("参考图或首尾帧已变化，请重新预检")
		}
		fresh, err := s.prepareDramaShotMedia(repo, userID, projectID, shotID, kind, req)
		if err != nil {
			return err
		}
		if !fresh.view.Ready || fresh.view.ConfirmationToken != req.ConfirmationToken {
			return repository.ErrDramaShotMediaChanged
		}
		if err := createTaskWithStorageQuotaRepository(repo, task, prepare.Order, policy); err != nil {
			return err
		}
		fresh.row.ScriptHash, fresh.row.UpdatedAt = dramaShotScriptHash(fresh.shot), time.Now()
		return repo.BindDramaShotMediaTask(&fresh.row, &take, fresh.row.Revision)
	})
	s.storageMu.Unlock()
	if err != nil {
		// A concurrent identical call may have committed after our first lookup.
		// Replay the durable task instead of reserving a second order.
		if replay, replayErr := s.replayDramaShotMediaSubmission(userID, submission); replay != nil || replayErr != nil {
			return replay, replayErr
		}
		if errors.Is(err, repository.ErrActiveTaskLimit) {
			return nil, BadAuthRequest(fmt.Sprintf("同时排队或运行的任务最多 %d 个，请等待已有任务完成", policy.Task.ActiveTaskLimit))
		}
		if errors.Is(err, repository.ErrInsufficientCredits) {
			return nil, BadAuthRequest("积分不足，请先充值")
		}
		return nil, dramaShotMediaError(err)
	}
	s.recordActivity(userID, "task", 1)
	_ = s.log(userID, task.ID, "info", "镜头媒体任务已入队并绑定版本", "")
	s.wakeTaskDispatcher()
	return taskForOutput(*task), nil
}

func (s *Service) protectPreparedDramaShotTask(task *model.Task) error {
	var input map[string]any
	if err := json.Unmarshal([]byte(task.InputJSON), &input); err != nil {
		return err
	}
	if err := s.protectTaskSecrets(input); err != nil {
		return err
	}
	encoded, err := json.Marshal(input)
	if err == nil {
		task.InputJSON = string(encoded)
	}
	return err
}

func (s *Service) replayDramaShotMediaSubmission(userID string, submission *taskSubmission) (*model.Task, error) {
	task, err := s.repo.TaskForUser(userID, submission.ID)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var input struct {
		Metadata struct {
			Source string `json:"source"`
			Hash   string `json:"dramaShotMediaRequestHash"`
		} `json:"metadata"`
	}
	if json.Unmarshal([]byte(task.InputJSON), &input) != nil || input.Metadata.Source != "drama_shot_media" || input.Metadata.Hash != submission.Hash {
		return nil, dramaGuideConflict("同一提交标识的镜头生成内容不同，请重新提交")
	}
	return taskForOutput(*task), nil
}
