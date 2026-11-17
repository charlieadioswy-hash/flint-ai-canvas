package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"gorm.io/gorm"
	"yingce/backend/internal/model"
	"yingce/backend/internal/repository"
)

func (s *Service) ExecuteDramaCastAssistance(userID, projectID, castID string, req DramaCastAssistanceRequest) (*model.Task, error) {
	if _, err := s.dramaCastAssistanceScope(userID, projectID, castID); err != nil {
		return nil, err
	}
	if req.ConfirmationToken == "" || req.ClientOperationID == "" {
		return nil, BadAuthRequest("请先预检并确认辅助任务报价")
	}
	submission, err := newTaskSubmission(userID, req.ClientOperationID, "drama_cast_assistance", []any{projectID, castID, req})
	if err != nil {
		return nil, err
	}
	if task, err := s.replayDramaCastAssistance(userID, projectID, castID, submission); task != nil || err != nil {
		return task, err
	}
	plan, err := s.prepareDramaCastAssistance(s.repo, userID, projectID, castID, req)
	if err != nil {
		return nil, dramaGuideError(err)
	}
	if !plan.view.Ready || plan.view.ConfirmationToken != req.ConfirmationToken {
		return nil, dramaGuideConflict("资产、辅助要求或报价已变化，请重新预检")
	}
	metadata := plan.request.Input["metadata"].(map[string]any)
	metadata["requestHash"] = submission.Hash
	prepare := &creationTaskPreparation{}
	plan.request.creationPrepare = prepare
	plan.request.admission = &taskAdmission{ID: submission.ID, MaxCharge: plan.view.AmountMicrocredits}
	task, err := s.CreateTask(userID, plan.request)
	if err != nil {
		return nil, err
	}
	var taskInput map[string]any
	if err := json.Unmarshal([]byte(task.InputJSON), &taskInput); err != nil {
		return nil, err
	}
	if err := s.protectTaskSecrets(taskInput); err != nil {
		return nil, err
	}
	encoded, err := json.Marshal(taskInput)
	if err != nil {
		return nil, err
	}
	task.InputJSON = string(encoded)
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
		if req.SourceResourceID != "" {
			if err := repo.LockDramaCastImageReferences(userID, []string{req.SourceResourceID}); err != nil {
				return BadAuthRequest("反推来源图片已变化，请重新预检")
			}
		}
		fresh, err := s.prepareDramaCastAssistance(repo, userID, projectID, castID, req)
		if err != nil {
			return err
		}
		if !fresh.view.Ready || fresh.view.ConfirmationToken != req.ConfirmationToken {
			return repository.ErrDramaGuideChanged
		}
		if err := createTaskWithStorageQuotaRepository(repo, task, prepare.Order, policy); err != nil {
			return err
		}
		return repo.CreateDramaTake(&model.DramaTake{ID: newID(), ProjectID: projectID, OwnerID: castID, Kind: dramaCastAssistanceKind(req.Purpose), TaskID: task.ID, Prompt: task.Prompt, CreatedAt: time.Now()})
	})
	s.storageMu.Unlock()
	if err != nil {
		if replay, replayErr := s.replayDramaCastAssistance(userID, projectID, castID, submission); replay != nil || replayErr != nil {
			return replay, replayErr
		}
		if errors.Is(err, repository.ErrActiveTaskLimit) {
			return nil, BadAuthRequest(fmt.Sprintf("同时排队或运行的任务最多 %d 个，请等待已有任务完成", policy.Task.ActiveTaskLimit))
		}
		if errors.Is(err, repository.ErrInsufficientCredits) {
			return nil, BadAuthRequest("积分不足，请先充值")
		}
		return nil, dramaGuideError(err)
	}
	s.recordActivity(userID, "task", 1)
	_ = s.log(userID, task.ID, "info", "资产辅助任务已入队，结果需审阅后采用", "")
	s.wakeTaskDispatcher()
	return taskForOutput(*task), nil
}

