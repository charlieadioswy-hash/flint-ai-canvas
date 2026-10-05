package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"time"

	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/model3d"
	"infinite-canvas/backend/internal/repository"
)

func (s *Service) model3DProvider() model3d.Provider {
	if s.model3DProviderFactory != nil {
		return s.model3DProviderFactory()
	}
	return model3d.NewProvider()
}

func model3DCallContext(ctx context.Context, config model3d.Config) (context.Context, context.CancelFunc) {
	return context.WithTimeout(ctx, time.Duration(config.TimeoutSeconds)*time.Second)
}

func (w *taskWorkerCoordinator) processModel3DTask(task *model.Task, ctx context.Context) error {
	s := w.service
	submission, err := s.repo.Model3DSubmission(task.ID)
	if err != nil {
		return err
	}
	fail := func(code, message, state string) error {
		return s.repo.FailModel3DTask(task.ID, task.LeaseOwner, code, message, state)
	}
	// Once the dispatch fence is durable, a lost response never permits another paid POST.
	if task.ProviderRequestID == "" && (submission.State == "inflight" || submission.State == "unknown") {
		return fail("submission_uncertain", "上游提交结果未确认，请管理员核查；系统不会再次创建付费任务", "unknown")
	}
	var input model3DInput
	if json.Unmarshal([]byte(task.InputJSON), &input) != nil || input.ConfigID != submission.ConfigID {
		return fail("model_input_invalid", "3D 任务快照无效", "rejected")
	}
	stored, err := s.repo.Model3DConfig(submission.ConfigID)
	if err != nil {
		return fail("model_config_invalid", "3D 服务配置快照不可用", "")
	}
	config, err := s.model3DDomainConfig(stored)
	if err != nil || model3d.ValidateConfig(config) != nil {
		return fail("model_config_invalid", "3D 服务配置快照不可用", "")
	}
	provider := s.model3DProvider()
	if task.ProviderRequestID != "" && submission.State == "storing" && task.ResultJSON != "" {
		var saved Model3DResult
		if json.Unmarshal([]byte(task.ResultJSON), &saved) == nil && saved.ResourceID != "" {
			resource, resourceErr := s.repo.ResourceForUser(task.UserID, saved.ResourceID)
			if resourceErr == nil && resource.Status == model.ResourceStatusReady && resource.Kind == "model" {
				if err := s.completeModel3DTask(task, input, saved); err != nil {
					return fail("model_storage_failed", "模型素材登记失败，可恢复原任务", "storing")
				}
				return nil
			}
		}
	}
	if task.ProviderRequestID == "" {
		if submission.State != "prepared" && submission.State != "uploading" {
			return fail("model_submission_invalid", "3D 提交状态无效", "rejected")
		}
		request := model3d.Request{Mode: input.Mode, Prompt: input.Prompt, Parameters: input.Parameters}
		for _, ref := range input.ReferenceImages {
			resource, image, hash, readErr := s.readModel3DImage(task.UserID, ref.ResourceID, ref.View)
			if readErr != nil || model.ImageModerationResourceVersion(resource) != ref.ResourceVersion || hash != ref.ContentHash {
				return fail("model_source_changed", "输入图片已变化或不可用，请重新发起任务", "rejected")
			}
			request.Images = append(request.Images, image)
		}
		tokens := map[string]string{}
		if submission.TokensEncrypted != "" {
			plain, decryptErr := s.decryptSettingSecret(submission.TokensEncrypted)
			if decryptErr != nil || json.Unmarshal([]byte(plain), &tokens) != nil {
				return fail("model_upload_invalid", "图片上传凭证不可用", "rejected")
			}
		}
		for _, image := range request.Images {
			if tokens[image.View] != "" {
				continue
			}
			if err := s.repo.UpdateTaskProgressForLease(task.ID, task.LeaseOwner, "上传 3D 参考图片", 0); err != nil {
				return err
			}
			call, cancel := model3DCallContext(ctx, config)
			token, uploadErr := provider.Upload(call, config, image)
			cancel()
			if uploadErr != nil {
				return fail("model_upload_failed", "参考图片上传失败，尚未创建生成任务", "rejected")
			}
			tokens[image.View] = token
			plain, _ := json.Marshal(tokens)
			encrypted, encryptErr := s.encryptSettingSecret(string(plain))
			if encryptErr != nil {
				return fail("model_upload_invalid", "图片上传凭证保存失败，尚未创建生成任务", "rejected")
			}
			if err := s.repo.SaveModel3DTokens(task.ID, task.LeaseOwner, encrypted); err != nil {
				return err
			}
		}
		if err := s.repo.BeginModel3DSubmission(task.ID, task.LeaseOwner, config.MaxTasksPerDay); err != nil {
			if errors.Is(err, repository.ErrModel3DBudget) {
				return fail("model_daily_limit", "3D 平台每日任务上限已达到，尚未提交", "rejected")
			}
			return err
		}
		call, cancel := model3DCallContext(ctx, config)
		upstream, submitErr := provider.Submit(call, config, request, tokens)
		cancel()
		if submitErr != nil {
			var providerErr *model3d.Error
			if errors.As(submitErr, &providerErr) && providerErr.Definite {
				return fail("model_submit_rejected", providerErr.Message, "rejected")
			}
			return fail("submission_uncertain", "上游提交结果未确认，请管理员核查；系统不会再次创建付费任务", "unknown")
		}
		if err := s.repo.AcceptModel3DSubmission(task.ID, task.LeaseOwner, upstream); err != nil {
			return err
		}
		task.ProviderRequestID = upstream
		task.PollStage = "model3d_generating"
	}
	call, cancel := model3DCallContext(ctx, config)
	state, pollErr := provider.Poll(call, config, task.ProviderRequestID, input.Parameters.Quad != nil && *input.Parameters.Quad)
	cancel()
	if pollErr != nil {
		if time.Since(task.CreatedAt) < 2*time.Hour {
			return s.repo.DeferRunningTaskForProviderPoll(task.ID, task.LeaseOwner, "等待 3D 平台状态", 15*time.Second)
		}
		return fail("model_poll_failed", "原 3D 任务状态查询失败，可继续查询原任务", "accepted")
	}
	if state.Status == "queued" || state.Status == "running" {
		if time.Since(task.CreatedAt) > 2*time.Hour {
			return fail("model_poll_timeout", "原 3D 任务仍未结束，请稍后继续查询原任务", "accepted")
		}
		if err := s.repo.UpdateTaskProgressForLease(task.ID, task.LeaseOwner, "3D 模型生成中", state.Progress); err != nil {
			return err
		}
		return s.repo.DeferRunningTaskForProviderPoll(task.ID, task.LeaseOwner, "3D 模型生成中", 15*time.Second)
	}
	if state.Status != "success" {
		message := "3D 平台任务已结束（" + state.Status + "）"
		if state.ErrorCode != "" {
			message += "，错误码：" + state.ErrorCode
		}
		return fail("model_upstream_"+state.Status, message, "finished")
	}
	plain, _ := json.Marshal(state.Artifact)
	encrypted, err := s.encryptSettingSecret(string(plain))
	if err != nil {
		return fail("model_storage_failed", "模型交付信息保存失败，可恢复原任务", "storing")
	}
	if err := s.repo.SaveModel3DDelivery(task.ID, task.LeaseOwner, encrypted); err != nil {
		return err
	}
	if err := s.repo.UpdateTaskProgressForLease(task.ID, task.LeaseOwner, "保存 3D 模型文件", 100); err != nil {
		return err
	}
	call, cancel = model3DCallContext(ctx, config)
	data, err := provider.Download(call, state.Artifact)
	cancel()
	if err != nil {
		return fail("model_download_failed", "模型文件下载失败或格式无效，可恢复原任务", "storing")
	}
	if err := model3d.ValidateFile(data, state.Artifact.Format); err != nil {
		return fail("model_output_invalid", "模型文件格式或外部依赖无效，可恢复原任务", "storing")
	}
	fileName, _ := model3d.FileType(state.Artifact.Format)
	resource, err := s.UploadResourceFile(task.UserID, fileName, int64(len(data)), "model", 0, 0, 0, bytes.NewReader(data), "model3d:"+task.ID+":"+state.Artifact.Format)
	if err != nil {
		return fail("model_storage_failed", "模型文件保存失败，可恢复原任务", "storing")
	}
	result := Model3DResult{AssetID: "model3d_" + task.ID, ResourceID: resource.ID, StorageKey: "resource:" + resource.ID, URL: resourceFileURL(resource.ID), FileName: fileName, MimeType: resource.MimeType, Bytes: resource.Size, Format: state.Artifact.Format}
	checkpoint, _ := json.Marshal(result)
	if err := s.saveModel3DResourceCheckpoint(task, checkpoint); err != nil {
		return fail("model_storage_failed", "模型保存检查点失败，可恢复原任务", "storing")
	}
	if err := s.completeModel3DTask(task, input, result); err != nil {
		return fail("model_storage_failed", "模型素材登记失败，可恢复原任务", "storing")
	}
	return nil
}

