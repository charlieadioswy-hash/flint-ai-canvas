package app

import (
	"encoding/json"
	"strings"
	"unicode/utf8"

	"yingce/backend/internal/model"
	"yingce/backend/internal/production"
	"yingce/backend/internal/repository"
)

// 工作区将两组草稿放入同一作品事务：任何校验、引用、版本或写入失败均不留下半组设置。
func (s *Service) saveDramaCastWorkspace(userID, projectID, castID string, req UpdateDramaCastRequest, lookReq *DramaCastLookRequest) (model.DramaCast, int, error) {
	if _, _, err := s.dramaForUser(userID, projectID); err != nil {
		return model.DramaCast{}, 0, err
	}
	if req.ExpectedRevision == nil || req.ExpectedCastRevision == nil {
		return model.DramaCast{}, 0, BadAuthRequest("请提供当前作品和资产版本")
	}
	affected := 0
	rewindAssets := false
	edit := func(tx *repository.Repository) error {
		p, err := tx.DramaProduction(projectID)
		if err != nil {
			return err
		}
		if p.UserID != userID {
			return BadAuthRequest("作品已变化，请重新打开")
		}
		settings, err := dramaCastContextSettings(tx, p, req.EpisodeID)
		if err != nil {
			return err
		}
		if _, err := tx.ProjectForUser(userID, projectID); err != nil {
			return dramaLookupError(err)
		}
		cast, err := tx.DramaCastForUpdate(projectID, castID)
		if err != nil {
			return dramaLookupError(err)
		}
		if cast.Revision != *req.ExpectedCastRevision {
			return dramaGuideConflict("资产配置已改变，请刷新后重新编辑")
		}
		original := *cast
		if lookReq != nil {
			if err := requireDramaGuideComplete(p); err != nil {
				return err
			}
			if cast.ParentID == "" {
				return BadAuthRequest("只能修改造型")
			}
		}
		fields, err := applyDramaCastImageFields(cast, req.ImagePrompt, req.ImageStyleID, req.ImageStyleName, req.ImageStylePrompt)
		if err != nil {
			return err
		}
		for column, value := range map[string]string{"image_prompt": original.ImagePrompt, "image_style_id": original.ImageStyleID, "image_style_name": original.ImageStyleName, "image_style_prompt": original.ImageStylePrompt} {
			if fields[column] == value {
				delete(fields, column)
			}
		}
		if lookReq == nil {
			if req.Name != nil {
				name := strings.TrimSpace(*req.Name)
				if name == "" || utf8.RuneCountInString(name) > 60 {
					return BadAuthRequest("名称需为 1 到 60 字")
				}
				if name != cast.Name {
					fields["name"] = name
				}
			}
			if req.Aliases != nil {
				aliases := []string{}
				for _, alias := range *req.Aliases {
					if alias = strings.TrimSpace(alias); alias != "" && len(aliases) < 20 {
						aliases = append(aliases, truncateRunes(alias, 40))
					}
				}
				encoded, _ := json.Marshal(aliases)
				if string(encoded) != cast.AliasesJSON {
					fields["aliases_json"] = string(encoded)
				}
			}
			for _, field := range []struct {
				column, current string
				value           *string
				limit           int
			}{{"appearance", cast.Appearance, req.Appearance, 1000}, {"description", cast.Description, req.Description, 1000}, {"voice_instructions", cast.VoiceInstructions, req.VoiceInstructions, 500}} {
				if field.value == nil {
					continue
				}
				value := strings.TrimSpace(*field.value)
				if err := validateDramaCastText(value, field.column, field.limit, field.column == "appearance"); err != nil {
					return err
				}
				if value != field.current {
					fields[field.column] = value
				}
			}
			if req.Locked != nil && *req.Locked != cast.Locked {
				fields["locked"] = *req.Locked
			}
		} else {
			name := strings.TrimSpace(lookReq.LookName)
			if name == "" || utf8.RuneCountInString(name) > 60 || production.IsBaseLookName(name) {
				return BadAuthRequest("造型名无效")
			}
			if name != cast.LookName {
				fields["look_name"] = name
			}
			appearance := strings.TrimSpace(lookReq.Appearance)
			if err := validateDramaCastText(appearance, "这套造型的外观描述", 1000, true); err != nil {
				return err
			}
			if appearance != cast.Appearance {
				fields["appearance"] = appearance
			}
			if lookReq.FromChapter != nil || lookReq.ToChapter != nil {
				from, to := dramaNormalizeLookRange(lookReq.FromChapter, lookReq.ToChapter)
				if from != cast.LookFromChapter || to != cast.LookToChapter {
					fields["look_from_chapter"], fields["look_to_chapter"] = from, to
				}
			}
		}
		if req.ImageOptions != nil {
			encoded, err := s.validateDramaCastWorkspaceOptions(tx, userID, settings, *cast, *req.ImageOptions)
			if err != nil {
				return err
			}
			fields["image_options_json"] = encoded
		} else if mediaBusyStatus(cast.ImageStatus) {
			return dramaGuideConflict("资产图片正在生成或排队，请完成后再修改")
		}
		if dramaGuideActive(p) && lookReq == nil && cast.ImageStatus != "" && (fields["appearance"] != nil || fields["description"] != nil) {
			fields["image_status"] = model.DramaMediaStale
		}
		if lookReq == nil {
			for _, column := range []string{"name", "aliases_json", "appearance", "description", "voice_instructions", "image_prompt", "image_style_id", "image_style_name", "image_style_prompt"} {
				if _, changed := fields[column]; changed {
					rewindAssets = true
					break
				}
			}
		}
		if len(fields) > 0 {
			if err := tx.UpdateDramaCastFields(castID, fields); err != nil {
				return err
			}
		}
		if lookReq != nil && lookReq.RestyleSegments && original.Appearance != strings.TrimSpace(lookReq.Appearance) {
			affected, err = restyleDramaCastWorkspaceSegments(tx, projectID, castID)
			return err
		}
		return nil
	}
	err := s.withDramaRevisionEditDecision(projectID, req.ExpectedRevision, true, func(tx *repository.Repository) (bool, error) {
		err := edit(tx)
		return rewindAssets, err
	})
	if err != nil {
		return model.DramaCast{}, 0, err
	}
	cast, err := s.repo.DramaCast(projectID, castID)
	if err != nil {
		return model.DramaCast{}, 0, err
	}
	return *cast, affected, nil
}

