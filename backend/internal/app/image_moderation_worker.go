package app

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"time"

	"yingce/backend/internal/model"
	"yingce/backend/internal/moderation"
	"yingce/backend/internal/repository"
)

const imageModerationLease = 5 * time.Minute

func (s *Service) startImageModerationWorker(ctx context.Context) {
	s.runWorkerLoop(func(ctx context.Context) {
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		for {
			if ctx.Err() != nil || s.IsDraining() {
				return
			}
			check, err := s.repo.ClaimImageModerationCheck(s.workerID, imageModerationLease)
			if err != nil {
				slog.Warn("image moderation claim failed")
			} else if check != nil {
				done := make(chan struct{})
				if !s.runWorkerTask(func() { defer close(done); s.processImageModerationCheck(ctx, check) }) {
					return
				}
				select {
				case <-done:
					continue
				case <-ctx.Done():
					return
				}
			}
			select {
			case <-ticker.C:
			case <-ctx.Done():
				return
			}
		}
	})
}

func (s *Service) failImageModerationPendingItems(check *model.ImageModerationCheck, code string) {
	items, err := s.repo.ImageModerationItems(check.ID)
	if err != nil {
		return
	}
	for _, item := range items {
		if item.Status != "queued" {
			continue
		}
		item.Status = "failed"
		item.ErrorCode = code
		if err := s.repo.CompleteImageModerationItem(check.ID, s.workerID, &item); err != nil {
			return
		}
	}
}

func (s *Service) processImageModerationCheck(ctx context.Context, check *model.ImageModerationCheck) {
	configRecord, err := s.repo.ImageModerationConfig(check.ConfigID)
	if err != nil {
		s.failImageModerationPendingItems(check, "configuration_unavailable")
		s.finishImageModerationCheck(check)
		return
	}
	config, err := s.imageModerationDomainConfig(configRecord)
	if err != nil {
		s.failImageModerationPendingItems(check, "credentials_unavailable")
		s.finishImageModerationCheck(check)
		return
	}
	provider, err := s.moderationProvider(config.Type)
	if err != nil || provider.Validate(config) != nil {
		s.failImageModerationPendingItems(check, "configuration_invalid")
		s.finishImageModerationCheck(check)
		return
	}
	resource, image, contentVersion, err := s.readImageModerationImage(check.UserID, check.ResourceID)
	if err != nil {
		s.failImageModerationPendingItems(check, "resource_unavailable")
		s.finishImageModerationCheck(check)
		return
	}
	if contentVersion != check.ContentVersion || imageModerationResourceVersion(resource) != check.ResourceVersion {
		s.failImageModerationPendingItems(check, "resource_changed")
		s.finishImageModerationCheck(check)
		return
	}
	items, err := s.repo.ImageModerationItems(check.ID)
	if err != nil {
		return
	}
	for _, item := range items {
		if item.Status != "queued" {
			continue
		}
		if ctx.Err() != nil {
			s.failImageModerationPendingItems(check, "execution_cancelled")
			break
		}
		if err := s.repo.BeginImageModerationItem(check.ID, item.ID, s.workerID, config.MaxCallsPerDay, imageModerationLease); err != nil {
			if errors.Is(err, repository.ErrImageModerationBudget) {
				s.failImageModerationPendingItems(check, "daily_budget_exhausted")
				break
			}
			return
		}
		callCtx, cancel := context.WithTimeout(ctx, time.Duration(config.TimeoutSeconds)*time.Second)
		result, callErr := provider.Detect(callCtx, config, image, item.Service)
		cancel()
		item.Status = "completed"
		item.RiskLevel = result.RiskLevel
		item.RequestID = result.RequestID
		if callErr != nil {
			item.Status = "failed"
			item.RiskLevel = "unknown"
			item.ErrorCode = "provider_request_failed"
			item.RequestID = ""
			item.RiskTagsJSON = "[]"
		} else {
			tags, _ := json.Marshal(result.RiskTags)
			item.RiskTagsJSON = string(tags)
		}
		if err := s.repo.CompleteImageModerationItem(check.ID, s.workerID, &item); err != nil {
			return
		}
	}
	s.finishImageModerationCheck(check)
}

func (s *Service) finishImageModerationCheck(check *model.ImageModerationCheck) {
	items, err := s.repo.ImageModerationItems(check.ID)
	if err != nil {
		return
	}
	results := make([]moderation.ItemResult, 0, len(items))
	for _, item := range items {
		result := moderation.ItemResult{Service: item.Service, Result: moderation.Result{RiskLevel: item.RiskLevel, RequestID: item.RequestID, RiskTags: []moderation.RiskTag{}}}
		if item.Status != "completed" {
			result.Err = errors.New("检测项目未完成")
		} else if err := json.Unmarshal([]byte(item.RiskTagsJSON), &result.Result.RiskTags); err != nil {
			result.Err = errors.New("检测结果不可解析")
		}
		results = append(results, result)
	}
	summary := moderation.Aggregate(results)
	budgetExhausted := false
	for _, item := range items {
		if item.ErrorCode == "daily_budget_exhausted" {
			budgetExhausted = true
		}
	}
	if budgetExhausted {
		if summary.Status == "failed" {
			summary.Message = "今日图片检测调用额度已用完，请联系管理员或明天重试"
		} else if summary.Status == "partial" {
			summary.Message += "；今日调用额度不足"
		}
	}
	tags, _ := json.Marshal(summary.RiskTags)
	if err := s.repo.CompleteImageModerationCheck(check.ID, s.workerID, summary.Status, summary.RiskLevel, string(tags), summary.Message); err != nil {
		slog.Warn("image moderation completion failed")
	}
}
