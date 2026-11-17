package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"yingce/backend/internal/model"
	"yingce/backend/internal/production"
	"yingce/backend/internal/repository"

	"gorm.io/gorm"
)

// EnsureDramaEpisodeStoryboard only starts missing work; revisiting an episode never replaces its results.
func (s *Service) EnsureDramaEpisodeStoryboard(userID, projectID, episodeID string) (DramaEpisodeDetail, error) {
	_, _, err := s.dramaForUser(userID, projectID)
	if err != nil {
		return DramaEpisodeDetail{}, err
	}
	release, err := s.lockDramaSchedule(projectID)
	if err != nil {
		return DramaEpisodeDetail{}, err
	}
	defer release()
	snapshot, err := s.repo.DramaProduction(projectID)
	if err != nil {
		return DramaEpisodeDetail{}, err
	}
	var resumeFields map[string]any
	var resumeErr error
	if snapshot.Status == model.DramaStatusPaused || snapshot.Status == model.DramaStatusCompleted {
		settings := parseDramaSettings(snapshot.SettingsJSON)
		models, modelErr := s.resolveDramaModels(snapshot.UserID, settings)
		resumeErr = modelErr
		if resumeErr == nil && len(missingDramaCapabilities(models)) > 0 {
			resumeErr = BadAuthRequest("还没有可用的" + strings.Join(missingDramaCapabilities(models), "、") + "模型")
		}
		if resumeErr == nil {
			var exhausted bool
			exhausted, resumeErr = s.dramaBudgetExhausted(snapshot)
			if resumeErr == nil && exhausted {
				resumeErr = BadAuthRequest("已达到预算上限（含画布精修花费），请先提高预算")
			}
		}
		settings.Models = models
		resumeFields = map[string]any{"status": model.DramaStatusRunning, "pause_reason": "", "settings_json": encodeDramaSettings(settings), "draft_json": ""}
		if snapshot.Status == model.DramaStatusCompleted {
			resumeFields["stage"] = model.DramaStageProduce
		}
	}
	var p *model.DramaProduction
	started := false
	err = s.repo.Transaction(func(tx *repository.Repository) error {
		p, err = tx.DramaProductionForUpdate(projectID)
		if err != nil {
			return err
		}
		if dramaGuideActive(p) && p.GuideStep != model.DramaGuideStory {
			return BadAuthRequest("请先确认资产文字设定，再生成本集分镜")
		}
		started, err = s.ensureDramaEpisodeStoryboard(tx, p, episodeID)
		if err != nil || !started {
			return err
		}
		if p.Revision != snapshot.Revision || p.Status != snapshot.Status || p.SettingsJSON != snapshot.SettingsJSON || p.GuideStep != snapshot.GuideStep || p.BudgetMicrocredits != snapshot.BudgetMicrocredits {
			return repository.ErrDramaGuideChanged
		}
		// Resume checks run outside the transaction for single-connection databases. Failure rolls back the episode intent too.
		if resumeErr != nil {
			return resumeErr
		}
		if err := deferUnstartedDramaStoryboards(tx, p, episodeID); err != nil {
			return err
		}
		if resumeFields == nil {
			resumeFields = map[string]any{}
		}
		return tx.UpdateDramaGuideIf(projectID, p.Revision, p.GuideStep, resumeFields)
	})
	if err != nil {
		return DramaEpisodeDetail{}, dramaGuideError(err)
	}
	if started {
		s.wakeDramaScheduler()
	}
	return s.DramaEpisodeDetail(userID, projectID, episodeID)
}

// The caller holds the production row lock. The episode CAS also rejects an older scheduler snapshot.
func (s *Service) ensureDramaEpisodeStoryboard(tx *repository.Repository, p *model.DramaProduction, episodeID string) (bool, error) {
	episode, err := tx.DramaEpisode(p.ProjectID, episodeID)
	if err != nil {
		return false, err
	}
	shots, err := tx.DramaShots(episode.ID)
	if err != nil {
		return false, err
	}
	segments, err := tx.DramaSegments(episode.ID)
	if err != nil {
		return false, err
	}
	if len(shots) > 0 || len(segments) > 0 {
		return false, nil
	}
	if episode.Error != "" {
		return false, dramaGuideConflict("本集分镜生成失败，请点击重试本集文字")
	}
	jobs, err := tx.DramaJobsByStatus(p.ProjectID, model.DramaJobQueued, model.DramaJobRunning)
	if err != nil {
		return false, err
	}
	for _, job := range jobs {
		if job.Kind == model.DramaJobScript && job.EpisodeID == episode.ID {
			return false, nil
		}
	}
	job, err := tx.LatestDramaJob(p.ProjectID, model.DramaJobScript, episode.ID)
	if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
		return false, err
	}
	if err == nil && job.Status == model.DramaJobFailed {
		var payload dramaRevisionPayload
		if json.Unmarshal([]byte(job.PayloadJSON), &payload) != nil || payload.Revision == episode.Revision {
			return false, dramaGuideConflict("本集分镜生成失败，请点击重试本集文字")
		}
	}
	if episode.Stage == model.DramaEpisodeQueued || episode.Stage == model.DramaEpisodeScript {
		return false, nil
	}
	if episode.Stage != model.DramaEpisodeDraft && episode.Stage != model.DramaEpisodeDone {
		return false, dramaGuideConflict("本集制作状态已变化，请刷新后重试")
	}
	if err := validateDramaEpisodeStoryboardSource(tx, p.ProjectID, episode); err != nil {
		return false, err
	}
	applied, err := tx.UpdateDramaEpisodeIfRevision(episode.ID, episode.Revision, map[string]any{
		"stage": model.DramaEpisodeScript, "approved": false, "revision": episode.Revision + 1,
	})
	if err == nil && !applied {
		err = repository.ErrDramaGuideChanged
	}
	return applied, err
}

