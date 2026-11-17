package repository

import (
	"encoding/json"
	"time"

	"yingce/backend/internal/model"
)

// RetryDramaProjectText runs under the production lock and only reopens current text slots.
func (r *Repository) RetryDramaProjectText(p *model.DramaProduction) (int, error) {
	var jobs []model.DramaJob
	if err := r.db.Where("project_id = ? AND kind IN ?", p.ProjectID, []string{model.DramaJobBible, model.DramaJobPlan}).
		Order("created_at desc, id desc").Find(&jobs).Error; err != nil {
		return 0, err
	}
	seen := map[string]bool{}
	var retryIDs []string
	for _, job := range jobs {
		var payload struct {
			Scope string `json:"scope"`
			Start int    `json:"start"`
		}
		if job.PayloadJSON != "" && json.Unmarshal([]byte(job.PayloadJSON), &payload) != nil {
			seen[job.Kind] = true
			continue
		}
		if payload.Scope != "" {
			continue
		}
		key := job.Kind
		if seen[key] {
			continue
		}
		seen[key] = true
		if job.Status != model.DramaJobFailed {
			continue
		}
		if job.Kind == model.DramaJobBible {
			if payload.Scope == "" && p.Stage != model.DramaStageBible {
				continue
			}
		} else if p.PlanDone || payload.Start != p.PlanCursor || p.Stage == model.DramaStageBible || p.GuideStep == model.DramaGuideAssets {
			continue
		}
		retryIDs = append(retryIDs, job.ID)
	}
	if len(retryIDs) > 0 {
		// Recover an already paid, usable result before allowing another model call.
		if err := r.retryDramaResultJobs(p.ProjectID, retryIDs); err != nil {
			return 0, err
		}
		if err := r.db.Model(&model.DramaJob{}).Where("id IN ? AND status = ?", retryIDs, model.DramaJobFailed).
			Updates(map[string]any{"status": model.DramaJobQueued, "task_id": "", "error": "", "finished_at": nil, "started_at": nil, "updated_at": time.Now()}).Error; err != nil {
			return 0, err
		}
	}
	count := len(retryIDs)
	if p.GuideStep == model.DramaGuideAssets {
		return count, nil
	}
	episodes, err := r.DramaEpisodes(p.ProjectID)
	if err != nil {
		return 0, err
	}
	for _, episode := range episodes {
		retried, err := r.RetryDramaEpisodeText(p.ProjectID, episode.ID)
		if err != nil {
			return 0, err
		}
		count += retried
		if retried > 0 {
			if applied, err := r.UpdateDramaEpisodeIfRevision(episode.ID, episode.Revision, map[string]any{"video_requests_only": true}); err != nil {
				return 0, err
			} else if !applied {
				return 0, ErrDramaGuideChanged
			}
		}
	}
	return count, nil
}
