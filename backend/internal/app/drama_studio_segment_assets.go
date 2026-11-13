package app

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"

	"yingce/backend/internal/model"
	"yingce/backend/internal/production"
	"yingce/backend/internal/repository"
)

// 补图按剧情段的实际引用确定范围，不依赖视频模型、提示词或上一段尾帧是否就绪。
func (s *Service) prepareDramaStudioSegmentAssets(repo *repository.Repository, userID string, req DramaStudioActionRequest, plan dramaStudioActionPlan, settings DramaSettings, snapshot []any) (dramaStudioActionPlan, error) {
	v, p := &plan.view, plan.production
	blocked := func(reason string) {
		if v.Reason == "" {
			v.Reason = reason
		}
	}
	segment, err := repo.DramaSegment(p.ProjectID, req.TargetID)
	if err != nil {
		return plan, err
	}
	if req.EpisodeID != "" && req.EpisodeID != segment.EpisodeID {
		return plan, BadAuthRequest("剧情段不属于所选集")
	}
	if req.TargetRevision != nil && *req.TargetRevision != segment.Revision {
		return plan, dramaGuideConflict("目标内容已改变，请重新确认操作")
	}
	episode, err := repo.DramaEpisode(p.ProjectID, segment.EpisodeID)
	if err != nil {
		return plan, err
	}
	plan.segment, v.EpisodeID, v.TargetRevision = segment, segment.EpisodeID, segment.Revision
	index := segment.SegmentIndex
	v.SegmentIndex = &index
	shots, err := repo.DramaShots(episode.ID)
	if err != nil {
		return plan, err
	}
	casts, err := repo.DramaCasts(p.ProjectID)
	if err != nil {
		return plan, err
	}
	castByID := map[string]model.DramaCast{}
	for _, cast := range casts {
		castByID[cast.ID] = cast
	}
	jobs, err := repo.DramaJobsByStatus(p.ProjectID, model.DramaJobQueued, model.DramaJobRunning)
	if err != nil {
		return plan, err
	}
	busy := map[string]bool{}
	for _, job := range jobs {
		if job.Kind == model.DramaJobCastImage {
			busy[job.CastID] = true
		}
	}
	snapshot = append(snapshot, segment, episode.Revision)
	visited := map[string]int{}
	waiting := 0
	var include func(string) error
	include = func(id string) error {
		if visited[id] == 1 {
			return BadAuthRequest("角色造型的本体依赖存在循环，请先修正资产设定")
		}
		if visited[id] == 2 {
			return nil
		}
		cast, ok := castByID[id]
		if !ok {
			return BadAuthRequest("剧情段引用的资产或角色本体不存在")
		}
		visited[id] = 1
		snapshot = append(snapshot, cast, busy[id])
		if cast.ImageStatus == model.DramaMediaReady && cast.ImageResourceID != "" {
			visited[id] = 2
			return nil
		}
		operation := "text_to_image"
		if cast.ParentID != "" {
			if err := include(cast.ParentID); err != nil {
				return err
			}
			base := castByID[cast.ParentID]
			if base.ImageStatus == model.DramaMediaReady && base.ImageResourceID != "" {
				if _, err := repo.ResourceForUser(userID, base.ImageResourceID); err != nil {
					return err
				}
			}
			operation = "image_to_image"
		}
		if mediaBusyStatus(cast.ImageStatus) || busy[id] {
			waiting++
			visited[id] = 2
			return nil
		}
		if cast.Locked {
			blocked("资产「" + cast.Name + "」已锁定，请先解锁")
		}
		if !dramaCastHasImageDefinition(cast) {
			blocked("资产「" + cast.Name + "」只有名称，请先补充描述或图片提示词")
		}
		choice := settings.Models.imageFor(cast.Kind)
		ratio := production.AssetImageRatio
		if cast.Kind == "character" {
			ratio = settings.Assets.CharacterRatio
		}
		imageRequest := s.dramaImageRequestFor(choice, ratio, settings.Assets.ResolutionFor(cast.Kind))
		snapshot = append(snapshot, imageRequest)
		if imageRequest.Issue != "" {
			blocked(imageRequest.Issue)
		}
		options := map[string]any{}
		if imageRequest.Size != "" {
			options["size"] = imageRequest.Size
		}
		if imageRequest.Resolution != "" {
			options["imageResolution"] = imageRequest.Resolution
		}
		intent := ModelRequestIntent{Capability: "image", Operation: operation, Options: options}
		if cast.ParentID != "" {
			intent.Inputs = map[string]int{"image": 1}
		}
		if s.dramaTaskHook == nil {
			if err := s.requireDramaModelOption(userID, "image", choice); err != nil {
				blocked(err.Error())
			}
		}
		amount, priced := s.quoteDramaChoice(userID, choice, intent)
		if len(plan.casts) == 0 {
			v.Priced = true
		}
		v.Priced = v.Priced && priced
		v.AmountMicrocredits += amount
		plan.casts = append(plan.casts, cast)
		v.MissingCasts = append(v.MissingCasts, DramaStudioMissingCast{ID: cast.ID, Name: cast.Name})
		snapshot = append(snapshot, choice, intent, amount, priced)
		visited[id] = 2
		return nil
	}
	found := false
	for _, draft := range buildDramaSegmentDrafts(settings, parseDramaBibleMeta(p.BibleJSON), shots, castByID, []model.DramaSegment{*segment}) {
		if draft.view.Index != segment.SegmentIndex {
			continue
		}
		found = true
		snapshot = append(snapshot, draft.shots, draft.view.Request.References)
		for _, reference := range draft.view.Request.References {
			if reference.CastID != "" {
				if err := include(reference.CastID); err != nil {
					return plan, err
				}
			}
		}
		break
	}
	if !found {
		blocked("本段分镜尚未就绪，请先完成本集剧本与分镜")
	} else if len(plan.casts) == 0 {
		if waiting > 0 {
			blocked("缺失的资产参考图已在生成或排队，请等待完成")
		} else {
			blocked("本段资产参考图已齐全，无需生成")
		}
	}
	if waiting > 0 && len(plan.casts) > 0 {
		v.Warnings = append(v.Warnings, fmt.Sprintf("%d 张参考图已在生成或排队，本次跳过，不重复提交", waiting))
	}
	v.Message = fmt.Sprintf("仅生成第 %d 集第 %d 段缺失的 %d 张资产参考图，不生成视频", episode.Number, index+1, len(plan.casts))
	if s.dramaTaskHook == nil && !v.Priced && len(plan.casts) > 0 {
		blocked("当前图片模型无法报价，请检查模型与计费配置")
	}
	if v.Priced {
		account, err := repo.CreditAccount(userID)
		if err != nil {
			return plan, err
		}
		if account.AvailableMicrocredits < v.AmountMicrocredits {
			blocked("积分不足，请充值后重试")
		}
		if p.BudgetMicrocredits > 0 {
			totals, err := s.dramaBillingTotals(p)
			if err != nil {
				return plan, err
			}
			if totals.ChargedMicrocredits()+totals.HeldMicrocredits()+v.AmountMicrocredits > p.BudgetMicrocredits {
				blocked("剩余制作预算不足，请调整预算后重试")
			}
		}
	}
	v.Ready = v.Reason == ""
	snapshot = append(snapshot, v)
	encoded, _ := json.Marshal(snapshot)
	digest := sha256.Sum256(encoded)
	v.ConfirmationToken = hex.EncodeToString(digest[:])
	return plan, nil
}
