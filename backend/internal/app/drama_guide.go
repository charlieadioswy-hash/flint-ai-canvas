package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"yingce/backend/internal/model"
	"yingce/backend/internal/production"
	"yingce/backend/internal/repository"
)

type DramaGuideView struct {
	Step           string `json:"step"`
	CanConfirm     bool   `json:"canConfirm"`
	BlockingReason string `json:"blockingReason,omitempty"`
}

type UpdateDramaGuideSourceRequest struct {
	ExpectedRevision int64               `json:"expectedRevision"`
	Chapters         []DramaChapterInput `json:"chapters"`
	SourceFormat     string              `json:"sourceFormat,omitempty"`
}

type ConfirmDramaGuideRequest struct {
	ExpectedStep     string         `json:"expectedStep"`
	ExpectedRevision int64          `json:"expectedRevision"`
	Settings         *DramaSettings `json:"settings,omitempty"`
}

func dramaGuideActive(p *model.DramaProduction) bool {
	return p.GuideStep != "" && p.GuideStep != model.DramaGuideCompleted
}

func dramaGuideAllowsJob(p *model.DramaProduction, kind string) bool {
	if !dramaGuideActive(p) {
		return true
	}
	switch p.GuideStep {
	case model.DramaGuideAssets:
		return kind == model.DramaJobBible || kind == model.DramaJobCastImage
	case model.DramaGuideStory:
		return kind == model.DramaJobPlan || kind == model.DramaJobScript || kind == model.DramaJobSegmentPrompt || kind == model.DramaJobCastImage
	default:
		return false
	}
}

func requireDramaGuideComplete(p *model.DramaProduction) error {
	if dramaGuideActive(p) {
		return BadAuthRequest("请先完成文字创作引导，再到制作台进行此操作")
	}
	return nil
}

func dramaGuideConflict(message string) error {
	return NewAppError(http.StatusConflict, message)
}

func dramaGuideError(err error) error {
	if errors.Is(err, repository.ErrDramaGuideChanged) {
		return dramaGuideConflict(err.Error())
	}
	return err
}

// withDramaGuideEdit shares the production revision across guided text edits only.
func (s *Service) withDramaGuideEdit(projectID string, expected *int64, rewindAssets bool, edit func(*repository.Repository) error) error {
	return s.withDramaRevisionEdit(projectID, expected, rewindAssets, false, edit)
}

// Production conversations use the same CAS as the guide without reopening completed guide stages.
func (s *Service) withDramaTextEdit(projectID string, expected *int64, rewindAssets bool, edit func(*repository.Repository) error) error {
	return s.withDramaRevisionEdit(projectID, expected, rewindAssets, true, edit)
}

func (s *Service) withDramaRevisionEdit(projectID string, expected *int64, rewindAssets, productionEdit bool, edit func(*repository.Repository) error) error {
	return dramaGuideError(s.repo.Transaction(func(tx *repository.Repository) error {
		p, err := tx.DramaProductionForUpdate(projectID)
		if err != nil {
			return err
		}
		if !dramaGuideActive(p) {
			if expected != nil && (!productionEdit || *expected != p.Revision) {
				return repository.ErrDramaGuideChanged
			}
			if err := edit(tx); err != nil {
				return err
			}
			if productionEdit {
				return tx.UpdateDramaGuideIf(projectID, p.Revision, p.GuideStep, map[string]any{})
			}
			return nil
		}
		if expected == nil || *expected != p.Revision {
			return repository.ErrDramaGuideChanged
		}
		active, err := tx.DramaTextJobsActive(projectID)
		if err != nil {
			return err
		}
		if active {
			return dramaGuideConflict("文字任务正在进行，请完成后再应用修改")
		}
		if err := edit(tx); err != nil {
			return err
		}
		fields := map[string]any{}
		if rewindAssets && p.GuideStep == model.DramaGuideStory {
			fields["guide_step"] = model.DramaGuideAssets
		}
		return tx.UpdateDramaGuideIf(projectID, p.Revision, p.GuideStep, fields)
	}))
}

