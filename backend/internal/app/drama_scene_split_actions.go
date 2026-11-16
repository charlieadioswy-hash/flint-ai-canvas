package app

import (
	"encoding/json"
	"errors"
	"strings"
	"time"

	"gorm.io/gorm"
	"yingce/backend/internal/model"
	"yingce/backend/internal/production"
	"yingce/backend/internal/repository"
)

func dramaSceneTaskMetadata(task *model.Task) (dramaSceneSplitMetadata, error) {
	var input struct {
		Metadata dramaSceneSplitMetadata `json:"metadata"`
	}
	err := json.Unmarshal([]byte(task.InputJSON), &input)
	if err == nil && (input.Metadata.Source != "drama_scene_split" || len(input.Metadata.ShotIDs) == 0 || input.Metadata.EpisodeID == "" || input.Metadata.SourceHash == "") {
		err = BadAuthRequest("不是有效的段分镜重拆任务")
	}
	return input.Metadata, err
}

func (s *Service) replayDramaSceneSplit(userID, projectID, episodeID string, submission *taskSubmission) (*model.Task, error) {
	task, err := s.repo.TaskForUser(userID, submission.ID)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	meta, err := dramaSceneTaskMetadata(task)
	if err != nil || task.ProjectID != projectID || meta.EpisodeID != episodeID || meta.RequestHash != submission.Hash {
		return nil, dramaGuideConflict("同一提交标识的重拆内容不同")
	}
	takes, err := s.repo.DramaTakes(projectID, meta.ShotIDs[0], "scene_split", 100)
	if err != nil {
		return nil, err
	}
	for _, take := range takes {
		if take.TaskID == task.ID {
			return taskForOutput(*task), nil
		}
	}
	return nil, dramaGuideConflict("重拆任务缺少真实段来源绑定")
}

func (s *Service) ExecuteDramaSceneSplit(userID, projectID, episodeID string, req DramaSceneSplitRequest) (*model.Task, error) {
	if _, _, err := s.dramaForUser(userID, projectID); err != nil {
		return nil, err
	}
	if req.ConfirmationToken == "" || req.ClientOperationID == "" {
		return nil, BadAuthRequest("请先预检并确认重拆报价")
	}
	submission, err := newTaskSubmission(userID, req.ClientOperationID, "drama_scene_split", []any{projectID, episodeID, req})
	if err != nil {
		return nil, err
	}
	if task, err := s.replayDramaSceneSplit(userID, projectID, episodeID, submission); task != nil || err != nil {
		return task, err
	}
	plan, err := s.prepareDramaSceneSplit(s.repo, userID, projectID, episodeID, req)
	if err != nil {
		return nil, dramaGuideError(err)
	}
	if !plan.view.Ready || plan.view.ConfirmationToken != req.ConfirmationToken {
		return nil, dramaGuideConflict("本段镜头、要求或报价已变化，请重新预检")
	}
	plan.metadata.RequestHash = submission.Hash
	plan.request.Input["metadata"] = plan.metadata
	prepare := &creationTaskPreparation{}
	plan.request.creationPrepare, plan.request.admission = prepare, &taskAdmission{ID: submission.ID, MaxCharge: plan.view.AmountMicrocredits}
	task, err := s.CreateTask(userID, plan.request)
	if err != nil {
		return nil, err
	}
	var input map[string]any
	if err := json.Unmarshal([]byte(task.InputJSON), &input); err != nil {
		return nil, err
	}
	if err := s.protectTaskSecrets(input); err != nil {
		return nil, err
	}
	encoded, err := json.Marshal(input)
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
		fresh, err := s.prepareDramaSceneSplit(repo, userID, projectID, episodeID, req)
		if err != nil {
			return err
		}
		if !fresh.view.Ready || fresh.view.ConfirmationToken != req.ConfirmationToken {
			return repository.ErrDramaGuideChanged
		}
		if err := createTaskWithStorageQuotaRepository(repo, task, prepare.Order, policy); err != nil {
			return err
		}
		return repo.CreateDramaTake(&model.DramaTake{ID: newID(), ProjectID: projectID, OwnerID: plan.metadata.ShotIDs[0], Kind: "scene_split", TaskID: task.ID, Prompt: task.Prompt, CreatedAt: time.Now()})
	})
	s.storageMu.Unlock()
	if err != nil {
		if task, replayErr := s.replayDramaSceneSplit(userID, projectID, episodeID, submission); task != nil || replayErr != nil {
			return task, replayErr
		}
		return nil, dramaGuideError(err)
	}
	s.wakeTaskDispatcher()
	return taskForOutput(*task), nil
}

