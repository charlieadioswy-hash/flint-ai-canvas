package app

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"yingce/backend/internal/kernel"
	"yingce/backend/internal/model"
	"yingce/backend/internal/repository"
)

func requireDramaGuideAssetEdit(p *model.DramaProduction) error {
	if p.GuideStep != model.DramaGuideAssets && p.GuideStep != model.DramaGuideStory {
		return dramaGuideConflict("请在资产或剧本确认阶段调整资产列表")
	}
	return nil
}

func (s *Service) CreateDramaCast(userID, projectID string, req CreateDramaCastRequest) (model.DramaCast, error) {
	project, p, err := s.dramaForUser(userID, projectID)
	if err != nil {
		return model.DramaCast{}, err
	}
	if dramaGuideActive(p) {
		if err := requireDramaGuideAssetEdit(p); err != nil {
			return model.DramaCast{}, err
		}
	}
	req.Kind = strings.TrimSpace(req.Kind)
	if !validDramaCastKind(req.Kind) {
		return model.DramaCast{}, BadAuthRequest("资产类型必须为角色、场景或道具")
	}
	name := strings.TrimSpace(req.Name)
	if name == "" || utf8.RuneCountInString(name) > 60 {
		return model.DramaCast{}, BadAuthRequest("名称需为 1 到 60 字")
	}
	for _, field := range []struct {
		value, label string
		limit        int
		required     bool
	}{
		{strings.TrimSpace(req.Appearance), "外观描述", 1000, false},
		{strings.TrimSpace(req.Description), "说明", 1000, false},
		{strings.TrimSpace(req.VoiceInstructions), "声音说明", 500, false},
	} {
		if err := validateDramaCastText(field.value, field.label, field.limit, field.required); err != nil {
			return model.DramaCast{}, err
		}
	}
	aliases := []string{}
	for _, alias := range req.Aliases {
		if alias = strings.TrimSpace(alias); alias != "" && len(aliases) < 20 {
			aliases = append(aliases, truncateRunes(alias, 40))
		}
	}
	encoded, _ := json.Marshal(aliases)
	cast := model.DramaCast{
		ID: newID(), ProjectID: project.ID, Kind: req.Kind, Name: name, AliasesJSON: string(encoded),
		Appearance:        truncateRunes(strings.TrimSpace(req.Appearance), 1000),
		Description:       truncateRunes(strings.TrimSpace(req.Description), 1000),
		VoiceInstructions: truncateRunes(strings.TrimSpace(req.VoiceInstructions), 500),
		ImageStatus:       model.DramaMediaDraft, Revision: 1, CreatedAt: time.Now(), UpdatedAt: time.Now(),
	}
	if _, err := applyDramaCastImageFields(&cast, &req.ImagePrompt, &req.ImageStyleID, &req.ImageStyleName, &req.ImageStylePrompt); err != nil {
		return model.DramaCast{}, err
	}
	if dramaGuideActive(p) && dramaCastHasImageDefinition(cast) {
		cast.ImageStatus = ""
	}
	err = s.withDramaTextEdit(project.ID, req.ExpectedRevision, true, func(tx *repository.Repository) error {
		current, err := tx.DramaProduction(project.ID)
		if err != nil {
			return err
		}
		if dramaGuideActive(current) {
			if err := requireDramaGuideAssetEdit(current); err != nil {
				return err
			}
		}
		if req.EpisodeID != "" {
			if _, err := tx.DramaEpisode(project.ID, req.EpisodeID); err != nil {
				return dramaLookupError(err)
			}
		}
		casts, err := tx.DramaCasts(project.ID)
		if err != nil {
			return err
		}
		for _, existing := range casts {
			if existing.Kind != req.Kind {
				continue
			}
			if existing.ParentID == "" && strings.EqualFold(strings.TrimSpace(existing.Name), name) && (dramaGuideActive(current) || req.ExpectedRevision != nil) {
				return dramaGuideConflict("同类型资产中已存在这个名称，请修改后重试")
			}
			if existing.Position >= cast.Position {
				cast.Position = existing.Position + 1
			}
		}
		if err := tx.CreateDramaCasts([]model.DramaCast{cast}); err != nil {
			return err
		}
		if req.EpisodeID == "" {
			return nil
		}
		return tx.MergeDramaEpisodeAssets(project.ID, []string{req.EpisodeID}, []string{cast.ID})
	})
	if err != nil {
		return model.DramaCast{}, err
	}
	created, err := s.repo.DramaCast(project.ID, cast.ID)
	if err != nil {
		return model.DramaCast{}, err
	}
	return *created, nil
}

