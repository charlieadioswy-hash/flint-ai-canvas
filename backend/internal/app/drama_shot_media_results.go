package app

import (
	"encoding/json"
	"errors"
	"log/slog"
	"strconv"
	"strings"

	"gorm.io/gorm"
	"yingce/backend/internal/model"
	"yingce/backend/internal/repository"
)

func (s *Service) DramaShotMedia(userID, projectID, shotID, kind string) (DramaShotMediaView, error) {
	shot, p, err := s.dramaShotMediaScope(userID, projectID, shotID, kind)
	if err != nil {
		return DramaShotMediaView{}, err
	}
	row, config, err := s.loadDramaShotMedia(s.repo, *shot, *p, kind)
	if err != nil {
		return DramaShotMediaView{}, err
	}
	takes, err := s.repo.DramaTakes(projectID, shotID, "shot_"+kind, 100)
	if err != nil {
		return DramaShotMediaView{}, err
	}
	views := make([]DramaShotMediaTakeView, 0, len(takes))
	for _, take := range takes {
		view := DramaShotMediaTakeView{DramaTake: take, Status: "ready"}
		if take.TaskID != "" {
			task, err := s.repo.TaskForUser(userID, take.TaskID)
			if err != nil {
				return DramaShotMediaView{}, err
			}
			view.Status, view.Error = string(task.Status), task.Error
			if task.Status == model.TaskStatusSucceeded && take.ResourceID == "" {
				if _, err := s.RegisterDramaShotMediaTaskOutput(*task); err != nil {
					return DramaShotMediaView{}, err
				}
				stored, err := s.repo.DramaShotMediaTake(projectID, shotID, kind, take.ID)
				if err != nil {
					return DramaShotMediaView{}, err
				}
				view.DramaTake = *stored
			}
			if view.ResourceID != "" && task.Status == model.TaskStatusSucceeded {
				view.Status = "ready"
			}
		}
		views = append(views, view)
	}
	if row.ID != "" {
		fresh, freshConfig, err := s.loadDramaShotMedia(s.repo, *shot, *p, kind)
		if err != nil {
			return DramaShotMediaView{}, err
		}
		row, config = fresh, freshConfig
	}
	result := DramaShotMediaView{DramaShotMedia: row, Config: config, Takes: views}
	for index := range result.Takes {
		take := &result.Takes[index]
		take.Current = take.ID == row.CurrentTakeID && take.ResourceID != "" && take.ResourceID == row.ResourceID
		if take.TaskID != "" && take.TaskID == row.TaskID {
			result.Status, result.Error = take.Status, take.Error
			if take.Status == "ready" && row.ResourceID != take.ResourceID {
				result.Status = "stale"
				if kind == "audio" {
					result.Status = "awaiting_adoption"
				}
			}
		}
	}
	if row.ScriptHash != "" && row.ScriptHash != dramaShotScriptHash(*shot) && result.ResourceID != "" {
		result.Status = "stale"
	}
	return result, nil
}

type DramaShotVideoSummary struct {
	ShotID          string `json:"shotId"`
	ResourceID      string `json:"resourceId,omitempty"`
	ImageResourceID string `json:"imageResourceId,omitempty"`
	Pending         bool   `json:"pending"`
}