func (s *Service) validateDramaCastWorkspaceOptions(tx *repository.Repository, userID string, settings DramaSettings, cast model.DramaCast, options DramaCastImageOptions) (string, error) {
	if mediaBusyStatus(cast.ImageStatus) {
		return "", dramaGuideConflict("资产图片正在生成或排队，请完成后再改配置")
	}
	jobs, err := tx.DramaJobsByStatus(cast.ProjectID, model.DramaJobQueued, model.DramaJobRunning)
	if err != nil {
		return "", err
	}
	for _, job := range jobs {
		if job.Kind == model.DramaJobCastImage && job.CastID == cast.ID {
			return "", dramaGuideConflict("资产图片任务正在进行，请完成后再改配置")
		}
	}
	options.Ratio = strings.TrimSpace(options.Ratio)
	options.Resolution = strings.ToLower(strings.TrimSpace(options.Resolution))
	ids := append(append([]string{}, options.SubjectReferenceIDs...), options.StyleReferenceIDs...)
	if err := tx.LockDramaCastImageReferences(userID, ids); err != nil {
		return "", BadAuthRequest("参考图片已变化或无权使用，请重新选择")
	}
	encoded, err := json.Marshal(options)
	if err != nil {
		return "", err
	}
	cast.ImageOptionsJSON = string(encoded)
	plan, err := s.dramaCastImagePlanFor(tx, userID, settings, cast)
	if err != nil {
		return "", err
	}
	if s.dramaTaskHook == nil {
		if err := s.requireDramaModelOption(userID, "image", plan.Choice); err != nil {
			return "", err
		}
	}
	return string(encoded), nil
}

func restyleDramaCastWorkspaceSegments(tx *repository.Repository, projectID, castID string) (int, error) {
	shots, err := tx.DramaShotsReferencingCast(projectID, castID)
	if err != nil {
		return 0, err
	}
	marked := map[string]bool{}
	affected := 0
	for _, shot := range shots {
		key := shot.EpisodeID + "|" + itoa(shot.SegmentIndex)
		if marked[key] {
			continue
		}
		marked[key] = true
		changed, err := tx.MarkDramaSegmentVideoStale(shot.EpisodeID, shot.SegmentIndex)
		if err != nil {
			return 0, err
		}
		if !changed {
			continue
		}
		episode, err := tx.DramaEpisode(projectID, shot.EpisodeID)
		if err != nil {
			return 0, err
		}
		fields := map[string]any{"error": ""}
		if dramaStageOrder[episode.Stage] > dramaStageOrder[model.DramaEpisodeVideo] {
			fields["stage"] = model.DramaEpisodeVideo
		}
		if episode.FinalResourceID != "" {
			fields["final_stale"] = true
		}
		if err := tx.UpdateDramaEpisodeUser(episode.ID, fields); err != nil {
			return 0, err
		}
		affected++
	}
	return affected, nil
}