func (s *Service) startDramaGuideStoryboard(tx *repository.Repository, p *model.DramaProduction, episodeID string) error {
	episodes, err := tx.DramaEpisodes(p.ProjectID)
	if err != nil {
		return err
	}
	episodeID = strings.TrimSpace(episodeID)
	if len(episodes) == 0 {
		if episodeID != "" {
			return NotFound("剧集不存在或不属于当前短剧")
		}
		// Smart planning has no episode to select yet; the page ensures its selection after planning.
		return nil
	}
	if episodeID == "" {
		episodeID = episodes[0].ID
	}
	selected, err := tx.DramaEpisode(p.ProjectID, episodeID)
	if err != nil {
		return err
	}
	if err := validateDramaEpisodeStoryboardSource(tx, p.ProjectID, selected); err != nil {
		return err
	}
	if err := deferUnstartedDramaStoryboards(tx, p, selected.ID); err != nil {
		return err
	}
	return resetDramaEpisodeStoryboard(tx, selected)
}

// Legacy guided catalogs queued every episode before the user chose one. In automatic productions,
// queued episodes are already scheduled for the whole work, even before script jobs exist.
func deferUnstartedDramaStoryboards(tx *repository.Repository, p *model.DramaProduction, selectedEpisodeID string) error {
	if p.GuideStep == "" {
		return nil
	}
	episodes, err := tx.DramaEpisodes(p.ProjectID)
	if err != nil {
		return err
	}
	jobs, err := tx.DramaJobsByStatus(p.ProjectID, model.DramaJobQueued, model.DramaJobRunning)
	if err != nil {
		return err
	}
	active := make(map[string]bool, len(jobs))
	for _, job := range jobs {
		if job.Kind == model.DramaJobScript {
			active[job.EpisodeID] = true
		}
	}
	for _, episode := range episodes {
		if episode.ID == selectedEpisodeID || episode.Stage != model.DramaEpisodeQueued || episode.ScriptRequested || active[episode.ID] {
			continue
		}
		shots, err := tx.DramaShots(episode.ID)
		if err != nil {
			return err
		}
		segments, err := tx.DramaSegments(episode.ID)
		if err != nil {
			return err
		}
		if len(shots) > 0 || len(segments) > 0 {
			continue
		}
		applied, err := tx.UpdateDramaEpisodeIfRevision(episode.ID, episode.Revision, map[string]any{
			"stage": model.DramaEpisodeDraft, "revision": episode.Revision + 1,
		})
		if err != nil {
			return err
		}
		if !applied {
			return repository.ErrDramaGuideChanged
		}
	}
	return nil
}

// Explicit arrangement replaces the selected episode; navigation keeps using the idempotent ensure path.
func resetDramaEpisodeStoryboard(tx *repository.Repository, episode *model.DramaEpisode) error {
	fields := map[string]any{"stage": model.DramaEpisodeScript, "shot_count": 0, "approved": false, "error": ""}
	if episode.FinalResourceID != "" {
		fields["final_stale"] = true
	}
	if err := tx.CancelQueuedDramaJobs(episode.ProjectID, func(db *gorm.DB) *gorm.DB { return db.Where("episode_id = ?", episode.ID) }); err != nil {
		return err
	}
	applied, err := tx.ApplyDramaScript(episode.ID, nil, fields, nil)
	if err == nil && !applied {
		err = repository.ErrDramaGuideChanged
	}
	return err
}

func validateDramaEpisodeStoryboardSource(tx *repository.Repository, projectID string, episode *model.DramaEpisode) error {
	chapters, err := tx.DramaChaptersByIDs(projectID, decodeStringList(episode.ChapterIDsJSON))
	if err != nil {
		return err
	}
	if len(chapters) == 0 {
		return BadAuthRequest("本集没有来源正文，请先补充原文")
	}
	sourceRunes := 0
	for _, chapter := range chapters {
		if chapter.WordCount > production.ScriptSourceChapterRunes {
			return BadAuthRequest(fmt.Sprintf("第 %d 章原文 %d 字，单章不超过 %d 字，请先拆分原文", chapter.Position+1, chapter.WordCount, production.ScriptSourceChapterRunes))
		}
		sourceRunes += chapter.WordCount
	}
	if sourceRunes > dramaEpisodeSourceRunes {
		return BadAuthRequest(fmt.Sprintf("本集原文合计 %d 字，每集原文不超过 %d 字，请先拆分原文", sourceRunes, dramaEpisodeSourceRunes))
	}
	return nil
}
