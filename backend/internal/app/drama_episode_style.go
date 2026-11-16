package app

import (
	"reflect"
	"strings"

	"yingce/backend/internal/model"
	"yingce/backend/internal/production"
	"yingce/backend/internal/repository"
)

type DramaEpisodeStyle struct {
	ProjectID       string        `json:"projectId"`
	EpisodeID       string        `json:"episodeId"`
	Revision        int64         `json:"revision"`
	EpisodeRevision int64         `json:"episodeRevision"`
	Settings        DramaSettings `json:"settings"`
}

type UpdateDramaEpisodeStyleRequest struct {
	ExpectedRevision        *int64         `json:"expectedRevision"`
	ExpectedEpisodeRevision *int64         `json:"expectedEpisodeRevision"`
	Settings                *DramaSettings `json:"settings"`
}

func dramaProjectControls(settings, defaults DramaSettings) DramaSettings {
	settings.DramaType = defaults.DramaType
	settings.Concurrency, settings.ReviewMode, settings.MediaMode = defaults.Concurrency, defaults.ReviewMode, defaults.MediaMode
	settings.EpisodeMode, settings.ChaptersPerEpisode = defaults.EpisodeMode, defaults.ChaptersPerEpisode
	return settings
}

// 缺失快照只兼容尚未迁移的测试/历史输入；正常创建与迁移均已保存完整初值。
func dramaEpisodeSettings(defaults DramaSettings, episode model.DramaEpisode) DramaSettings {
	if strings.TrimSpace(episode.SettingsJSON) == "" {
		return defaults
	}
	return dramaProjectControls(parseDramaSettings(episode.SettingsJSON), defaults)
}

func dramaInitialEpisodeSettingsJSON(p model.DramaProduction) string {
	if strings.TrimSpace(p.InitialSettingsJSON) != "" {
		return p.InitialSettingsJSON
	}
	return p.SettingsJSON
}

func initializeDramaEpisodeSettings(episodes []model.DramaEpisode, settingsJSON string) {
	for i := range episodes {
		episodes[i].SettingsJSON = settingsJSON
	}
}

func updateDramaInitialValue[T comparable](current *T, previous, next T) {
	if *current == previous {
		*current = next
	}
}

// 首次资产确认仍可补充模式参数；逐字段保留本集已经独立修改的配置。
func dramaGuideEpisodeInitialSettings(current, previous, next DramaSettings) DramaSettings {
	updateDramaInitialValue(&current.Storyboard.GenerationMode, previous.Storyboard.GenerationMode, next.Storyboard.GenerationMode)
	updateDramaInitialValue(&current.Storyboard.DirectorTemplate, previous.Storyboard.DirectorTemplate, next.Storyboard.DirectorTemplate)
	updateDramaInitialValue(&current.Storyboard.TargetShotCount, previous.Storyboard.TargetShotCount, next.Storyboard.TargetShotCount)
	updateDramaInitialValue(&current.Models.Image, previous.Models.Image, next.Models.Image)
	updateDramaInitialValue(&current.Models.Video, previous.Models.Video, next.Models.Video)
	updateDramaInitialValue(&current.AspectRatio, previous.AspectRatio, next.AspectRatio)
	updateDramaInitialValue(&current.VideoResolution, previous.VideoResolution, next.VideoResolution)
	updateDramaInitialValue(&current.VideoContinuity, previous.VideoContinuity, next.VideoContinuity)
	return current
}

// 正式开工前的配置定稿按字段三方合并，保留用户已经修改过的本集值。
func mergeDramaInitialSettings(current, previous, next DramaSettings) DramaSettings {
	var merge func(reflect.Value, reflect.Value, reflect.Value)
	merge = func(target, old, replacement reflect.Value) {
		// 渠道、型号与展示信息组成一次模型选择，不能分别从本集和默认值拼接。
		if target.Kind() == reflect.Struct && target.Type() != reflect.TypeOf(DramaModelChoice{}) {
			for i := 0; i < target.NumField(); i++ {
				merge(target.Field(i), old.Field(i), replacement.Field(i))
			}
			return
		}
		if reflect.DeepEqual(target.Interface(), old.Interface()) {
			target.Set(replacement)
		}
	}
	merge(reflect.ValueOf(&current).Elem(), reflect.ValueOf(previous), reflect.ValueOf(next))
	return current
}

