package app

import (
	"encoding/json"
	"strings"
	"time"

	"yingce/backend/internal/assets"
	"yingce/backend/internal/model"
	"yingce/backend/internal/model3d"
	"yingce/backend/internal/repository"
)

type model3DProcessingSource struct {
	TaskID          string `json:"taskId"`
	ResourceID      string `json:"resourceId"`
	ResourceVersion string `json:"resourceVersion"`
	ProviderTaskID  string `json:"providerTaskId"`
}

func (s *Service) ownedModel3DProcessingSource(userID, id string) (*model.Task, model3DInput, Model3DResult, error) {
	var input model3DInput
	var result Model3DResult
	if assets.ValidID(id) == "" {
		return nil, input, result, BadAuthRequest("来源任务标识无效")
	}
	task, err := s.repo.TaskForUser(userID, id)
	if err != nil {
		return nil, input, result, model3DError(err)
	}
	if task.Type != model.TaskTypeCanvasModel3D || task.WorkbenchKind != model.WorkbenchKindModel3D || task.ProjectID != "" {
		return nil, input, result, BadAuthRequest("请选择独立 3D 创作中的任务")
	}
	if task.Status != model.TaskStatusSucceeded || task.ProviderRequestID == "" || json.Unmarshal([]byte(task.InputJSON), &input) != nil || json.Unmarshal([]byte(task.ResultJSON), &result) != nil {
		return nil, input, result, BadAuthRequest("来源任务尚未成功完成或结果不可用")
	}
	return task, input, result, nil
}

func (s *Service) prepareModel3DProcessing(userID string, p model3d.Processing, record *model.Model3DConfig, config model3d.Config) (model3DInput, map[string]string, error) {
	var prepared model3DInput
	if err := model3d.ValidateProcessing(p); err != nil {
		return prepared, nil, BadAuthRequest(err.Error())
	}
	source, input, result, err := s.ownedModel3DProcessingSource(userID, p.SourceTaskID)
	if err != nil {
		return prepared, nil, err
	}
	previous := ""
	if input.Processing != nil {
		previous = input.Processing.Operation
	}
	switch p.Operation {
	case "segment", "rig_check":
		// The documented task_id input contract names generation tasks only.
		if previous != "" {
			return prepared, nil, BadAuthRequest("请从原始生成模型发起拆分或绑骨检查")
		}
	case "complete":
		if previous != "segment" {
			return prepared, nil, BadAuthRequest("部件补全须选择已完成的拆分结果")
		}
		for _, name := range p.PartNames {
			if !model3d.Contains(result.Parts, name) {
				return prepared, nil, BadAuthRequest("所选部件不属于此拆分结果")
			}
		}
	case "rig":
		if previous != "rig_check" || result.RigCheck == nil || !result.RigCheck.Riggable || input.Source == nil {
			return prepared, nil, BadAuthRequest("请先完成绑骨检查，且确认模型可绑骨")
		}
		if p.RigType != result.RigCheck.RigType {
			return prepared, nil, BadAuthRequest("骨架类型须与检查结果一致")
		}
		// Rig the model that was checked, never the check task itself.
		source, input, result, err = s.ownedModel3DProcessingSource(userID, input.Source.TaskID)
		if err != nil {
			return prepared, nil, err
		}
		if input.Processing != nil {
			return prepared, nil, BadAuthRequest("绑骨检查的模型来源无效")
		}
	case "animate":
		if previous != "rig" || input.Processing.RigType != p.RigType || !model3d.Contains([]string{"v2.5-20260210", "v3.0-20260909"}, input.Processing.Model) {
			return prepared, nil, BadAuthRequest("请从匹配骨架类型的已绑骨版本生成动画")
		}
	}
	oldRecord, err := s.repo.Model3DConfig(input.ConfigID)
	if err != nil {
		return prepared, nil, model3DError(err)
	}
	oldConfig, err := s.model3DDomainConfig(oldRecord)
	if err != nil || oldRecord.ProviderID != record.ProviderID || oldConfig.APIKey != config.APIKey || oldConfig.Type != config.Type {
		return prepared, nil, BadAuthRequest("来源模型与当前 3D 服务账号不一致，请恢复原服务配置后再处理")
	}
	resource, err := s.repo.ResourceForUser(userID, result.ResourceID)
	if err != nil {
		return prepared, nil, model3DError(err)
	}
	if resource.Kind != "model" || resource.Status != model.ResourceStatusReady || !model3d.Contains([]string{"glb", "fbx"}, result.Format) {
		return prepared, nil, BadAuthRequest("来源模型文件不可用")
	}
	version := model.ImageModerationResourceVersion(resource)
	prepared = model3DInput{ConfigID: record.ID, Mode: input.Mode, Prompt: input.Prompt, Parameters: input.Parameters, ReferenceImages: []model3DReference{}, Processing: &p,
		Source: &model3DProcessingSource{TaskID: source.ID, ResourceID: resource.ID, ResourceVersion: version, ProviderTaskID: source.ProviderRequestID}, ClientContext: model3DClientContext{Scope: "standalone"}}
	return prepared, map[string]string{resource.ID: version}, nil
}