func (s *Service) saveModel3DResourceCheckpoint(task *model.Task, resultJSON []byte) error {
	policy, err := s.RuntimePolicy()
	if err != nil {
		return err
	}
	s.storageMu.Lock()
	defer s.storageMu.Unlock()
	usage, err := s.repo.UserStorageUsage(task.UserID)
	if err != nil {
		return err
	}
	if err := validateTaskDataGrowthQuotaWithPolicy(usage, int64(len(resultJSON)-len(task.ResultJSON)), policy.Resource); err != nil {
		return err
	}
	if err := s.repo.SaveModel3DResourceCheckpoint(task.ID, task.LeaseOwner, string(resultJSON)); err != nil {
		return err
	}
	task.ResultJSON = string(resultJSON)
	return nil
}

func (s *Service) completeModel3DTask(task *model.Task, input model3DInput, result Model3DResult) error {
	encoded, err := json.Marshal(result)
	if err != nil {
		return err
	}
	now := time.Now()
	payload, _ := json.Marshal(map[string]any{"id": result.AssetID, "kind": "model", "category": "material", "status": "confirmed", "title": "3D 生成模型", "tags": []string{"3D", "Tripo3D"}, "createdAt": now.UnixMilli(), "updatedAt": now.UnixMilli(), "data": map[string]any{"url": result.URL, "storageKey": result.StorageKey, "bytes": result.Bytes, "mimeType": result.MimeType, "fileName": result.FileName}, "metadata": map[string]any{"source": "model3d", "taskId": task.ID, "canvasId": input.ClientContext.CanvasID, "nodeId": input.ClientContext.NodeID}})
	asset := model.Asset{ID: result.AssetID, UserID: task.UserID, Kind: "model", Category: "material", Status: "confirmed", Title: "3D 生成模型", PayloadJSON: string(payload), CreatedAt: now, UpdatedAt: now}
	policy, err := s.RuntimePolicy()
	if err != nil {
		return err
	}
	s.storageMu.Lock()
	defer s.storageMu.Unlock()
	usage, err := s.repo.UserStorageUsage(task.UserID)
	if err != nil {
		return err
	}
	if err := validateTaskDataGrowthQuotaWithPolicy(usage, int64(len(encoded)-len(task.ResultJSON)), policy.Resource); err != nil {
		return err
	}
	if err := validateStructuredStorageQuotaWithPolicy(usage, "asset", true, int64(len(payload)), policy.Resource); err != nil {
		return err
	}
	completed := *task
	completed.Status, completed.Stage, completed.Progress = model.TaskStatusSucceeded, "3D 模型已保存", 100
	completed.ResultJSON, completed.Error, completed.CompletedAt = string(encoded), "", &now
	completed.LeaseOwner, completed.LeaseExpiresAt, completed.NextPollAt = "", nil, nil
	// Keep the original owner for the write fence; the persisted terminal row clears it separately.
	completed.LeaseOwner = task.LeaseOwner
	if err := s.repo.SaveTaskCompletionWithRegistration(&completed, model.TaskStatusRunning, nil, func(repo *repository.Repository) error {
		if err := repo.UpsertAsset(&asset); err != nil {
			return err
		}
		return repo.CompleteModel3DSubmission(task.ID)
	}); err != nil {
		return err
	}
	*task = completed
	return nil
}