func finalizeDramaInitialSettings(tx *repository.Repository, p *model.DramaProduction, next DramaSettings, fields map[string]any) error {
	if p.Status != model.DramaStatusDraft || p.GuideStep != "" {
		return nil
	}
	started, err := tx.DramaHasProductionContent(p.ProjectID)
	if err != nil || started {
		return err
	}
	previous := parseDramaSettings(dramaInitialEpisodeSettingsJSON(*p))
	episodes, err := tx.DramaEpisodes(p.ProjectID)
	if err != nil {
		return err
	}
	for _, episode := range episodes {
		current := previous
		if strings.TrimSpace(episode.SettingsJSON) != "" {
			current = parseDramaSettings(episode.SettingsJSON)
		}
		updated := mergeDramaInitialSettings(current, previous, next)
		if err := tx.UpdateDramaEpisodeSettings(p.ProjectID, episode.ID, episode.Revision, encodeDramaSettings(updated)); err != nil {
			return err
		}
	}
	fields["initial_settings_json"] = encodeDramaSettings(next)
	return nil
}

// 本集后续明确撰写使用本集配置；不重写已有提示词、正文或媒体。
func dramaEpisodeStyleSettings(settings DramaSettings, meta dramaBibleMeta, episode model.DramaEpisode) (DramaSettings, dramaBibleMeta) {
	effective := dramaEpisodeSettings(settings, episode)
	if effective.StyleName != settings.StyleName || effective.StylePrompt != settings.StylePrompt {
		meta.VisualRules = "保持本集视觉风格统一"
	}
	return effective, meta
}

func dramaEpisodeStyleView(p model.DramaProduction, episode model.DramaEpisode) DramaEpisodeStyle {
	return DramaEpisodeStyle{ProjectID: p.ProjectID, EpisodeID: episode.ID, Revision: p.Revision, EpisodeRevision: episode.Revision,
		Settings: dramaEpisodeSettings(parseDramaSettings(p.SettingsJSON), episode)}
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

func (s *Service) validateDramaEpisodeSettings(userID string, settings, previous DramaSettings) (DramaSettings, error) {
	if err := settings.ValidateStylePrompt(); err != nil {
		return settings, BadAuthRequest(err.Error())
	}
	if err := settings.Storyboard.ValidateDirector(); err != nil {
		return settings, BadAuthRequest(err.Error())
	}
	settings = settings.normalized()
	if err := settings.TextThinking.validate(); err != nil {
		return settings, err
	}
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
	for _, capability := range dramaCapabilities {
		choice := settings.Models.choice(capability)
		if !choice.Empty() && !dramaSameChoice(choice, previous.Models.choice(capability)) {
			if err := s.requireDramaModelOption(userID, capability, choice); err != nil {
				return settings, err
			}
		}
	}
	models, err := s.resolveDramaModels(userID, settings)
	if err != nil {
		return settings, err
	}
	settings.Models = models
	if err := s.validateDramaImageSettings(models, settings.Assets); err != nil {
		return settings, err
	}
	return settings, s.validateDramaVideoSettings(settings)
}

func (s *Service) UpdateDramaEpisodeStyle(userID, projectID, episodeID string, req UpdateDramaEpisodeStyleRequest) (DramaEpisodeStyle, error) {
	_, current, err := s.dramaForUser(userID, projectID)
	if err != nil {
		return DramaEpisodeStyle{}, err
	}
	if req.ExpectedRevision == nil || *req.ExpectedRevision < 0 || req.ExpectedEpisodeRevision == nil || *req.ExpectedEpisodeRevision < 0 {
		return DramaEpisodeStyle{}, BadAuthRequest("请提交当前作品与单集版本")
	}
	if req.Settings == nil {
		return DramaEpisodeStyle{}, BadAuthRequest("请提交本集制作配置")
	}
	episode, err := s.repo.DramaEpisode(projectID, episodeID)
	if err != nil {
		return DramaEpisodeStyle{}, dramaLookupError(err)
	}
	defaults := parseDramaSettings(current.SettingsJSON)
	settings, err := s.validateDramaEpisodeSettings(userID, dramaProjectControls(*req.Settings, defaults), dramaEpisodeSettings(defaults, *episode))
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
			return dramaGuideConflict("相关文字任务正在进行，请完成后再修改制作配置")
		}
		busy, err := tx.DramaEpisodeSettingsBusy(projectID, episodeID)
		if err != nil {
			return err
		}
		if busy {
			return dramaGuideConflict("本集图片或视频任务正在排队或生成，请完成后再修改制作配置")
		}
		settings = dramaProjectControls(settings, parseDramaSettings(p.SettingsJSON))
		encoded := encodeDramaSettings(settings)
		if err := tx.UpdateDramaEpisodeSettings(projectID, episodeID, episode.Revision, encoded); err != nil {
			return err
		}
		if err := tx.UpdateDramaGuideIf(projectID, p.Revision, p.GuideStep, map[string]any{}); err != nil {
			return err
		}
		p.Revision++
		episode.SettingsJSON = encoded
		view = dramaEpisodeStyleView(*p, *episode)
		return nil
	})
	return view, dramaGuideError(err)
}
