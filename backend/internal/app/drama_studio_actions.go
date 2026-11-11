package app

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"unicode/utf8"

	"yingce/backend/internal/model"
	"yingce/backend/internal/production"
	"yingce/backend/internal/repository"
)

// DramaStudioActionRequest is an exact target, never an episode-wide media release.
type DramaStudioActionRequest struct {
	Action            string            `json:"action"`
	TargetID          string            `json:"targetId"`
	EpisodeID         string            `json:"episodeId,omitempty"`
	TargetRevision    *int64            `json:"targetRevision,omitempty"`
	BaseRevision      *int64            `json:"baseRevision,omitempty"`
	VideoModel        *DramaModelChoice `json:"videoModel,omitempty"`
	ConfirmationToken string            `json:"confirmationToken,omitempty"`
}

type DramaStudioMissingCast struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type DramaStudioActionPreflight struct {
	Action             string                   `json:"action"`
	TargetID           string                   `json:"targetId"`
	EpisodeID          string                   `json:"episodeId,omitempty"`
	SegmentIndex       *int                     `json:"segmentIndex,omitempty"`
	TargetRevision     int64                    `json:"targetRevision"`
	BaseRevision       int64                    `json:"baseRevision"`
	Ready              bool                     `json:"ready"`
	Reason             string                   `json:"reason,omitempty"`
	Message            string                   `json:"message"`
	ConfirmationToken  string                   `json:"confirmationToken"`
	MissingCasts       []DramaStudioMissingCast `json:"missingCasts"`
	Warnings           []string                 `json:"warnings"`
	CanUseText         bool                     `json:"canUseText"`
	Reprocessable      bool                     `json:"reprocessable"`
	AmountMicrocredits int64                    `json:"amountMicrocredits"`
	Priced             bool                     `json:"priced"`
	Request            *DramaSegmentRequest     `json:"request,omitempty"`
}

type dramaStudioActionPlan struct {
	view            DramaStudioActionPreflight
	production      *model.DramaProduction
	segment         *model.DramaSegment
	cast            *model.DramaCast
	jobID           string
	videoModelJSON  *string
	invalidateLater bool
}

// PreflightDramaStudioAction does not enqueue work. Both the card and Agent use this preview.
func (s *Service) PreflightDramaStudioAction(userID, projectID string, req DramaStudioActionRequest) (DramaStudioActionPreflight, error) {
	if _, _, err := s.dramaForUser(userID, projectID); err != nil {
		return DramaStudioActionPreflight{}, err
	}
	plan, err := s.prepareDramaStudioAction(s.repo, userID, projectID, req)
	return plan.view, err
}