func dramaGuideReadiness(repo *repository.Repository, p *model.DramaProduction) (bool, string, error) {
	if !dramaGuideActive(p) {
		return false, "", nil
	}
	active, err := repo.DramaTextJobsActive(p.ProjectID)
	if err != nil {
		return false, "", err
	}
	if active {
		return false, "文字任务正在进行，请稍候", nil
	}
	switch p.GuideStep {
	case model.DramaGuideConfiguring:
		chapters, err := repo.DramaChapters(p.ProjectID)
		if err != nil {
			return false, "", err
		}
		if len(chapters) == 0 {
			return false, "请先保存要改编的故事正文", nil
		}
		return true, "", nil
	case model.DramaGuideAssets:
		if p.Stage == model.DramaStageBible {
			return false, "资产文字设定尚未生成完成", nil
		}
		return true, "", nil
	case model.DramaGuideStory:
		if !p.PlanDone {
			return false, "分集规划尚未完成", nil
		}
		episodes, err := repo.DramaEpisodes(p.ProjectID)
		if err != nil {
			return false, "", err
		}
		if len(episodes) == 0 {
			return false, "尚无可确认的剧集", nil
		}
		for _, episode := range episodes {
			if episode.Error != "" || episode.ShotCount == 0 || dramaStageOrder[episode.Stage] < dramaStageOrder[model.DramaEpisodePrompts] {
				return false, fmt.Sprintf("第 %d 集剧本与分镜尚未就绪", episode.Number), nil
			}
			segments, err := repo.DramaSegments(episode.ID)
			if err != nil {
				return false, "", err
			}
			if len(segments) == 0 {
				return false, fmt.Sprintf("第 %d 集尚无剧情段提示词", episode.Number), nil
			}
			for _, segment := range segments {
				if !dramaPromptReady(segment) {
					return false, fmt.Sprintf("第 %d 集视频提示词尚未就绪，请完成撰写或重试", episode.Number), nil
				}
			}
		}
		return true, "", nil
	default:
		return false, "引导阶段无效", nil
	}
}

func (s *Service) dramaGuideView(p *model.DramaProduction) (*DramaGuideView, error) {
	if p.GuideStep == "" {
		return nil, nil
	}
	ready, reason, err := dramaGuideReadiness(s.repo, p)
	if err != nil {
		return nil, err
	}
	return &DramaGuideView{Step: p.GuideStep, CanConfirm: ready, BlockingReason: reason}, nil
}

func (s *Service) validateDramaGuideSettings(userID string, settings DramaSettings) (DramaSettings, error) {
	settings.MediaMode = DramaMediaManual
	settings = settings.normalized()
	if !production.ValidAspectRatio(settings.AspectRatio) {
		return settings, BadAuthRequest("不支持的画幅：" + settings.AspectRatio)
	}
	if problem := production.ValidateAssetPrompts(settings.Assets); problem != "" {
		return settings, BadAuthRequest(problem)
	}
	if err := s.validateDramaSkills(userID, settings); err != nil {
		return settings, err
	}
	if err := s.validateDramaModelOverrides(userID, settings.Models); err != nil {
		return settings, err
	}
	models, err := s.resolveDramaModels(userID, settings)
	if err != nil {
		return settings, err
	}
	settings.Models = models
	if missing := missingDramaCapabilities(models); len(missing) > 0 {
		return settings, BadAuthRequest("还没有可用的" + strings.Join(missing, "、") + "模型")
	}
	if err := s.validateDramaImageSettings(models, settings.Assets); err != nil {
		return settings, err
	}
	return settings, s.validateDramaVideoSettings(settings)
}

