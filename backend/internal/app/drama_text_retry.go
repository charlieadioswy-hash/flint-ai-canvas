package app

import (
	"yingce/backend/internal/model"
	"yingce/backend/internal/repository"
)

// RetryDramaProjectText recovers failed writing without retrying image, video, or render slots.
func (s *Service) RetryDramaProjectText(userID, projectID string) (map[string]any, error) {
	if _, _, err := s.dramaForUser(userID, projectID); err != nil {
		return nil, err
	}
	release, err := s.lockDramaSchedule(projectID)
	if err != nil {
		return nil, err
	}
	defer release()
	var p *model.DramaProduction
	count := 0
	err = dramaGuideError(s.repo.Transaction(func(tx *repository.Repository) error {
		var err error
		p, err = tx.DramaProductionForUpdate(projectID)
		if err != nil {
			return err
		}
		if p.GuideStep == model.DramaGuideConfiguring {
			return BadAuthRequest("请先确认制作方案，再重试文字任务")
		}
		count, err = tx.RetryDramaProjectText(p)
		if err != nil || count == 0 {
			return err
		}
		if err := tx.RestrictDramaImplicitMedia(projectID); err != nil {
			return err
		}
		p.MediaRequestsOnly = true
		if dramaGuideActive(p) {
			return tx.UpdateDramaGuideIf(projectID, p.Revision, p.GuideStep, map[string]any{})
		}
		return nil
	}))
	if err != nil {
		return nil, err
	}
	if count > 0 {
		err = s.requestDramaWork(p)
	}
	return map[string]any{"jobs": count}, err
}