func (s *Service) createModel3DProcessingTask(userID string, req Model3DCreateRequest, record *model.Model3DConfig, config model3d.Config, revision int64, hash string) (*Model3DTaskView, error) {
	if req.Scope != "standalone" || req.Mode != "" || req.Prompt != "" || req.ImageResourceID != "" || req.Views != nil || req.Parameters != (model3d.Parameters{}) || req.GroupID != "" || req.CandidateIndex != 0 || req.CandidateCount != 0 {
		return nil, BadAuthRequest("模型处理须为独立任务，不能混用生成输入或候选参数")
	}
	input, versions, err := s.prepareModel3DProcessing(userID, *req.Processing, record, config)
	if err != nil {
		return nil, err
	}
	input.SourceFingerprint = req.SourceFingerprint
	policy, err := s.RuntimePolicy()
	if err != nil {
		return nil, err
	}
	if req.Processing.Operation != "rig_check" {
		if err := s.requireStoredFileCapacityForTask(userID, model.TaskTypeCanvasModel3D, policy); err != nil {
			return nil, err
		}
	}
	encoded, err := json.Marshal(input)
	if err != nil {
		return nil, err
	}
	label := model3d.ProcessingLabel(req.Processing.Operation)
	task := &model.Task{ID: newID(), UserID: userID, WorkbenchKind: model.WorkbenchKindModel3D, Type: model.TaskTypeCanvasModel3D, Status: model.TaskStatusQueued, Stage: "等待队列调度", Prompt: label + " · " + strings.TrimSpace(input.Prompt), Operation: "model3d_" + req.Processing.Operation, Provider: model3d.ProviderTripo, Model: req.Processing.Model, InputJSON: string(encoded)}
	submission := &model.Model3DSubmission{TaskID: task.ID, UserID: userID, RequestID: req.RequestID, RequestHash: hash, ConfigID: record.ID, State: "prepared"}
	s.storageMu.Lock()
	admitted, err := s.repo.AdmitModel3D(task, submission, revision, versions, func(repo *repository.Repository) error {
		return createTaskWithStorageQuotaRepository(repo, task, nil, policy)
	})
	s.storageMu.Unlock()
	if err != nil {
		return nil, model3DError(err)
	}
	s.wakeTaskDispatcher()
	return s.Model3DTask(userID, admitted.ID)
}

func (s *Service) completeModel3DRigCheck(task *model.Task, result Model3DResult) error {
	encoded, err := json.Marshal(result)
	if err != nil {
		return err
	}
	now := time.Now()
	completed := *task
	completed.Status, completed.Stage, completed.Progress = model.TaskStatusSucceeded, "绑骨检查已完成", 100
	completed.ResultJSON, completed.Error, completed.CompletedAt = string(encoded), "", &now
	completed.LeaseExpiresAt, completed.NextPollAt = nil, nil
	if err := s.repo.SaveTaskCompletionWithRegistration(&completed, model.TaskStatusRunning, nil, func(repo *repository.Repository) error {
		return repo.CompleteModel3DSubmission(task.ID)
	}); err != nil {
		return err
	}
	*task = completed
	return nil
}
