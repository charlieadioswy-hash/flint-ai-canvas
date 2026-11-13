package app

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"yingce/backend/internal/model"
	"yingce/backend/internal/repository"
)

type DramaCastViewSaveRequest struct {
	ExpectedRevision     *int64              `json:"expectedRevision"`
	ExpectedCastRevision *int64              `json:"expectedCastRevision"`
	ViewRevision         *int64              `json:"viewRevision"`
	Config               DramaCastViewConfig `json:"config"`
}

type DramaCastViewActionRequest struct {
	ExpectedRevision  *int64 `json:"expectedRevision"`
	ViewRevision      *int64 `json:"viewRevision"`
	ConfirmationToken string `json:"confirmationToken,omitempty"`
	ClientOperationID string `json:"clientOperationId,omitempty"`
}

type DramaCastViewAdoptRequest struct {
	ExpectedRevision *int64 `json:"expectedRevision"`
	ViewRevision     *int64 `json:"viewRevision"`
	TakeID           string `json:"takeId"`
}

type DramaCastViewTake struct {
	model.DramaTake
	Status  string `json:"status"`
	Error   string `json:"error,omitempty"`
	Current bool   `json:"current"`
}

type DramaCastViewResult struct {
	model.DramaCastView
	Config DramaCastViewConfig `json:"config"`
	Takes  []DramaCastViewTake `json:"takes"`
	Error  string              `json:"error,omitempty"`
}

type DramaCastViewPreflight struct {
	Revision           int64  `json:"revision"`
	ViewRevision       int64  `json:"viewRevision"`
	Ready              bool   `json:"ready"`
	Reason             string `json:"reason,omitempty"`
	AmountMicrocredits int64  `json:"amountMicrocredits"`
	Priced             bool   `json:"priced"`
	Estimated          bool   `json:"estimated"`
	ConfirmationToken  string `json:"confirmationToken"`
}

type dramaCastViewPlan struct {
	view        DramaCastViewPreflight
	row         model.DramaCastView
	cast        model.DramaCast
	request     CreateTaskRequest
	resourceIDs []string
	sourceHash  string
}

func dramaCastViewDigest(value any) string {
	encoded, _ := json.Marshal(value)
	hash := sha256.Sum256(encoded)
	return hex.EncodeToString(hash[:])
}

func dramaCastViewSource(repo *repository.Repository, cast model.DramaCast) (string, error) {
	p, err := repo.DramaProduction(cast.ProjectID)
	if err != nil {
		return "", err
	}
	var parent *model.DramaCast
	if cast.ParentID != "" {
		parent, err = repo.DramaCast(cast.ProjectID, cast.ParentID)
		if err != nil {
			return "", err
		}
	}
	return dramaCastViewDigest([]any{cast.Revision, cast.Name, cast.Kind, cast.ParentID, cast.Appearance, cast.Description, cast.DefinitionJSON, cast.ImagePrompt, cast.ImageOptionsJSON, cast.ImageResourceID, cast.ImageStylePrompt, parent, p.SettingsJSON, p.BibleJSON}), nil
}

func dramaCastViewError(err error) error {
	if errors.Is(err, repository.ErrDramaCastViewChanged) {
		return dramaGuideConflict(err.Error())
	}
	return err
}

func (s *Service) dramaCastViewScope(userID, projectID, castID string) error {
	if _, _, err := s.dramaForUser(userID, projectID); err != nil {
		return err
	}
	_, err := s.repo.DramaCast(projectID, castID)
	return dramaLookupError(err)
}

func (s *Service) SaveDramaCastView(userID, projectID, castID, viewID string, req DramaCastViewSaveRequest) (DramaCastViewResult, error) {
	if err := s.dramaCastViewScope(userID, projectID, castID); err != nil {
		return DramaCastViewResult{}, err
	}
	if req.ExpectedRevision == nil || req.ExpectedCastRevision == nil || req.ViewRevision == nil {
		return DramaCastViewResult{}, BadAuthRequest("请提供作品、资产和视图版本")
	}
	config, err := normalizeDramaCastViewConfig(req.Config)
	if err != nil {
		return DramaCastViewResult{}, err
	}
	newView := viewID == ""
	if newView {
		viewID = newID()
	}
	err = s.withDramaTextEdit(projectID, req.ExpectedRevision, false, func(repo *repository.Repository) error {
		cast, err := repo.DramaCast(projectID, castID)
		if err != nil {
			return err
		}
		if cast.Revision != *req.ExpectedCastRevision {
			return repository.ErrDramaCastViewChanged
		}
		row := &model.DramaCastView{ID: viewID, ProjectID: projectID, CastID: castID, CreatedAt: time.Now()}
		if newView {
			if *req.ViewRevision != 0 {
				return repository.ErrDramaCastViewChanged
			}
			rows, err := repo.DramaCastViews(projectID, castID)
			if err != nil {
				return err
			}
			if len(rows) >= 24 {
				return BadAuthRequest("每项资产最多 24 个独立视图")
			}
		} else {
			row, err = repo.DramaCastView(projectID, castID, viewID)
			if err != nil {
				return err
			}
			if row.Revision != *req.ViewRevision {
				return repository.ErrDramaCastViewChanged
			}
			if err := s.requireDramaCastViewIdle(repo, userID, *row); err != nil {
				return err
			}
		}
		p, err := repo.DramaProduction(projectID)
		if err != nil {
			return err
		}
		compiled, err := dramaCastViewImageCast(*cast, config)
		if err != nil {
			return err
		}
		ids := append(append([]string{}, config.ImageOptions.SubjectReferenceIDs...), config.ImageOptions.StyleReferenceIDs...)
		if err := repo.LockDramaCastImageReferences(userID, ids); err != nil {
			return BadAuthRequest("参考图片不可用，请重新选择")
		}
		if _, err := s.dramaCastImagePlanFor(repo, userID, parseDramaSettings(p.SettingsJSON), compiled); err != nil {
			return err
		}
		encoded, _ := json.Marshal(config)
		row.ConfigJSON, row.Revision, row.Status, row.UpdatedAt = string(encoded), *req.ViewRevision+1, "idle", time.Now()
		if row.ResourceID != "" {
			row.Status = "stale"
		}
		return repo.SaveDramaCastView(row, *req.ViewRevision)
	})
	if err != nil {
		return DramaCastViewResult{}, dramaCastViewError(err)
	}
	return s.DramaCastView(userID, projectID, castID, viewID)
}