func (s *Service) ConfirmDramaGuide(userID, projectID string, req ConfirmDramaGuideRequest) (DramaSummary, error) {
	project, p, err := s.dramaForUser(userID, projectID)
	if err != nil {
		return DramaSummary{}, err
	}
	settings := parseDramaSettings(p.SettingsJSON)
	if req.Settings != nil {
		if req.ExpectedStep != model.DramaGuideConfiguring {
			return DramaSummary{}, BadAuthRequest("只能在确认制作方案时更新设置")
		}
		settings = *req.Settings
	}
	if req.ExpectedStep == model.DramaGuideConfiguring {
		if settings, err = s.validateDramaGuideSettings(userID, settings); err != nil {
			return DramaSummary{}, err
		}
		if exhausted, err := s.dramaBudgetExhausted(p); err != nil {
			return DramaSummary{}, err
		} else if exhausted {
			return DramaSummary{}, BadAuthRequest("已达到预算上限，请先提高预算")
		}
	}
	err = s.repo.Transaction(func(tx *repository.Repository) error {
		current, err := tx.DramaProductionForUpdate(projectID)
		if err != nil {
			return err
		}
		if !dramaGuideActive(current) || current.GuideStep != req.ExpectedStep || current.Revision != req.ExpectedRevision {
			return repository.ErrDramaGuideChanged
		}
		ready, reason, err := dramaGuideReadiness(tx, current)
		if err != nil {
			return err
		}
		if !ready {
			return dramaGuideConflict(reason)
		}
		fields := map[string]any{}
		switch current.GuideStep {
		case model.DramaGuideConfiguring:
			chapters, err := tx.DramaChapters(projectID)
			if err != nil {
				return err
			}
			format := production.NormalizeSourceFormat(project.SourceType)
			if format != production.SourceNovel {
				settings.EpisodeMode, settings.ChaptersPerEpisode = DramaEpisodeModeChapter, 1
			}
			var episodes []model.DramaEpisode
			cursor, done := 0, false
			if settings.EpisodeMode == DramaEpisodeModeChapter {
				episodes, err = groupDramaChapterEpisodes(projectID, 1, chapters, settings.ChaptersPerEpisode, format, time.Now())
				if err != nil {
					return err
				}
				cursor, done = len(chapters), true
			}
			if err := tx.ResetDramaGuideEpisodes(projectID, format, episodes, cursor, done); err != nil {
				return err
			}
			fields["settings_json"], fields["status"], fields["pause_reason"] = encodeDramaSettings(settings), model.DramaStatusRunning, ""
			fields["guide_step"] = model.DramaGuideAssets
		case model.DramaGuideAssets:
			fields["guide_step"] = model.DramaGuideStory
			fields["status"], fields["pause_reason"] = model.DramaStatusRunning, ""
		case model.DramaGuideStory:
			if err := tx.CompleteDramaGuideEpisodes(projectID); err != nil {
				return err
			}
			fields["guide_step"] = model.DramaGuideCompleted
		}
		return tx.UpdateDramaGuideIf(projectID, current.Revision, current.GuideStep, fields)
	})
	if err != nil {
		return DramaSummary{}, dramaGuideError(err)
	}
	s.wakeDramaScheduler()
	return s.DramaSummary(userID, projectID)
}

func (s *Service) UpdateDramaGuideSource(userID, projectID string, req UpdateDramaGuideSourceRequest) (DramaSummary, error) {
	project, p, err := s.dramaForUser(userID, projectID)
	if err != nil {
		return DramaSummary{}, err
	}
	if p.GuideStep != model.DramaGuideConfiguring {
		return DramaSummary{}, BadAuthRequest("正文替换仅限制作方案确认前")
	}
	format := production.NormalizeSourceFormat(firstNonEmpty(req.SourceFormat, project.SourceType))
	settings := parseDramaSettings(p.SettingsJSON)
	if format != production.SourceNovel {
		settings.EpisodeMode, settings.ChaptersPerEpisode = DramaEpisodeModeChapter, 1
	}
	chapters, episodes, cursor, done, err := prepareDramaSource(projectID, req.Chapters, nil, settings, format, time.Now())
	if err != nil {
		return DramaSummary{}, err
	}
	expected := req.ExpectedRevision
	err = s.withDramaGuideEdit(projectID, &expected, false, func(tx *repository.Repository) error {
		current, err := tx.DramaProduction(projectID)
		if err != nil {
			return err
		}
		if current.GuideStep != model.DramaGuideConfiguring {
			return repository.ErrDramaGuideChanged
		}
		if err := tx.ReplaceDramaGuideSource(projectID, format, chapters, episodes, cursor, done); err != nil {
			return err
		}
		return tx.UpdateDramaGuideDraftFields(projectID, map[string]any{"settings_json": encodeDramaSettings(settings)})
	})
	if err != nil {
		return DramaSummary{}, err
	}
	return s.DramaSummary(userID, projectID)
}

