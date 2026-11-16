package app

import (
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"yingce/backend/internal/model"
	"yingce/backend/internal/production"
	"yingce/backend/internal/repository"

	"gorm.io/gorm"
)

type DramaWorkflowEpisodeReadiness struct {
	EpisodeID            string `json:"episodeId"`
	Number               int    `json:"number"`
	Title                string `json:"title"`
	Revision             int64  `json:"revision"`
	TextReady            bool   `json:"textReady"`
	CanGenerateVideo     bool   `json:"canGenerateVideo"`
	CanRender            bool   `json:"canRender"`
	BlockingReason       string `json:"blockingReason,omitempty"`
	SegmentCount         int    `json:"segmentCount"`
	ReadyVideos          int    `json:"readyVideos"`
	RenderSource         string `json:"renderSource"`
	RenderVideoCount     int    `json:"renderVideoCount"`
	RenderReadyVideos    int    `json:"renderReadyVideos"`
	RenderBlockingReason string `json:"renderBlockingReason,omitempty"`
}

type DramaWorkflowReadiness struct {
	Revision  int64                           `json:"revision"`
	GuideStep string                          `json:"guideStep"`
	Episodes  []DramaWorkflowEpisodeReadiness `json:"episodes"`
}

type UpdateDramaWorkflowStyleRequest struct {
	ExpectedRevision *int64                     `json:"expectedRevision"`
	StyleName        string                     `json:"styleName"`
	StylePrompt      string                     `json:"stylePrompt"`
	Drawing          *DramaDrawingConfiguration `json:"drawing,omitempty"`
}

// Readiness is derived from saved results; viewing another step never advances the workflow.
func (s *Service) DramaWorkflowReadiness(userID, projectID string) (DramaWorkflowReadiness, error) {
	if _, _, err := s.dramaForUser(userID, projectID); err != nil {
		return DramaWorkflowReadiness{}, err
	}
	view := DramaWorkflowReadiness{Episodes: []DramaWorkflowEpisodeReadiness{}}
	err := s.repo.Transaction(func(tx *repository.Repository) error {
		p, err := tx.DramaProductionForUpdate(projectID)
		if err != nil {
			return err
		}
		view.Revision, view.GuideStep = p.Revision, p.GuideStep
		episodes, err := tx.DramaEpisodes(projectID)
		if err != nil {
			return err
		}
		for _, episode := range episodes {
			ready, err := dramaWorkflowEpisodeReadiness(tx, p, &episode)
			if err != nil {
				return err
			}
			view.Episodes = append(view.Episodes, ready)
		}
		return nil
	})
	return view, dramaGuideError(err)
}

func dramaWorkflowEpisodeReadiness(repo *repository.Repository, p *model.DramaProduction, episode *model.DramaEpisode) (DramaWorkflowEpisodeReadiness, error) {
	view := DramaWorkflowEpisodeReadiness{EpisodeID: episode.ID, Number: episode.Number, Title: episode.Title, Revision: episode.Revision}
	segments, err := repo.DramaSegments(episode.ID)
	if err != nil {
		return view, err
	}
	shots, err := repo.DramaShots(episode.ID)
	if err != nil {
		return view, err
	}
	view.SegmentCount = len(segments)
	for _, segment := range segments {
		if segment.VideoStatus == model.DramaMediaReady && segment.VideoResourceID != "" && segment.VideoSeconds > 0 {
			view.ReadyVideos++
		}
	}
	view.BlockingReason = dramaWorkflowTextReason(p, episode, segments, shots)
	jobs, err := repo.DramaJobsByStatus(p.ProjectID, model.DramaJobQueued, model.DramaJobRunning)
	if err != nil {
		return view, err
	}
	mediaActive := false
	for _, job := range jobs {
		if job.Kind == model.DramaJobBible || job.Kind == model.DramaJobPlan || job.EpisodeID == episode.ID && (job.Kind == model.DramaJobScript || job.Kind == model.DramaJobSegmentPrompt) {
			view.BlockingReason = "本集相关文字任务正在进行，请完成后再确认生成"
		}
		if job.EpisodeID == episode.ID && (job.Kind == model.DramaJobSegmentVideo || job.Kind == model.DramaJobRender) {
			mediaActive = true
		}
	}
	current, err := repo.DramaEpisode(p.ProjectID, episode.ID)
	if err != nil {
		return view, err
	}
	if current.Revision != episode.Revision {
		return view, repository.ErrDramaGuideChanged
	}
	view.TextReady = view.BlockingReason == ""
	view.CanGenerateVideo = view.TextReady
	settings := dramaEpisodeSettings(parseDramaSettings(p.SettingsJSON), *episode)
	videos, videoErr := dramaEpisodeVideoTimeline(repo, p.UserID, p.ProjectID, episode.ID, settings.AspectRatio)
	view.RenderSource, view.RenderVideoCount, view.RenderReadyVideos = videos.Source, videos.Total, videos.Ready
	if videoErr != nil {
		view.RenderBlockingReason = videoErr.Error()
	}
	view.CanRender = view.TextReady && videos.Total > 0 && videoErr == nil && !mediaActive
	return view, nil
}