type DramaSceneSplitResult struct {
	TakeID   string                    `json:"takeId"`
	TaskID   string                    `json:"taskId"`
	ShotIDs  []string                  `json:"shotIds"`
	Status   model.TaskStatus          `json:"status"`
	Progress int                       `json:"progress"`
	Text     string                    `json:"text,omitempty"`
	Error    string                    `json:"error,omitempty"`
	Stale    bool                      `json:"stale"`
	Applied  bool                      `json:"applied"`
	Snapshot *model.DramaSceneRevision `json:"snapshot,omitempty"`
}

func (s *Service) DramaSceneSplits(userID, projectID, episodeID string) ([]DramaSceneSplitResult, error) {
	_, p, err := s.dramaForUser(userID, projectID)
	if err != nil {
		return nil, err
	}
	episode, err := s.repo.DramaEpisode(projectID, episodeID)
	if err != nil {
		return nil, err
	}
	shots, err := s.repo.DramaShots(episodeID)
	if err != nil {
		return nil, err
	}
	segments, err := s.repo.DramaSegments(episodeID)
	if err != nil {
		return nil, err
	}
	takes, err := s.repo.DramaSceneSplitTakes(projectID, episodeID)
	if err != nil {
		return nil, err
	}
	result := []DramaSceneSplitResult{}
	for _, take := range takes {
		task, err := s.repo.TaskForUser(userID, take.TaskID)
		if err != nil {
			return nil, err
		}
		meta, err := dramaSceneTaskMetadata(task)
		if err != nil || meta.EpisodeID != episodeID || take.OwnerID != meta.ShotIDs[0] || task.ProjectID != projectID {
			return nil, BadAuthRequest("重拆任务来源不一致")
		}
		_, scopeErr := dramaSceneRange(shots, meta.ShotIDs)
		row := DramaSceneSplitResult{TakeID: take.ID, TaskID: task.ID, ShotIDs: meta.ShotIDs, Status: task.Status, Progress: task.Progress, Error: task.Error, Stale: scopeErr != nil || meta.SourceHash != dramaSceneSourceHash(*p, *episode, shots, segments)}
		if task.Status == model.TaskStatusSucceeded {
			row.Text, err = dramaTaskText(task)
			if err != nil {
				row.Error = err.Error()
			}
		}
		snapshot, err := s.repo.DramaSceneRevision(projectID, task.ID)
		if err == nil {
			row.Applied, row.Snapshot = true, snapshot
		} else if !errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, err
		}
		result = append(result, row)
	}
	return result, nil
}

type DramaSceneSplitAdoptRequest struct {
	ExpectedRevision *int64 `json:"expectedRevision"`
	EpisodeRevision  *int64 `json:"episodeRevision"`
	TakeID           string `json:"takeId"`
}

func dramaSceneDialogue(shots []model.DramaShot) string {
	var b strings.Builder
	last := ""
	for _, shot := range shots {
		if shot.Dialogue != "" {
			if shot.Speaker != last {
				b.WriteString("\x00" + shot.Speaker + "\x00")
				last = shot.Speaker
			}
			b.WriteString(strings.TrimSpace(shot.Dialogue))
		}
	}
	return b.String()
}