func (s *Service) DramaShotVideoSummaries(userID, projectID, episodeID string, segmentIndex int) ([]DramaShotVideoSummary, error) {
	if segmentIndex < 0 {
		return nil, BadAuthRequest("剧情段序号无效")
	}
	project, _, err := s.dramaForUser(userID, projectID)
	if err != nil {
		return nil, err
	}
	episode, err := s.repo.DramaEpisode(project.ID, episodeID)
	if err != nil {
		return nil, dramaLookupError(err)
	}
	rows, err := s.repo.DramaSegmentShotMediaRows(userID, project.ID, episode.ID, segmentIndex)
	if err != nil {
		return nil, err
	}
	// Repair only successful, still-bound takes whose result was not written back.
	// Older takes remain the responsibility of the full history endpoint.
	var repaired bool
	for _, row := range rows {
		if row.RepairTaskID == "" {
			continue
		}
		task, err := s.repo.TaskForUser(userID, row.RepairTaskID)
		if err != nil {
			slog.Warn("drama shot summary task read failed", "project", project.ID, "shot", row.ShotID, "task", row.RepairTaskID, "error", err)
			continue
		}
		handled, err := s.RegisterDramaShotMediaTaskOutput(*task)
		if err != nil {
			slog.Warn("drama shot summary output backfill failed", "project", project.ID, "shot", row.ShotID, "task", row.RepairTaskID, "error", err)
			continue
		}
		repaired = repaired || handled
	}
	if repaired {
		rows, err = s.repo.DramaSegmentShotMediaRows(userID, project.ID, episode.ID, segmentIndex)
		if err != nil {
			return nil, err
		}
	}
	result := make([]DramaShotVideoSummary, 0, len(rows))
	for _, row := range rows {
		if len(result) == 0 || result[len(result)-1].ShotID != row.ShotID {
			result = append(result, DramaShotVideoSummary{ShotID: row.ShotID})
		}
		summary := &result[len(result)-1]
		switch row.Kind {
		case "video":
			summary.ResourceID = row.ResourceID
		case "image":
			summary.ImageResourceID = row.ResourceID
		}
		summary.Pending = summary.Pending || row.TaskStatus == model.TaskStatusQueued || row.TaskStatus == model.TaskStatusRunning
	}
	return result, nil
}

// The binding is the reserved take in our own domain. Caller-supplied generic
// task metadata alone can never assign or activate a DramaShot output.
func (s *Service) RegisterDramaShotMediaTaskOutput(task model.Task) (bool, error) {
	var input struct {
		Config struct {
			VideoSeconds string `json:"videoSeconds"`
		} `json:"config"`
		Metadata struct {
			Source          string `json:"source"`
			MediaID         string `json:"dramaShotMediaId"`
			MediaRevision   int64  `json:"dramaShotMediaRevision"`
			ScriptHash      string `json:"dramaShotScriptHash"`
			PromptHash      string `json:"dramaShotPromptHash"`
			CameraVersion   int    `json:"dramaShotCameraPromptVersion"`
			VisualDirection bool   `json:"dramaShotVisualDirection"`
		} `json:"metadata"`
	}
	if err := json.Unmarshal([]byte(task.InputJSON), &input); err != nil || input.Metadata.Source != "drama_shot_media" {
		return false, nil
	}
	if task.Status != model.TaskStatusSucceeded {
		return true, nil
	}
	take, err := s.repo.DramaShotMediaTakeForTask(task.ProjectID, task.ID)
	if err != nil {
		return true, err
	}
	if _, _, err := s.dramaForUser(task.UserID, task.ProjectID); err != nil {
		return true, err
	}
	kind := strings.TrimPrefix(take.Kind, "shot_")
	resourceID := dramaTaskResource(&task)
	if resourceID == "" {
		return true, errors.New("镜头任务结果缺少已保存资源")
	}
	resource, err := s.repo.ResourceForUser(task.UserID, resourceID)
	if err != nil || resource.Status != model.ResourceStatusReady || resource.Kind != kind || kind == "audio" && !isSupportedVoiceSampleMimeType(resource.MimeType) {
		return true, errors.New("镜头任务结果尚未就绪或媒体类型不匹配")
	}
	take.ResourceID, take.DurationMs = resource.ID, resource.DurationMs
	err = s.repo.Transaction(func(repo *repository.Repository) error {
		p, err := repo.DramaProductionForUpdate(task.ProjectID)
		if err != nil {
			return err
		}
		if err := repo.LockDramaCastImageReferences(task.UserID, []string{take.ResourceID}); err != nil {
			return err
		}
		resource, err := repo.ResourceForUser(task.UserID, take.ResourceID)
		if err != nil || resource.Status != model.ResourceStatusReady || resource.Kind != kind || kind == "audio" && !isSupportedVoiceSampleMimeType(resource.MimeType) {
			return errors.New("镜头任务结果尚未就绪或媒体类型不匹配")
		}
		row, err := repo.DramaShotMedia(task.ProjectID, take.OwnerID, kind)
		if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		if row == nil {
			row = &model.DramaShotMedia{}
		}
		shot, shotErr := repo.DramaShot(task.ProjectID, take.OwnerID)
		if shotErr != nil && !errors.Is(shotErr, gorm.ErrRecordNotFound) {
			return shotErr
		}
		activate := shot != nil && row.ID == input.Metadata.MediaID && row.Revision == input.Metadata.MediaRevision && dramaShotScriptHash(*shot) == input.Metadata.ScriptHash
		if activate && kind == "video" && input.Metadata.PromptHash != "" {
			switch version := input.Metadata.CameraVersion; version {
			case 0, dramaShotCameraPromptVersion:
				_, config, err := s.loadDramaShotMedia(repo, *shot, *p, kind)
				if err != nil {
					return err
				}
				// 回写时用提交任务的秒数核对提示词，模型档位变更不影响已生成结果。
				if seconds, err := strconv.Atoi(input.Config.VideoSeconds); err == nil && seconds > 0 && config.Seconds != seconds {
					config.Seconds = seconds
					config, err = s.enrichDramaShotMediaPrompt(repo, *shot, *p, kind, config)
					if err != nil {
						return err
					}
				}
				if !input.Metadata.VisualDirection {
					config.visualDirection = ""
				}
				currentInput, err := s.dramaShotMediaInputForCameraVersion(repo, task.UserID, *shot, kind, config, version)
				if err != nil {
					return err
				}
				activate = dramaShotMediaDigest(stringValue(currentInput["prompt"])) == input.Metadata.PromptHash
			default:
				activate = false
			}
		}
		if shot == nil {
			shot = &model.DramaShot{}
		}
		return repo.CompleteDramaShotMediaTask(take, row, input.Metadata.MediaRevision, shot.UpdatedAt, activate)
	})
	return true, err
}