func prepareDramaSource(projectID string, input []DramaChapterInput, selectedInput []int, settings DramaSettings, format string, now time.Time) ([]model.ProjectUnit, []model.DramaEpisode, int, bool, error) {
	if len(input) == 0 || len(input) > dramaMaxChapters {
		return nil, nil, 0, false, BadAuthRequest("章节数量必须在 1 到 3000 之间")
	}
	selected, err := dramaSelectedChapters(selectedInput, len(input))
	if err != nil {
		return nil, nil, 0, false, err
	}
	chapters := make([]model.ProjectUnit, 0, len(input))
	var produced []model.ProjectUnit
	totalRunes, producedRunes := 0, 0
	for index, item := range input {
		text := strings.TrimSpace(strings.ReplaceAll(item.Text, "\r\n", "\n"))
		runes := utf8.RuneCountInString(text)
		if runes > dramaMaxChapterRunes {
			return nil, nil, 0, false, BadAuthRequest("单章不能超过 6 万字，请检查章节拆分")
		}
		if selected[index] && runes > production.ScriptSourceChapterRunes {
			return nil, nil, 0, false, BadAuthRequest(fmt.Sprintf("第 %d 章原文 %d 字，单章不超过 %d 字，请检查章节拆分", index+1, runes, production.ScriptSourceChapterRunes))
		}
		totalRunes += runes
		status := model.ProjectUnitStatusReserved
		if selected[index] {
			status = model.ProjectUnitStatusReady
		}
		chapter := model.ProjectUnit{ID: newID(), ProjectID: projectID, Kind: model.ProjectUnitKindChapter, Title: truncateRunes(firstNonEmpty(strings.TrimSpace(item.Title), fmt.Sprintf("第 %d 章", index+1)), 200), SourceText: text, WordCount: runes, Status: status, Position: index, CreatedAt: now, UpdatedAt: now}
		chapters = append(chapters, chapter)
		if selected[index] {
			produced = append(produced, chapter)
			producedRunes += runes
		}
	}
	if totalRunes == 0 || producedRunes == 0 {
		return nil, nil, 0, false, BadAuthRequest("原文为空")
	}
	if totalRunes > dramaMaxNovelRunes {
		return nil, nil, 0, false, BadAuthRequest("原文不能超过 600 万字")
	}
	if settings.EpisodeMode != DramaEpisodeModeChapter {
		return chapters, nil, 0, false, nil
	}
	episodes, err := groupDramaChapterEpisodes(projectID, 1, produced, settings.ChaptersPerEpisode, format, now)
	return chapters, episodes, len(produced), true, err
}

func (s *Service) validateDramaGuideConversation(userID, projectID, conversationID string) error {
	row, err := s.repo.CloudAgentConversationLatest(userID, conversationID)
	if err != nil {
		return BadAuthRequest("Agent 会话不存在或不属于当前用户")
	}
	full, err := s.repo.CloudAgent(userID, row.ID)
	if err != nil {
		return err
	}
	var state struct {
		Request struct {
			DramaProjectID string `json:"dramaProjectId"`
		} `json:"request"`
	}
	if json.Unmarshal([]byte(full.StateJSON), &state) != nil || state.Request.DramaProjectID != projectID {
		return BadAuthRequest("Agent 会话未绑定此短剧项目")
	}
	return nil
}