func dramaWorkflowTextReason(p *model.DramaProduction, episode *model.DramaEpisode, segments []model.DramaSegment, shots []model.DramaShot) string {
	if dramaGuideActive(p) && p.GuideStep != model.DramaGuideStory {
		return "请先确认资产文字设定，再推进分集制作"
	}
	if episode.Stage == model.DramaEpisodeQueued || episode.Stage == model.DramaEpisodeScript || len(shots) == 0 || episode.ShotCount != len(shots) {
		return "本集剧本与分镜尚未就绪"
	}
	if len(segments) == 0 {
		return "本集尚无剧情段提示词"
	}
	indexes := make(map[int]bool, len(segments))
	for _, segment := range segments {
		if segment.SegmentIndex < 0 || indexes[segment.SegmentIndex] {
			return "本集剧情段编号异常，请重新生成分镜"
		}
		if !dramaPromptReady(segment) {
			return fmt.Sprintf("本集第 %d 段视频提示词尚未就绪，请完成撰写或重试", segment.SegmentIndex+1)
		}
		indexes[segment.SegmentIndex] = true
	}
	covered := make(map[int]bool, len(segments))
	for _, shot := range shots {
		if !indexes[shot.SegmentIndex] {
			return fmt.Sprintf("本集第 %d 段尚无对应提示词", shot.SegmentIndex+1)
		}
		covered[shot.SegmentIndex] = true
	}
	for _, segment := range segments {
		if !covered[segment.SegmentIndex] {
			return fmt.Sprintf("本集第 %d 段尚无对应镜头", segment.SegmentIndex+1)
		}
	}
	return ""
}

// Only explicit media requests may cross the story-stage barrier, after this episode's text is ready.
func dramaGuideAllowsScopedJob(repo *repository.Repository, p *model.DramaProduction, job model.DramaJob) (bool, error) {
	if dramaGuideAllowsJob(p, job.Kind) {
		return true, nil
	}
	if p.GuideStep != model.DramaGuideStory || !p.MediaRequestsOnly || (job.Kind != model.DramaJobSegmentVideo && job.Kind != model.DramaJobRender) {
		return false, nil
	}
	episode, err := repo.DramaEpisode(p.ProjectID, job.EpisodeID)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return false, nil
	}
	if err != nil || !episode.VideoRequestsOnly {
		return false, err
	}
	view, err := dramaWorkflowEpisodeReadiness(repo, p, episode)
	if err != nil || !view.TextReady {
		return false, err
	}
	if job.Kind == model.DramaJobRender {
		// The queued render itself makes CanRender false; validate its selected video source independently.
		return episode.Stage == model.DramaEpisodeRender && view.RenderVideoCount > 0 &&
			view.RenderReadyVideos == view.RenderVideoCount && view.RenderBlockingReason == "", nil
	}
	segment, err := repo.DramaSegment(p.ProjectID, job.ShotID)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return segment.EpisodeID == episode.ID && mediaBusyStatus(segment.VideoStatus), nil
}

func (s *Service) UpdateDramaWorkflowStyle(userID, projectID string, req UpdateDramaWorkflowStyleRequest) (DramaSummary, error) {
	_, current, err := s.dramaForUser(userID, projectID)
	if err != nil {
		return DramaSummary{}, err
	}
	name, prompt := strings.TrimSpace(req.StyleName), strings.TrimSpace(req.StylePrompt)
	if req.ExpectedRevision == nil || *req.ExpectedRevision < 0 || name == "" || utf8.RuneCountInString(name) > 60 || prompt == "" || utf8.RuneCountInString(prompt) > production.MaxStylePromptRunes {
		return DramaSummary{}, BadAuthRequest(fmt.Sprintf("请提交当前版本、1 到 60 字的风格名称和不超过 %d 字的风格说明", production.MaxStylePromptRunes))
	}
	drawing, err := s.validateDramaDrawingConfiguration(userID, parseDramaSettings(current.SettingsJSON), req.Drawing)
	if err != nil {
		return DramaSummary{}, err
	}
	// 与调度共用租约，避免已完成引导的旧 tick 在保存后按旧默认风格派发文字任务。
	release, err := s.lockDramaSchedule(projectID)
	if err != nil {
		return DramaSummary{}, err
	}
	defer release()
	err = s.repo.Transaction(func(tx *repository.Repository) error {
		p, err := tx.DramaProductionForUpdate(projectID)
		if err != nil {
			return err
		}
		if p.Revision != *req.ExpectedRevision {
			return repository.ErrDramaGuideChanged
		}
		active, err := tx.DramaTextJobsActive(projectID)
		if err != nil {
			return err
		}
		if active {
			return dramaGuideConflict("相关文字任务正在进行，请完成后再修改风格")
		}
		settings := applyDramaDrawingConfiguration(parseDramaSettings(p.SettingsJSON), drawing)
		settings.StyleName, settings.StylePrompt = name, prompt
		return tx.UpdateDramaGuideIf(projectID, p.Revision, p.GuideStep, map[string]any{"settings_json": encodeDramaSettings(settings)})
	})
	if err != nil {
		return DramaSummary{}, dramaGuideError(err)
	}
	return s.DramaSummary(userID, projectID)
}