func (s *Service) AdoptDramaSceneSplit(userID, projectID, episodeID string, req DramaSceneSplitAdoptRequest) (DramaSummary, error) {
	if _, _, err := s.dramaForUser(userID, projectID); err != nil {
		return DramaSummary{}, err
	}
	if req.ExpectedRevision == nil || req.EpisodeRevision == nil || req.TakeID == "" {
		return DramaSummary{}, BadAuthRequest("请刷新当前版本并选择重拆结果")
	}
	release, err := s.lockDramaSchedule(projectID)
	if err != nil {
		return DramaSummary{}, err
	}
	defer release()
	err = s.withDramaTextEdit(projectID, req.ExpectedRevision, false, func(repo *repository.Repository) error {
		p, err := repo.DramaProduction(projectID)
		if err != nil {
			return err
		}
		episode, err := repo.DramaEpisode(projectID, episodeID)
		if err != nil {
			return err
		}
		if episode.Revision != *req.EpisodeRevision {
			return repository.ErrDramaGuideChanged
		}
		takes, err := repo.DramaSceneSplitTakes(projectID, episodeID)
		if err != nil {
			return err
		}
		var selected *model.DramaTake
		for i := range takes {
			if takes[i].ID == req.TakeID {
				selected = &takes[i]
			}
		}
		if selected == nil {
			return BadAuthRequest("重拆结果不属于本集")
		}
		task, err := repo.TaskForUser(userID, selected.TaskID)
		if err != nil {
			return err
		}
		meta, err := dramaSceneTaskMetadata(task)
		if err != nil || meta.EpisodeID != episodeID || selected.OwnerID != meta.ShotIDs[0] || task.ProjectID != projectID || task.Status != model.TaskStatusSucceeded {
			return BadAuthRequest("只能采用本段已成功的重拆结果")
		}
		if _, err := repo.DramaSceneRevision(projectID, task.ID); err == nil {
			return dramaGuideConflict("该结果已采用，请刷新当前分镜")
		} else if !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		active, err := repo.DramaSceneSplitActive(projectID, episodeID)
		if err != nil {
			return err
		}
		if active {
			return dramaGuideConflict("有文字或媒体任务正在进行，请完成后再采用")
		}
		all, err := repo.DramaShots(episodeID)
		if err != nil {
			return err
		}
		segments, err := repo.DramaSegments(episodeID)
		if err != nil {
			return err
		}
		if meta.SourceHash != dramaSceneSourceHash(*p, *episode, all, segments) {
			return dramaGuideConflict("原分镜、配置或段状态已变化，旧结果保留在历史中，请重新重拆")
		}
		before, err := dramaSceneRange(all, meta.ShotIDs)
		if err != nil {
			return err
		}
		text, err := dramaTaskText(task)
		if err != nil {
			return err
		}
		scripted, err := production.ParseScript(text)
		if err != nil {
			return BadAuthRequest("重拆结果无法解析：" + err.Error())
		}
		if len(scripted) != meta.TargetShotCount {
			return BadAuthRequest("重拆结果镜头数与确认目标不一致，请重新生成")
		}
		cast, err := repo.DramaCasts(projectID)
		if err != nil {
			return err
		}
		settings := dramaEpisodeSettings(parseDramaSettings(p.SettingsJSON), *episode)
		after, affected, err := s.buildDramaSceneReplacement(settings, all, before, scripted, cast, segments)
		if err != nil {
			return err
		}
		return repo.ReplaceDramaScene(*episode, before, after, affected, model.DramaSceneRevision{ID: newID(), ProjectID: projectID, EpisodeID: episodeID, TaskID: task.ID, TakeID: selected.ID, CreatedAt: time.Now()})
	})
	if err != nil {
		return DramaSummary{}, dramaLookupError(err)
	}
	return s.DramaSummary(userID, projectID)
}