func dramaCastAssistanceTaskMetadata(task *model.Task) (dramaCastAssistanceMetadata, error) {
	var input struct {
		Metadata dramaCastAssistanceMetadata `json:"metadata"`
	}
	err := json.Unmarshal([]byte(task.InputJSON), &input)
	if err == nil && (input.Metadata.Source != "drama_cast_assistance" || dramaCastAssistanceKind(input.Metadata.Purpose) == "") {
		err = BadAuthRequest("任务不是有效的资产辅助结果")
	}
	return input.Metadata, err
}

func (s *Service) replayDramaCastAssistance(userID, projectID, castID string, submission *taskSubmission) (*model.Task, error) {
	task, err := s.repo.TaskForUser(userID, submission.ID)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	metadata, err := dramaCastAssistanceTaskMetadata(task)
	if err != nil || metadata.RequestHash != submission.Hash || metadata.CastID != castID || task.ProjectID != projectID {
		return nil, dramaGuideConflict("同一提交标识的辅助任务内容不同，请重新提交")
	}
	takes, err := s.repo.DramaTakes(projectID, castID, dramaCastAssistanceKind(metadata.Purpose), 100)
	if err != nil {
		return nil, err
	}
	for _, take := range takes {
		if take.TaskID == task.ID {
			return taskForOutput(*task), nil
		}
	}
	return nil, dramaGuideConflict("辅助任务缺少资产来源绑定")
}

func (s *Service) DramaCastAssistance(userID, projectID, castID string) ([]DramaCastAssistanceResult, error) {
	cast, err := s.dramaCastAssistanceScope(userID, projectID, castID)
	if err != nil {
		return nil, err
	}
	results := []DramaCastAssistanceResult{}
	for _, purpose := range []string{"fill_description", "image_prompt", "voice_sample"} {
		takes, err := s.repo.DramaTakes(projectID, castID, dramaCastAssistanceKind(purpose), 20)
		if err != nil {
			return nil, err
		}
		for _, take := range takes {
			task, err := s.repo.TaskForUser(userID, take.TaskID)
			if err != nil {
				return nil, err
			}
			metadata, err := dramaCastAssistanceTaskMetadata(task)
			if err != nil || metadata.CastID != castID || metadata.Purpose != purpose || task.ProjectID != projectID {
				return nil, BadAuthRequest("辅助任务来源与资产不一致")
			}
			result := DramaCastAssistanceResult{ID: take.ID, TaskID: task.ID, Purpose: purpose, Version: take.Version, Status: task.Status, Progress: task.Progress, Error: task.Error, SourceRevision: metadata.SourceRevision, Stale: cast.Revision != metadata.SourceRevision, CreatedAt: take.CreatedAt.Format(time.RFC3339)}
			if task.Status == model.TaskStatusSucceeded {
				if purpose == "voice_sample" {
					resourceID := dramaTaskResource(task)
					resource, err := s.repo.ResourceForUser(userID, resourceID)
					if err == nil && resource.Kind == "audio" && resource.Status == model.ResourceStatusReady && strings.HasPrefix(resource.MimeType, "audio/") {
						result.ResourceID = resource.ID
					} else {
						result.Error = "声音任务未返回可用音频资源"
					}
				} else {
					result.Text, err = dramaTaskText(task)
					if err != nil {
						result.Error = err.Error()
					}
				}
			}
			results = append(results, result)
		}
	}
	return results, nil
}

type DramaCastAssistanceAdoptRequest struct {
	ExpectedRevision *int64 `json:"expectedRevision"`
	CastRevision     *int64 `json:"castRevision"`
	TakeID           string `json:"takeId"`
	Text             string `json:"text,omitempty"`
}