func (s *Service) AdoptDramaShotMedia(userID, projectID, shotID, kind string, req DramaShotMediaAdoptRequest) (DramaShotMediaView, error) {
	_, _, err := s.dramaShotMediaScope(userID, projectID, shotID, kind)
	if err != nil {
		return DramaShotMediaView{}, err
	}
	if req.ExpectedRevision == nil || strings.TrimSpace(req.TakeID) == "" {
		return DramaShotMediaView{}, BadAuthRequest("请指定版本和当前镜头媒体修订号")
	}
	take, err := s.repo.DramaShotMediaTake(projectID, shotID, kind, req.TakeID)
	if err != nil {
		return DramaShotMediaView{}, err
	}
	resource, err := s.repo.ResourceForUser(userID, take.ResourceID)
	if err != nil || resource.Status != model.ResourceStatusReady || resource.Kind != kind || kind == "audio" && !isSupportedVoiceSampleMimeType(resource.MimeType) {
		return DramaShotMediaView{}, BadAuthRequest("只能采用已保存且类型相符的镜头产物")
	}
	err = s.repo.Transaction(func(repo *repository.Repository) error {
		if _, err := repo.DramaProductionForUpdate(projectID); err != nil {
			return err
		}
		shot, err := repo.DramaShot(projectID, shotID)
		if err != nil {
			return err
		}
		if err := repo.LockDramaCastImageReferences(userID, []string{take.ResourceID}); err != nil {
			return BadAuthRequest("镜头产物已变化，请重新载入")
		}
		resource, err := repo.ResourceForUser(userID, take.ResourceID)
		if err != nil || resource.Status != model.ResourceStatusReady || resource.Kind != kind || kind == "audio" && !isSupportedVoiceSampleMimeType(resource.MimeType) {
			return BadAuthRequest("只能采用已保存且类型相符的镜头产物")
		}
		row, err := repo.DramaShotMedia(projectID, shotID, kind)
		if err != nil {
			return err
		}
		row.ScriptHash = dramaShotScriptHash(*shot)
		return repo.AdoptDramaShotMediaTake(row, take, *req.ExpectedRevision)
	})
	if err != nil {
		return DramaShotMediaView{}, dramaShotMediaError(err)
	}
	return s.DramaShotMedia(userID, projectID, shotID, kind)
}

func taskHasDramaShotMediaOrigin(raw string) bool {
	var input struct {
		Metadata struct {
			Source string `json:"source"`
		} `json:"metadata"`
	}
	return json.Unmarshal([]byte(raw), &input) == nil && input.Metadata.Source == "drama_shot_media"
}
