package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"yingce/backend/internal/model"
	"yingce/backend/internal/repository"

	"gorm.io/gorm"
)

// RenderDramaEpisode only assembles the adopted videos; it never releases missing media.
func (s *Service) RenderDramaEpisode(userID, projectID, episodeID string, req RenderDramaEpisodeRequest) (map[string]any, error) {
	episodeID = strings.TrimSpace(episodeID)
	if episodeID == "" || req.ExpectedRevision == nil || *req.ExpectedRevision < 0 {
		return nil, BadAuthRequest("请选择剧集并提交当前集版本")
	}
	project, _, err := s.dramaForUser(userID, projectID)
	if err != nil {
		return nil, err
	}
	// A scheduler tick must not overwrite the requested render stage using an older episode snapshot.
	release, err := s.lockDramaSchedule(projectID)
	if err != nil {
		return nil, err
	}
	defer release()
	var p *model.DramaProduction
	var renderJob *model.DramaJob
	var timeline renderProject
	count := 0
	err = dramaGuideError(s.repo.Transaction(func(tx *repository.Repository) error {
		var err error
		p, err = tx.DramaProductionForUpdate(projectID)
		if err != nil {
			return err
		}
		episode, err := tx.DramaEpisode(projectID, episodeID)
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return NewAppError(http.StatusNotFound, "剧集不存在或不属于当前短剧")
		}
		if err != nil {
			return err
		}
		if episode.Revision != *req.ExpectedRevision {
			return dramaGuideConflict("本集内容已改变，请刷新后重新合成")
		}
		if dramaGuideActive(p) {
			readiness, err := dramaWorkflowEpisodeReadiness(tx, p, episode)
			if err != nil {
				return err
			}
			if !readiness.TextReady {
				return BadAuthRequest(readiness.BlockingReason)
			}
		}
		active, err := tx.DramaJobsByStatus(projectID, model.DramaJobQueued, model.DramaJobRunning)
		if err != nil {
			return err
		}
		var queuedRender *model.DramaJob
		for _, job := range active {
			if job.EpisodeID != episodeID {
				continue
			}
			if job.Kind == model.DramaJobCompose {
				return dramaGuideConflict("本集还有手动合成任务进行中，请完成后再合成")
			}
			if job.Kind == model.DramaJobRender {
				var payload dramaRevisionPayload
				// 自动规划的作业可能尚未记录版本；本集已回退时，它同样不能阻塞新的合成。
				outdated := episode.Stage != model.DramaEpisodeRender
				if job.PayloadJSON != "" {
					outdated = outdated || json.Unmarshal([]byte(job.PayloadJSON), &payload) != nil || payload.Revision != episode.Revision
				}
				if outdated {
					if job.Status == model.DramaJobQueued && job.TaskID == "" {
						canceled, err := tx.CancelUnboundDramaRenderJob(projectID, job.ID)
						if err != nil {
							return err
						}
						if canceled {
							continue
						}
					}
					return dramaGuideConflict("上一版本的成片仍在合成，请完成后重试")
				}
				if job.Status == model.DramaJobRunning || job.TaskID != "" {
					return nil
				}
				queuedRender = &job
				continue
			}
			if job.Kind == model.DramaJobScript || job.Kind == model.DramaJobSegmentPrompt || job.Kind == model.DramaJobSegmentVideo {
				return dramaGuideConflict("本集还有文字或段视频任务进行中，请完成后再合成")
			}
		}
		settings := dramaEpisodeSettings(parseDramaSettings(p.SettingsJSON), *episode)
		videos, err := dramaEpisodeVideoTimeline(tx, userID, projectID, episodeID, settings.AspectRatio)
		if err != nil {
			return BadAuthRequest(err.Error())
		}
		timeline = videos.Timeline
		if queuedRender != nil {
			renderJob = queuedRender
			return nil
		}
		fields := map[string]any{"stage": model.DramaEpisodeRender, "error": "", "final_stale": episode.FinalResourceID != ""}
		if dramaGuideActive(p) {
			if err := tx.RestrictDramaImplicitMedia(projectID); err != nil {
				return err
			}
			p.MediaRequestsOnly = true
			fields["video_requests_only"] = true
		}
		changed, err := tx.UpdateDramaEpisodeIfRevision(episodeID, episode.Revision, fields)
		if err != nil {
			return err
		}
		if !changed {
			return repository.ErrDramaGuideChanged
		}
		now := time.Now()
		job := model.DramaJob{ID: newID(), ProjectID: projectID, EpisodeID: episodeID, Kind: model.DramaJobRender, Status: model.DramaJobQueued, Priority: episodePriority(dramaRankRender, episode.Number), Label: fmt.Sprintf("第 %d 集 合成成片", episode.Number), PayloadJSON: encodeDramaRevision(episode.Revision), CreatedAt: now, UpdatedAt: now}
		if err := tx.CreateDramaJobs([]model.DramaJob{job}); err != nil {
			return err
		}
		renderJob = &job
		count = 1
		return nil
	}))
	if err != nil {
		return nil, err
	}
	if renderJob != nil {
		// Local assembly does not resume the production, resolve models or spend generation budget.
		// The normal task worker executes it, and paused productions still apply running job results.
		renderJob.PayloadJSON = encodeDramaRevision(*req.ExpectedRevision)
		task, _, err := s.createDramaRenderTask(project, timeline, renderJob)
		if err != nil {
			run := &dramaRun{s: s, project: project, production: p}
			return nil, errors.Join(err, run.failJob(renderJob, err.Error()))
		}
		// Injected executors may return a persisted task without binding its orchestration job.
		if renderJob.Status != model.DramaJobRunning {
			renderJob.Status, renderJob.TaskID = model.DramaJobRunning, task.ID
			now := time.Now()
			renderJob.StartedAt = &now
			if err := s.repo.SaveDramaJob(renderJob); err != nil {
				return nil, err
			}
		}
		s.wakeDramaScheduler()
	}
	return map[string]any{"jobs": count}, nil
}