func (s *Service) prepareDramaStudioAction(repo *repository.Repository, userID, projectID string, req DramaStudioActionRequest) (dramaStudioActionPlan, error) {
	plan := dramaStudioActionPlan{view: DramaStudioActionPreflight{Action: req.Action, TargetID: req.TargetID, MissingCasts: []DramaStudioMissingCast{}, Warnings: []string{}}}
	v := &plan.view
	if strings.TrimSpace(req.TargetID) == "" {
		return plan, BadAuthRequest("请选择具体的资产或剧情段")
	}
	p, err := repo.DramaProduction(projectID)
	if err != nil {
		return plan, err
	}
	plan.production, v.BaseRevision = p, p.Revision
	if req.BaseRevision != nil && *req.BaseRevision != p.Revision {
		return plan, dramaGuideConflict("制作配置已改变，请重新确认操作")
	}
	settings := parseDramaSettings(p.SettingsJSON)
	// Snapshot contains actual inputs, not just target ID; changing references, model, or quote invalidates confirmation.
	snapshot := []any{req.Action, projectID, p.Revision, p.SettingsJSON, p.BibleJSON, p.GuideStep, p.SampleApproved, p.MediaRequestsOnly, p.AssetsReleased}
	var choice DramaModelChoice
	var intent ModelRequestIntent
	blocked := func(reason string) {
		if v.Reason == "" {
			v.Reason = reason
		}
	}
	if dramaGuideActive(p) && req.Action != "segment_prompt" {
		blocked("请先完成文字创作引导")
	}
	if req.Action == "cast_image" {
		cast, err := repo.DramaCast(projectID, req.TargetID)
		if err != nil {
			return plan, err
		}
		plan.cast, v.TargetRevision = cast, cast.Revision
		snapshot = append(snapshot, cast)
		v.Message = "仅生成「" + cast.Name + "」参考图"
		if cast.Locked {
			blocked("设定已锁定，请先解锁")
		}
		if mediaBusyStatus(cast.ImageStatus) {
			blocked("该资产参考图正在生成或排队")
		}
		operation := "text_to_image"
		if cast.ParentID != "" {
			base, err := repo.DramaCast(projectID, cast.ParentID)
			if err != nil {
				return plan, err
			}
			snapshot = append(snapshot, base)
			operation = "image_to_image"
			if base.ImageStatus != model.DramaMediaReady || base.ImageResourceID == "" {
				blocked("请先生成角色本体「" + base.Name + "」参考图")
				v.MissingCasts = append(v.MissingCasts, DramaStudioMissingCast{ID: base.ID, Name: base.Name})
			} else if _, err := repo.ResourceForUser(userID, base.ImageResourceID); err != nil {
				return plan, err
			}
		}
		choice = settings.Models.imageFor(cast.Kind)
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
		intent = ModelRequestIntent{Capability: "image", Operation: operation, Options: options}
		if cast.ParentID != "" {
			intent.Inputs = map[string]int{"image": 1}
		}
	} else {
		if req.Action != "segment_video" && req.Action != "segment_prompt" && req.Action != "segment_reprocess" {
			return plan, BadAuthRequest("不支持的制作操作")
		}
		segment, err := repo.DramaSegment(projectID, req.TargetID)
		if err != nil {
			return plan, err
		}
		if req.Action == "segment_video" && req.VideoModel != nil {
			encoded := ""
			if !req.VideoModel.Empty() {
				b, _ := json.Marshal(req.VideoModel)
				encoded = string(b)
			}
			plan.videoModelJSON = &encoded
			segment.VideoModelJSON = encoded
		}
		if req.EpisodeID != "" && req.EpisodeID != segment.EpisodeID {
			return plan, BadAuthRequest("剧情段不属于所选集")
		}
		episode, err := repo.DramaEpisode(projectID, segment.EpisodeID)
		if err != nil {
			return plan, err
		}
		plan.segment, v.EpisodeID, v.TargetRevision = segment, segment.EpisodeID, segment.Revision
		plan.invalidateLater = !settings.parallelVideo() && segment.VideoResourceID != "" && req.Action != "segment_reprocess"
		if plan.invalidateLater {
			v.Warnings = append(v.Warnings, "本段采用尾帧续接；后续段的旧视频将标记待更新，保留原视频，不自动重新生成")
			rows, err := repo.DramaSegments(episode.ID)
			if err != nil {
				return plan, err
			}
			for _, later := range rows {
				if later.SegmentIndex <= segment.SegmentIndex {
					continue
				}
				snapshot = append(snapshot, later)
				if mediaBusyStatus(later.VideoStatus) || mediaBusyStatus(later.PromptStatus) {
					blocked("后续段任务正在进行，请完成后再调整当前段，避免覆盖尾帧续接中的任务")
				}
			}
		}
		index := segment.SegmentIndex
		v.SegmentIndex = &index
		snapshot = append(snapshot, segment, episode.Revision, episode.Stage, episode.Approved, episode.Error, episode.VideoRequestsOnly)
		v.Message = fmt.Sprintf("仅操作第 %d 集第 %d 段", episode.Number, index+1)
		jobs, err := repo.RecentDramaSegmentJobs(projectID, episode.ID)
		if err != nil {
			return plan, err
		}
		for _, job := range jobs {
			if job.ShotID == segment.ID && job.Kind == model.DramaJobSegmentVideo {
				v.Reprocessable = segment.VideoStatus == model.DramaMediaFailed && segment.VideoResourceID != "" && dramaVideoJobReplayable(job)
				plan.jobID = job.ID
				snapshot = append(snapshot, job.ID, job.Status, job.TaskID)
				if req.Action == "segment_video" && (job.Status == model.DramaJobQueued || job.Status == model.DramaJobRunning) {
					blocked("本段视频正在生成或排队")
				}
				break
			}
		}
		switch req.Action {
		case "segment_reprocess":
			v.Message += "，重新处理已有视频结果，不重新生成或扣费"
			if !v.Reprocessable {
				blocked("本段没有可重新处理的视频结果")
			}
		case "segment_prompt":
			v.Message += "的视频提示词，保留已有手动改写"
			if dramaGuideActive(p) && p.GuideStep != model.DramaGuideStory {
				blocked("请先确认资产文字设定")
			}
			if mediaBusyStatus(segment.PromptStatus) || segment.PromptStatus == "" {
				blocked("本段提示词正在撰写或等待撰写")
			}
			if mediaBusyStatus(segment.VideoStatus) {
				blocked("本段视频正在生成，请完成后再改写提示词")
			}
			choice, intent = settings.Models.textFor(DramaStepPrompt), ModelRequestIntent{Capability: "text"}
		case "segment_video":
			v.Message += "的视频，不生成其他段或资产图片"
			if mediaBusyStatus(segment.VideoStatus) {
				blocked("本段视频正在生成或排队")
			}
			if !dramaPromptReady(*segment) {
				blocked("请先撰写本段视频提示词")
			}
			if episode.Stage == model.DramaEpisodeQueued || episode.Stage == model.DramaEpisodeScript || episode.Error != "" {
				blocked("请先完成本集剧本与分镜")
			}
			if settings.ReviewMode == DramaReviewSample && !p.SampleApproved && episode.Number != 1 {
				blocked("请先确认第 1 集样片")
			}
			rows, err := repo.DramaSegments(episode.ID)
			if err != nil {
				return plan, err
			}
			for i := range rows {
				if rows[i].ID == segment.ID {
					rows[i].VideoModelJSON = segment.VideoModelJSON
				}
			}
			shots, err := repo.DramaShots(episode.ID)
			if err != nil {
				return plan, err
			}
			casts, err := repo.DramaCasts(projectID)
			if err != nil {
				return plan, err
			}
			castByID := map[string]model.DramaCast{}
			for _, cast := range casts {
				castByID[cast.ID] = cast
			}
			drafts := buildDramaSegmentDrafts(settings, parseDramaBibleMeta(p.BibleJSON), shots, castByID, rows)
			for i, row := range rows {
				if row.ID != segment.ID {
					continue
				}
				var previous *model.DramaSegment
				if i > 0 && !settings.parallelVideo() {
					previous = &rows[i-1]
					snapshot = append(snapshot, previous)
					if !dramaSegmentVideoDone(*previous) {
						blocked("等待上一段视频生成（需要它的最后一帧）")
					}
				}
				for _, draft := range drafts {
					if draft.view.Index != row.SegmentIndex {
						continue
					}
					snapshot = append(snapshot, draft.shots)
					request, refs, audios, prepareErr := s.prepareDramaSegment(settings, draft, row, previous, castByID)
					v.Request = &request
					for _, reference := range draft.view.Request.References {
						if cast, ok := castByID[reference.CastID]; ok {
							snapshot = append(snapshot, cast)
							if cast.ImageStatus != model.DramaMediaReady || cast.ImageResourceID == "" {
								v.MissingCasts = append(v.MissingCasts, DramaStudioMissingCast{ID: cast.ID, Name: cast.Name})
							}
							if mediaBusyStatus(cast.ImageStatus) {
								blocked("等待参考图生成：" + cast.Name)
							}
						}
					}
					if prepareErr != nil {
						blocked(prepareErr.Error())
					}
					if request.Warning != "" {
						v.Warnings = append(v.Warnings, request.Warning)
					}
					if len(request.UnknownReferences) > 0 {
						blocked(request.Warning)
					}
					if segment.PromptSeconds > 0 && segment.PromptSeconds != request.Seconds {
						blocked("所选模型时长档位与提示词不同，请先重新撰写本段提示词")
					}
					if request.FirstFramePending {
						blocked("等待上一段尾帧就绪")
					}
					if max := request.PromptMaxChars; max > 0 && utf8.RuneCountInString(strings.TrimSpace(request.Header+"\n\n"+firstNonEmpty(segment.VideoPromptOverride, segment.VideoPrompt))) > max {
						blocked("视频提示词超过所选模型上限，请先重新撰写或精简提示词")
					}
					for _, ref := range append(refs, audios...) {
						resourceID := strings.TrimPrefix(ref.(map[string]any)["storageKey"].(string), "resource:")
						if _, err := repo.ResourceForUser(userID, resourceID); err != nil {
							return plan, err
						}
					}
					v.CanUseText = prepareErr == nil && len(v.MissingCasts) > 0
					options := map[string]any{"videoSeconds": itoa(request.Seconds), "videoGenerateAudio": strconv.FormatBool(request.GenerateAudio)}
					dramaVideoScreen{Size: request.Size, Resolution: request.Resolution}.apply(options)
					intent = ModelRequestIntent{Capability: "video", Operation: request.Operation, Options: options, Inputs: map[string]int{"image": len(refs), "audio": len(audios)}}
					snapshot = append(snapshot, request)
				}
			}
			choice = segmentVideoChoice(*segment, settings.Models.Video)
			if v.Request == nil {
				blocked("本段分镜尚未就绪，请先完成本集剧本与分镜")
			}
		}
	}
	if req.TargetRevision != nil && *req.TargetRevision != v.TargetRevision {
		return plan, dramaGuideConflict("目标内容已改变，请重新确认操作")
	}
	if req.Action != "segment_reprocess" {
		// Production submission still performs the existing admission and credit reservation atomically.
		if s.dramaTaskHook == nil {
			if err := s.requireDramaModelOption(userID, intent.Capability, choice); err != nil {
				blocked(err.Error())
			}
		}
		v.AmountMicrocredits, v.Priced = s.quoteDramaChoice(userID, choice, intent)
		if s.dramaTaskHook == nil && !v.Priced {
			blocked("当前模型无法报价，请检查模型与计费配置")
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
	}
	v.Ready = v.Reason == ""
	snapshot = append(snapshot, v)
	encoded, _ := json.Marshal(snapshot)
	digest := sha256.Sum256(encoded)
	v.ConfirmationToken = hex.EncodeToString(digest[:])
	return plan, nil
}

// ExecuteDramaStudioAction rechecks the preview inside the production lock before changing one target.
func (s *Service) ExecuteDramaStudioAction(userID, projectID string, req DramaStudioActionRequest) (map[string]any, error) {
	if _, _, err := s.dramaForUser(userID, projectID); err != nil {
		return nil, err
	}
	if req.ConfirmationToken == "" || req.TargetRevision == nil || req.BaseRevision == nil {
		return nil, BadAuthRequest("请先预检并确认本次操作")
	}
	var plan dramaStudioActionPlan
	err := s.repo.Transaction(func(tx *repository.Repository) error {
		if _, err := tx.DramaProductionForUpdate(projectID); err != nil {
			return err
		}
		var err error
		plan, err = s.prepareDramaStudioAction(tx, userID, projectID, req)
		if err != nil {
			return err
		}
		if plan.view.ConfirmationToken != req.ConfirmationToken {
			return dramaGuideConflict("内容、依赖或报价已改变，请重新确认操作")
		}
		if !plan.view.Ready {
			return BadAuthRequest(plan.view.Reason)
		}
		// A scoped request never wakes implicit auto media across the project. Previously explicit releases and queued tasks remain authorized.
		if err := tx.RestrictDramaImplicitMedia(projectID); err != nil {
			return err
		}
		plan.production.MediaRequestsOnly = true
		switch req.Action {
		case "cast_image":
			changed, err := tx.UpdateDramaCastIf(plan.cast.ID, []string{plan.cast.ImageStatus}, map[string]any{"image_status": model.DramaMediaQueued})
			if err != nil {
				return err
			}
			if !changed {
				return dramaGuideConflict("资产状态已改变，请重新确认")
			}
			return nil
		case "segment_video":
			return tx.RequestDramaSegmentVideoExact(projectID, plan.segment.ID, plan.segment.Revision, plan.videoModelJSON, plan.invalidateLater)
		case "segment_prompt":
			return tx.RequestDramaSegmentPromptExact(projectID, plan.segment.ID, plan.segment.Revision, plan.invalidateLater)
		case "segment_reprocess":
			changed, err := tx.ReopenDramaSegmentVideoJob(plan.jobID, plan.segment.ID)
			if err != nil {
				return err
			}
			if !changed {
				return dramaGuideConflict("视频结果已改变，请重新确认")
			}
			return nil
		}
		return BadAuthRequest("不支持的制作操作")
	})
	if err != nil {
		return nil, dramaGuideError(err)
	}
	return map[string]any{"queued": 1, "action": req.Action, "targetId": req.TargetID}, s.requestDramaWork(plan.production)
}