func (s *Service) AdoptDramaCastAssistance(userID, projectID, castID string, req DramaCastAssistanceAdoptRequest) (DramaSummary, error) {
	if _, err := s.dramaCastAssistanceScope(userID, projectID, castID); err != nil {
		return DramaSummary{}, err
	}
	if req.ExpectedRevision == nil || req.CastRevision == nil || req.TakeID == "" {
		return DramaSummary{}, BadAuthRequest("请提供作品、资产当前版本和要采用的结果")
	}
	req.Text = strings.TrimSpace(req.Text)
	err := s.withDramaTextEdit(projectID, req.ExpectedRevision, false, func(repo *repository.Repository) error {
		cast, err := repo.DramaCast(projectID, castID)
		if err != nil {
			return err
		}
		if cast.Revision != *req.CastRevision {
			return repository.ErrDramaGuideChanged
		}
		take, err := repo.DramaCastAssistanceTake(projectID, castID, req.TakeID)
		if err != nil {
			return err
		}
		task, err := repo.TaskForUser(userID, take.TaskID)
		if err != nil {
			return err
		}
		metadata, err := dramaCastAssistanceTaskMetadata(task)
		if err != nil || metadata.CastID != castID || dramaCastAssistanceKind(metadata.Purpose) != take.Kind || task.ProjectID != projectID || task.Status != model.TaskStatusSucceeded {
			return BadAuthRequest("只能采用本资产已成功的辅助结果")
		}
		if metadata.SourceRevision != cast.Revision {
			return dramaGuideConflict("资产已修改，此结果保留在历史中，请按新设定重新生成")
		}
		fields := map[string]any{}
		if metadata.Purpose == "voice_sample" {
			if cast.Kind != "character" || cast.ParentID != "" {
				return BadAuthRequest("声音只能绑定到角色本体")
			}
			resourceID := dramaTaskResource(task)
			if err := repo.LockDramaCastImageReferences(userID, []string{resourceID}); err != nil {
				return BadAuthRequest("声音样本已不可用")
			}
			resource, err := repo.ResourceForUser(userID, resourceID)
			if err != nil || resource.Kind != "audio" || resource.Status != model.ResourceStatusReady || !strings.HasPrefix(resource.MimeType, "audio/") {
				return BadAuthRequest("声音样本不存在、未就绪或不属于当前账号")
			}
			profile, err := repo.VoiceProfileBySampleResource(userID, resourceID)
			if errors.Is(err, gorm.ErrRecordNotFound) {
				now := time.Now()
				profile = &model.VoiceProfile{ID: newID(), UserID: userID, Name: cast.Name + " · 声音", Provider: "user_upload", VoiceKey: "sample:" + resourceID, SampleResourceID: resourceID, Status: "active", CompatibleModelsJSON: "[]", CreatedAt: now, UpdatedAt: now}
				err = repo.CreateVoiceProfile(profile)
			}
			if err != nil {
				return err
			}
			return repo.UpdateDramaCastVoice(projectID, castID, profile.ID, resourceID)
		} else {
			if _, err := dramaTaskText(task); err != nil || req.Text == "" {
				return BadAuthRequest("请审阅并填写要采用的文字")
			}
			field, definitionKey := "appearance", "appearance"
			limit := 1000
			if metadata.Purpose == "image_prompt" {
				field, definitionKey = "image_prompt", "imagePrompt"
				limit = 12000
			}
			if utf8.RuneCountInString(req.Text) > limit {
				return BadAuthRequest(fmt.Sprintf("采用的文字不超过 %d 字", limit))
			}
			fields[field] = req.Text
			if cast.ImageStatus != "" && ((field == "appearance" && req.Text != cast.Appearance) || (field == "image_prompt" && req.Text != cast.ImagePrompt)) {
				fields["image_status"] = model.DramaMediaStale
			}
			// 原始说明与未知结构化字段原样保留，只显式更新用户审阅的目标字段。
			definition, err := parseDramaCharacterDefinition(cast.DefinitionJSON)
			if err != nil {
				return err
			}
			definition[definitionKey] = req.Text
			encoded, err := dramaCharacterDefinitionJSON(definition)
			if err != nil {
				return err
			}
			fields["definition_json"] = encoded
		}
		return repo.UpdateDramaCastFields(castID, fields)
	})
	if err != nil {
		return DramaSummary{}, err
	}
	return s.DramaSummary(userID, projectID)
}
