package app

import (
	"encoding/json"
	"strings"
	"time"
	"unicode/utf8"

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
		{strings.TrimSpace(req.Appearance), "外观描述", 1000, !dramaGuideActive(p)},
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
	if dramaGuideActive(p) {
		cast.ImageStatus = ""
	}
	if _, err := applyDramaCastImageFields(&cast, &req.ImagePrompt, &req.ImageStyleID, &req.ImageStyleName, &req.ImageStylePrompt); err != nil {
		return model.DramaCast{}, err
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
		return tx.CreateDramaCasts([]model.DramaCast{cast})
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

func (s *Service) DeleteDramaCast(userID, projectID, castID string, req DeleteDramaCastRequest) error {
	project, p, err := s.dramaForUser(userID, projectID)
	if err != nil {
		return err
	}
	if err := requireDramaGuideAssetEdit(p); err != nil {
		return err
	}
	return s.withDramaGuideEdit(project.ID, req.ExpectedRevision, true, func(tx *repository.Repository) error {
		current, err := tx.DramaProduction(project.ID)
		if err != nil {
			return err
		}
		if err := requireDramaGuideAssetEdit(current); err != nil {
			return err
		}
		cast, err := tx.DramaCast(project.ID, castID)
		if err != nil {
			return err
		}
		if cast.ParentID != "" {
			return BadAuthRequest("请通过角色造型入口调整造型")
		}
		refs, err := tx.DramaCastDeleteReferences(userID, project.ID, castID)
		if err != nil {
			return err
		}
		switch {
		case refs.Looks > 0:
			return dramaGuideConflict("该角色仍有造型，暂时无法删除")
		case refs.Shots > 0:
			return dramaGuideConflict("该资产仍被分镜引用，请先调整分镜")
		case refs.Segments > 0:
			return dramaGuideConflict("该资产仍被剧情段引用，请先调整剧情段参考资产")
		case len(refs.CanvasIDs) > 0:
			return dramaGuideConflict("该资产仍被画布引用，请先移除画布中的关联节点")
		case refs.ActiveTasks > 0 || cast.ImageStatus == model.DramaMediaRunning:
			return dramaGuideConflict("该资产的生成任务尚未结束，请完成后再删除")
		}
		for _, job := range refs.Jobs {
			if job.Status == model.DramaJobRunning || (job.Status == model.DramaJobQueued && job.TaskID != "") {
				return dramaGuideConflict("该资产的生成任务尚未结束，请完成后再删除")
			}
		}
		// Keep a legacy current image in the take ledger so resource cleanup retains it.
		if err := tx.PreserveDramaCastImage(*cast); err != nil {
			return err
		}
		return tx.DeleteDramaCastCatalog(project.ID, castID)
	})
}
