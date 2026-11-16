package app

import (
	"strings"

	"yingce/backend/internal/model"
	"yingce/backend/internal/production"
	"yingce/backend/internal/repository"
)

func applyDramaGenerationSettings(settings DramaSettings, patch *DramaGenerationSettings) DramaSettings {
	if patch.Models != nil {
		if patch.Models.Image != nil {
			settings.Models.Image = *patch.Models.Image
		}
		if patch.Models.Video != nil {
			settings.Models.Video = *patch.Models.Video
		}
		if patch.Models.CharacterImage != nil {
			settings.Models.CharacterImage = *patch.Models.CharacterImage
		}
		if patch.Models.PropImage != nil {
			settings.Models.PropImage = *patch.Models.PropImage
		}
		if patch.Models.SceneImage != nil {
			settings.Models.SceneImage = *patch.Models.SceneImage
		}
	}
	if patch.Assets != nil {
		settings.Assets = *patch.Assets
	}
	if patch.AspectRatio != nil {
		settings.AspectRatio = *patch.AspectRatio
	}
	if patch.VideoResolution != nil {
		settings.VideoResolution = *patch.VideoResolution
	}
	if patch.VideoContinuity != nil {
		settings.VideoContinuity = *patch.VideoContinuity
	}
	if patch.ReferenceLimit != nil {
		settings.ReferenceLimit = *patch.ReferenceLimit
	}
	return settings
}

func (s *Service) updateDramaGenerationSettings(userID, projectID string, req UpdateDramaSettingsRequest) (DramaSummary, error) {
	if req.ExpectedRevision == nil || *req.ExpectedRevision < 0 {
		return DramaSummary{}, BadAuthRequest("请提交当前作品版本")
	}
	if req.Settings != nil || req.BudgetMicrocredits != nil {
		return DramaSummary{}, BadAuthRequest("生成配置须单独提交，不能同时更新其他设置或预算")
	}
	_, p, err := s.dramaForUser(userID, projectID)
	if err != nil {
		return DramaSummary{}, err
	}
	switch p.GuideStep {
	case "", model.DramaGuideConfiguring, model.DramaGuideAssets, model.DramaGuideStory, model.DramaGuideCompleted:
	default:
		return DramaSummary{}, BadAuthRequest("当前阶段不能修改生成配置")
	}
	previous := parseDramaSettings(p.SettingsJSON)
	settings := applyDramaGenerationSettings(previous, req.Generation)
	if !production.ValidAspectRatio(settings.AspectRatio) {
		return DramaSummary{}, BadAuthRequest("不支持的画幅：" + settings.AspectRatio)
	}
	if p.Stage != model.DramaStageBible && settings.AspectRatio != previous.AspectRatio && p.GuideStep != model.DramaGuideAssets {
		return DramaSummary{}, BadAuthRequest("制作开始后不能修改画幅")
	}
	if problem := production.ValidateAssetPrompts(settings.Assets); problem != "" {
		return DramaSummary{}, BadAuthRequest(problem)
	}
	if settings.VideoContinuity != DramaContinuityTailFrame && settings.VideoContinuity != DramaContinuityParallel {
		return DramaSummary{}, BadAuthRequest("不支持的视频衔接方式")
	}
	settings = settings.normalized()
	if req.Generation.Models != nil {
		for _, item := range []struct {
			capability string
			choice     *DramaModelChoice
		}{{"image", req.Generation.Models.Image}, {"video", req.Generation.Models.Video}, {"image", req.Generation.Models.CharacterImage}, {"image", req.Generation.Models.PropImage}, {"image", req.Generation.Models.SceneImage}} {
			if item.choice == nil || item.choice.Empty() {
				continue
			}
			if err := s.requireDramaModelOption(userID, item.capability, *item.choice); err != nil {
				return DramaSummary{}, err
			}
		}
	}
	// 只为显式清空的默认媒体模型补齐候选，其他能力及未提交字段保持原值。
	if req.Generation.Models != nil {
		for _, item := range []struct {
			capability string
			choice     *DramaModelChoice
		}{{"image", req.Generation.Models.Image}, {"video", req.Generation.Models.Video}} {
			if item.choice == nil || !item.choice.Empty() {
				continue
			}
			options, _, err := s.dramaModelOptions(userID, item.capability)
			if err != nil {
				return DramaSummary{}, err
			}
			if option, ok := preferredDramaOption(options, settings); ok {
				setDramaModelChoice(&settings.Models, item.capability, option.Choice)
			} else {
				return DramaSummary{}, BadAuthRequest("没有可用的" + map[string]string{"image": "图片", "video": "视频"}[item.capability] + "模型")
			}
		}
	}
	if err := s.validateDramaImageSettings(settings.Models, settings.Assets); err != nil {
		return DramaSummary{}, err
	}
	if err := s.validateDramaVideoSettings(settings); err != nil {
		return DramaSummary{}, err
	}
	release, err := s.lockDramaSchedule(projectID)
	if err != nil {
		return DramaSummary{}, err
	}
	defer release()
	err = s.repo.Transaction(func(tx *repository.Repository) error {
		current, err := tx.DramaProductionForUpdate(projectID)
		if err != nil {
			return err
		}
		if current.Revision != *req.ExpectedRevision || current.GuideStep != p.GuideStep {
			return repository.ErrDramaGuideChanged
		}
		busy, err := tx.DramaGenerationSettingsBusy(projectID)
		if err != nil {
			return err
		}
		if busy {
			return dramaGuideConflict("图片、视频或文字任务正在排队或生成，请完成后再修改生成配置")
		}
		fields := map[string]any{"settings_json": encodeDramaSettings(settings)}
		if current.GuideStep == model.DramaGuideAssets {
			initial := parseDramaSettings(dramaInitialEpisodeSettingsJSON(*current))
			nextInitial := mergeDramaInitialSettings(initial, parseDramaSettings(current.SettingsJSON), settings)
			fields["initial_settings_json"] = encodeDramaSettings(nextInitial)
			episodes, err := tx.DramaEpisodes(projectID)
			if err != nil {
				return err
			}
			for _, episode := range episodes {
				effective := initial
				if strings.TrimSpace(episode.SettingsJSON) != "" {
					effective = parseDramaSettings(episode.SettingsJSON)
				}
				updated := mergeDramaInitialSettings(effective, initial, nextInitial)
				if err := tx.UpdateDramaEpisodeSettings(projectID, episode.ID, episode.Revision, encodeDramaSettings(updated)); err != nil {
					return err
				}
			}
		} else if err := finalizeDramaInitialSettings(tx, current, settings, fields); err != nil {
			return err
		}
		return tx.UpdateDramaGuideIf(projectID, current.Revision, current.GuideStep, fields)
	})
	if err != nil {
		return DramaSummary{}, dramaGuideError(err)
	}
	return s.DramaSummary(userID, projectID)
}
