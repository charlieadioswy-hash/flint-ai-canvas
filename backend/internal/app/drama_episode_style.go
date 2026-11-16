package app

import (
	"fmt"
	"strings"
	"unicode/utf8"

	"yingce/backend/internal/model"
	"yingce/backend/internal/production"
	"yingce/backend/internal/repository"
)

const (
	dramaEpisodeStyleInherit     = "inherit"
	dramaEpisodeStyleIndependent = "independent"
)

type DramaEpisodeStyle struct {
	ProjectID          string                    `json:"projectId"`
	EpisodeID          string                    `json:"episodeId"`
	Revision           int64                     `json:"revision"`
	EpisodeRevision    int64                     `json:"episodeRevision"`
	Mode               string                    `json:"mode"`
	StyleName          string                    `json:"styleName"`
	StylePrompt        string                    `json:"stylePrompt"`
	DefaultStyleName   string                    `json:"defaultStyleName"`
	DefaultStylePrompt string                    `json:"defaultStylePrompt"`
	Drawing            DramaDrawingConfiguration `json:"drawing"`
}

type UpdateDramaEpisodeStyleRequest struct {
	ExpectedRevision        *int64                     `json:"expectedRevision"`
	ExpectedEpisodeRevision *int64                     `json:"expectedEpisodeRevision"`
	Mode                    string                     `json:"mode"`
	StyleName               string                     `json:"styleName"`
	StylePrompt             string                     `json:"stylePrompt"`
	Drawing                 *DramaDrawingConfiguration `json:"drawing,omitempty"`
}

// 单集覆盖只用于后续明确撰写，不修改已保存正文，也不改变共享主体的画风。
func dramaEpisodeStyleSettings(settings DramaSettings, meta dramaBibleMeta, episode model.DramaEpisode) (DramaSettings, dramaBibleMeta) {
	if episode.StyleMode == dramaEpisodeStyleIndependent {
		settings.StyleName, settings.StylePrompt = episode.StyleName, episode.StylePrompt
		// 与主体独立画风一致：全剧自由文本视觉规则可能含旧画风，不能与本集覆盖一起拼接。
		meta.VisualRules = "保持本集视觉风格统一"
	}
	return settings, meta
}

func dramaEpisodeStyleView(p model.DramaProduction, episode model.DramaEpisode) DramaEpisodeStyle {
	defaults := parseDramaSettings(p.SettingsJSON)
	effective, _ := dramaEpisodeStyleSettings(defaults, dramaBibleMeta{}, episode)
	mode := dramaEpisodeStyleInherit
	if episode.StyleMode == dramaEpisodeStyleIndependent {
		mode = dramaEpisodeStyleIndependent
	}
	return DramaEpisodeStyle{ProjectID: p.ProjectID, EpisodeID: episode.ID, Revision: p.Revision, EpisodeRevision: episode.Revision,
		Mode: mode, StyleName: effective.StyleName, StylePrompt: effective.StylePrompt, DefaultStyleName: defaults.StyleName, DefaultStylePrompt: defaults.StylePrompt, Drawing: dramaDrawingConfiguration(defaults)}
}

func (s *Service) DramaEpisodeStyle(userID, projectID, episodeID string) (DramaEpisodeStyle, error) {
	_, p, err := s.dramaForUser(userID, projectID)
	if err != nil {
		return DramaEpisodeStyle{}, err
	}
	episode, err := s.repo.DramaEpisode(projectID, episodeID)
	if err != nil {
		return DramaEpisodeStyle{}, dramaLookupError(err)
	}
	return dramaEpisodeStyleView(*p, *episode), nil
}

func (s *Service) UpdateDramaEpisodeStyle(userID, projectID, episodeID string, req UpdateDramaEpisodeStyleRequest) (DramaEpisodeStyle, error) {
	_, current, err := s.dramaForUser(userID, projectID)
	if err != nil {
		return DramaEpisodeStyle{}, err
	}
	name, prompt := strings.TrimSpace(req.StyleName), strings.TrimSpace(req.StylePrompt)
	if req.ExpectedRevision == nil || *req.ExpectedRevision < 0 || req.ExpectedEpisodeRevision == nil || *req.ExpectedEpisodeRevision < 0 {
		return DramaEpisodeStyle{}, BadAuthRequest("请提交当前作品与单集版本")
	}
	switch req.Mode {
	case dramaEpisodeStyleInherit:
		name, prompt = "", ""
	case dramaEpisodeStyleIndependent:
		if name == "" || utf8.RuneCountInString(name) > 60 || prompt == "" || utf8.RuneCountInString(prompt) > production.MaxStylePromptRunes {
			return DramaEpisodeStyle{}, BadAuthRequest(fmt.Sprintf("请提交 1 到 60 字的风格名称和不超过 %d 字的风格说明", production.MaxStylePromptRunes))
		}
	default:
		return DramaEpisodeStyle{}, BadAuthRequest("请选择沿用全剧默认或本集独立风格")
	}
	drawing, err := s.validateDramaDrawingConfiguration(userID, parseDramaSettings(current.SettingsJSON), req.Drawing)
	if err != nil {
		return DramaEpisodeStyle{}, err
	}
	release, err := s.lockDramaSchedule(projectID)
	if err != nil {
		return DramaEpisodeStyle{}, err
	}
	defer release()
	var view DramaEpisodeStyle
	err = s.repo.Transaction(func(tx *repository.Repository) error {
		p, err := tx.DramaProductionForUpdate(projectID)
		if err != nil {
			return err
		}
		episode, err := tx.DramaEpisode(projectID, episodeID)
		if err != nil {
			return dramaLookupError(err)
		}
		if p.Revision != *req.ExpectedRevision || episode.Revision != *req.ExpectedEpisodeRevision {
			return repository.ErrDramaGuideChanged
		}
		active, err := tx.DramaTextJobsActive(projectID)
		if err != nil {
			return err
		}
		if active {
			return dramaGuideConflict("相关文字任务正在进行，请完成后再修改风格")
		}
		fields := map[string]any{}
		if drawing != nil {
			settings := applyDramaDrawingConfiguration(parseDramaSettings(p.SettingsJSON), drawing)
			p.SettingsJSON = encodeDramaSettings(settings)
			fields["settings_json"] = p.SettingsJSON
		}
		if err := tx.UpdateDramaEpisodeStyle(projectID, episodeID, episode.Revision, req.Mode, name, prompt); err != nil {
			return err
		}
		if err := tx.UpdateDramaGuideIf(projectID, p.Revision, p.GuideStep, fields); err != nil {
			return err
		}
		p.Revision++
		episode.StyleMode, episode.StyleName, episode.StylePrompt = req.Mode, name, prompt
		view = dramaEpisodeStyleView(*p, *episode)
		return nil
	})
	return view, dramaGuideError(err)
}