func (s *Service) requireDramaCastViewIdle(repo *repository.Repository, userID string, row model.DramaCastView) error {
	if row.TaskID == "" {
		return nil
	}
	task, err := repo.TaskForUser(userID, row.TaskID)
	if err != nil {
		return err
	}
	if task.Status != model.TaskStatusSucceeded && task.Status != model.TaskStatusFailed && task.Status != model.TaskStatusCancelled {
		return dramaGuideConflict("本视图正在排队或生成，请等待完成")
	}
	return nil
}

func (s *Service) DramaCastViews(userID, projectID, castID string) ([]DramaCastViewResult, error) {
	if err := s.dramaCastViewScope(userID, projectID, castID); err != nil {
		return nil, err
	}
	rows, err := s.repo.DramaCastViews(projectID, castID)
	if err != nil {
		return nil, err
	}
	results := make([]DramaCastViewResult, 0, len(rows))
	for _, row := range rows {
		view, err := s.DramaCastView(userID, projectID, castID, row.ID)
		if err != nil {
			return nil, err
		}
		results = append(results, view)
	}
	return results, nil
}

func (s *Service) DramaCastView(userID, projectID, castID, viewID string) (DramaCastViewResult, error) {
	if err := s.dramaCastViewScope(userID, projectID, castID); err != nil {
		return DramaCastViewResult{}, err
	}
	row, err := s.repo.DramaCastView(projectID, castID, viewID)
	if err != nil {
		return DramaCastViewResult{}, err
	}
	var config DramaCastViewConfig
	if err := json.Unmarshal([]byte(row.ConfigJSON), &config); err != nil {
		return DramaCastViewResult{}, BadAuthRequest("视图配置损坏，请重新配置")
	}
	takes, err := s.repo.DramaTakes(projectID, viewID, "cast_view", 100)
	if err != nil {
		return DramaCastViewResult{}, err
	}
	results := []DramaCastViewTake{}
	for _, take := range takes {
		result := DramaCastViewTake{DramaTake: take, Status: "ready"}
		if take.TaskID != "" {
			task, err := s.repo.TaskForUser(userID, take.TaskID)
			if err != nil {
				return DramaCastViewResult{}, err
			}
			result.Status, result.Error = string(task.Status), task.Error
			if task.Status == model.TaskStatusSucceeded && take.ResourceID == "" {
				if _, err := s.RegisterDramaCastViewTaskOutput(*task); err != nil {
					return DramaCastViewResult{}, err
				}
				stored, err := s.repo.DramaCastViewTake(projectID, viewID, take.ID)
				if err != nil {
					return DramaCastViewResult{}, err
				}
				result.DramaTake = *stored
			}
			if result.ResourceID != "" && task.Status == model.TaskStatusSucceeded {
				result.Status = "ready"
			}
		}
		results = append(results, result)
	}
	row, err = s.repo.DramaCastView(projectID, castID, viewID)
	if err != nil {
		return DramaCastViewResult{}, err
	}
	view := DramaCastViewResult{DramaCastView: *row, Config: config, Takes: results}
	for i := range view.Takes {
		take := &view.Takes[i]
		take.Current = take.ID == row.CurrentTakeID && take.ResourceID == row.ResourceID && row.ResourceID != ""
		if take.TaskID == row.TaskID && row.TaskID != "" {
			view.Status, view.Error = take.Status, take.Error
			if take.Status == "ready" && !take.Current {
				view.Status = "stale"
			}
		}
	}
	cast, err := s.repo.DramaCast(projectID, castID)
	if err != nil {
		return view, err
	}
	currentHash, err := dramaCastViewSource(s.repo, *cast)
	if err != nil {
		return view, err
	}
	if row.SourceHash != "" && row.SourceHash != currentHash && view.ResourceID != "" {
		view.Status = "stale"
	}
	return view, nil
}

func (s *Service) DeleteDramaCastView(userID, projectID, castID, viewID string, req DramaCastViewActionRequest) error {
	if err := s.dramaCastViewScope(userID, projectID, castID); err != nil {
		return err
	}
	if req.ExpectedRevision == nil || req.ViewRevision == nil {
		return BadAuthRequest("请提供作品和视图版本")
	}
	err := s.withDramaTextEdit(projectID, req.ExpectedRevision, false, func(repo *repository.Repository) error {
		row, err := repo.DramaCastView(projectID, castID, viewID)
		if err != nil {
			return err
		}
		if err := s.requireDramaCastViewIdle(repo, userID, *row); err != nil {
			return err
		}
		return repo.DeleteDramaCastView(row, *req.ViewRevision)
	})
	return dramaCastViewError(err)
}

func taskHasDramaCastViewOrigin(raw string) bool {
	var input struct {
		Metadata struct {
			Source string `json:"source"`
		} `json:"metadata"`
	}
	return json.Unmarshal([]byte(raw), &input) == nil && strings.EqualFold(input.Metadata.Source, "drama_cast_view")
}