func dramaCastDeleteScopeToken(projectID, castID string, revision int64, bindings map[string]map[string]string) string {
	return dramaCastViewDigest([]any{projectID, castID, revision, bindings})
}

func (s *Service) DeleteDramaCast(userID, projectID, castID string, req DeleteDramaCastRequest) error {
	project, p, err := s.dramaForUser(userID, projectID)
	if err != nil {
		return err
	}
	if req.ExpectedRevision == nil {
		return dramaGuideConflict("请提供当前作品版本后重试")
	}
	if dramaGuideActive(p) {
		if err := requireDramaGuideAssetEdit(p); err != nil {
			return err
		}
	}
	return s.withDramaTextEdit(project.ID, req.ExpectedRevision, true, func(tx *repository.Repository) error {
		current, err := tx.DramaProduction(project.ID)
		if err != nil {
			return err
		}
		if dramaGuideActive(current) {
			if err := requireDramaGuideAssetEdit(current); err != nil {
				return err
			}
		} else {
			active, err := tx.DramaTextJobsActive(project.ID)
			if err != nil {
				return err
			}
			if active {
				return dramaGuideConflict("文字任务正在进行，请完成后再应用修改")
			}
		}
		cast, err := tx.DramaCast(project.ID, castID)
		if err != nil {
			return err
		}
		if cast.ParentID != "" {
			return BadAuthRequest("请通过角色造型入口调整造型")
		}
		casts, err := tx.DramaCasts(project.ID)
		if err != nil {
			return err
		}
		removed := dramaCastAndLooks(casts, castID)
		mediaRefs, err := tx.DramaCastMediaReferences(project.ID, removed)
		if err != nil {
			return err
		}
		if req.DeleteScopeToken != dramaCastDeleteScopeToken(project.ID, castID, current.Revision, mediaRefs.Bindings) {
			conflict := NewAppError(http.StatusConflict, "资产的关联范围已更新，请重新核对后确认删除")
			conflict.Reason = kernel.ReasonDramaCastDeleteScopeChanged
			return conflict
		}
		ids := make([]string, 0, len(removed))
		for _, item := range casts {
			if !removed[item.ID] {
				continue
			}
			ids = append(ids, item.ID)
			if err := tx.RequireNoDramaCastViews(project.ID, item.ID); err != nil {
				if errors.Is(err, repository.ErrDramaCastViewChanged) {
					return dramaGuideConflict("该资产或其造型仍有独立视图，请先删除对应视图")
				}
				return err
			}
			if item.ImageStatus == model.DramaMediaRunning {
				return dramaGuideConflict("该资产的生成任务尚未结束，请完成后再删除")
			}
		}
		refs, err := tx.DramaCastDeleteReferences(userID, project.ID, ids)
		if err != nil {
			return err
		}
		switch {
		case len(refs.CanvasIDs) > 0:
			return dramaGuideConflict("该资产仍被画布引用，请先移除画布中的关联节点")
		case refs.ActiveTasks > 0:
			return dramaGuideConflict("该资产的生成任务尚未结束，请完成后再删除")
		}
		for _, job := range refs.Jobs {
			if job.Status == model.DramaJobRunning || (job.Status == model.DramaJobQueued && job.TaskID != "") {
				return dramaGuideConflict("该资产的生成任务尚未结束，请完成后再删除")
			}
		}
		// Keep a legacy current image in the take ledger so resource cleanup retains it.
		for _, item := range casts {
			if removed[item.ID] {
				if err := tx.PreserveDramaCastImage(item); err != nil {
					return err
				}
			}
		}
		labels, err := captureDramaCastDeletionLabels(tx, project.ID, casts, removed)
		if err != nil {
			return err
		}
		if err := tx.DetachDramaCastReferences(project.ID, removed, labels); err != nil {
			return err
		}
		return tx.DeleteDramaCastCatalog(project.ID, ids)
	})
}

func dramaCastAndLooks(casts []model.DramaCast, castID string) map[string]bool {
	ids := map[string]bool{castID: true}
	for pass := 0; pass < len(casts); pass++ {
		changed := false
		for _, cast := range casts {
			if ids[cast.ParentID] && !ids[cast.ID] {
				ids[cast.ID], changed = true, true
			}
		}
		if !changed {
			break
		}
	}
	return ids
}
