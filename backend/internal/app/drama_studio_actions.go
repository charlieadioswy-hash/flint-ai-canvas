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
	"yingce/backend/internal/repository"
)

// DramaStudioActionRequest is an exact target, never an episode-wide media release.
type DramaStudioActionRequest struct {
	Action            string                `json:"action"`
	TargetID          string                `json:"targetId"`
	EpisodeID         string                `json:"episodeId,omitempty"`
	TargetRevision    *int64                `json:"targetRevision,omitempty"`
	BaseRevision      *int64                `json:"baseRevision,omitempty"`
	VideoModel        *DramaModelChoice     `json:"videoModel,omitempty"`
	ConfirmationToken string                `json:"confirmationToken,omitempty"`
	CastDraft         *DramaStudioCastDraft `json:"castDraft,omitempty"`
}

// 草稿仅用于读取实际生图规格与费用，不保存，也不能用于执行任务。
type DramaStudioCastDraft struct {
	Name             *string                `json:"name,omitempty"`
	Appearance       *string                `json:"appearance,omitempty"`
	ImagePrompt      *string                `json:"imagePrompt,omitempty"`
	ImageStyleID     *string                `json:"imageStyleId,omitempty"`
	ImageStyleName   *string                `json:"imageStyleName,omitempty"`
	ImageStylePrompt *string                `json:"imageStylePrompt,omitempty"`
	ImageOptions     *DramaCastImageOptions `json:"imageOptions,omitempty"`
	Unlock           bool                   `json:"unlock,omitempty"`
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
	ScopeHash          string                   `json:"scopeHash,omitempty"`
	MissingCasts       []DramaStudioMissingCast `json:"missingCasts"`
	Warnings           []string                 `json:"warnings"`
	CanUseText         bool                     `json:"canUseText"`
	Reprocessable      bool                     `json:"reprocessable"`
	AmountMicrocredits int64                    `json:"amountMicrocredits"`
	Priced             bool                     `json:"priced"`
	Request            *DramaSegmentRequest     `json:"request,omitempty"`
}

type dramaStudioActionPlan struct {
	view               DramaStudioActionPreflight
	production         *model.DramaProduction
	segment            *model.DramaSegment
	cast               *model.DramaCast
	casts              []model.DramaCast
	sourceCasts        []model.DramaCast
	jobID              string
	videoModelJSON     *string
	invalidateLater    bool
	allowPendingPrompt bool
	pendingVideoID     string
	previousVideo      *model.DramaSegment
}

type dramaStudioActionOptions struct {
	pendingParents     map[string]bool
	pendingVideos      map[string]bool
	allowPendingPrompt bool
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
	return s.prepareDramaStudioActionWithOptions(repo, userID, projectID, req, dramaStudioActionOptions{})
}

func (s *Service) prepareDramaStudioActionWithOptions(repo *repository.Repository, userID, projectID string, req DramaStudioActionRequest, options dramaStudioActionOptions) (dramaStudioActionPlan, error) {
	plan := dramaStudioActionPlan{view: DramaStudioActionPreflight{Action: req.Action, TargetID: req.TargetID, MissingCasts: []DramaStudioMissingCast{}, Warnings: []string{}}, allowPendingPrompt: options.allowPendingPrompt}
	v := &plan.view
	if strings.TrimSpace(req.TargetID) == "" {
		return plan, BadAuthRequest("请选择具体的资产或剧情段")
	}
	if req.CastDraft != nil && req.Action != "cast_image" {
		return plan, BadAuthRequest("图片草稿只能用于资产图片计价")
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
	storyMedia := p.GuideStep == model.DramaGuideStory && (req.Action == "segment_video" || req.Action == "segment_assets" || req.Action == "segment_reprocess")
	if dramaGuideActive(p) && req.Action != "segment_prompt" && !storyMedia && !(req.Action == "cast_image" && (p.GuideStep == model.DramaGuideAssets || p.GuideStep == model.DramaGuideStory)) {
		blocked("请先确认剧本与分镜文字")
	}
	if req.Action == "segment_assets" {
		return s.prepareDramaStudioSegmentAssets(repo, userID, req, plan, settings, snapshot)
	}
	if req.Action == "cast_image" {
		meta := parseDramaBibleMeta(p.BibleJSON)
		if req.EpisodeID != "" {
			episode, err := repo.DramaEpisode(projectID, req.EpisodeID)
			if err != nil {
				return plan, err
			}
			settings, meta = dramaEpisodeStyleSettings(settings, meta, *episode)
			v.EpisodeID = episode.ID
			snapshot = append(snapshot, episode.ID, episode.Revision, episode.SettingsJSON)
		}
		cast, err := repo.DramaCast(projectID, req.TargetID)
		if err != nil {
			return plan, err
		}
		if req.CastDraft != nil {
			copy := *cast
			cast = &copy
			if req.CastDraft.Name != nil {
				name := strings.TrimSpace(*req.CastDraft.Name)
				if err := validateDramaCastText(name, "名称", 60, true); err != nil {
					return plan, err
				}
				if cast.ParentID != "" {
					cast.LookName = name
				} else {
					cast.Name = name
				}
			}
			if req.CastDraft.Appearance != nil {
				if err := validateDramaCastText(*req.CastDraft.Appearance, "外观描述", 1000, false); err != nil {
					return plan, err
				}
				cast.Appearance = strings.TrimSpace(*req.CastDraft.Appearance)
			}
			if _, err := applyDramaCastImageFields(cast, req.CastDraft.ImagePrompt, req.CastDraft.ImageStyleID, req.CastDraft.ImageStyleName, req.CastDraft.ImageStylePrompt); err != nil {
				return plan, err
			}
			if req.CastDraft.ImageOptions != nil {
				encoded, _ := json.Marshal(req.CastDraft.ImageOptions)
				cast.ImageOptionsJSON = string(encoded)
			}
			if req.CastDraft.Unlock {
				cast.Locked = false
			}
		}
		plan.cast, v.TargetRevision = cast, cast.Revision
		parentImageID := ""
		snapshot = append(snapshot, cast)
		v.Message = "仅生成「" + cast.Name + "」参考图"
		if !dramaCastHasImageDefinition(*cast) {
			blocked("资产「" + cast.Name + "」只有名称，请先补充描述或图片提示词")
		}
		if cast.Locked {
			blocked("设定已锁定，请先解锁")
		}
		if mediaBusyStatus(cast.ImageStatus) {
			blocked("该资产参考图正在生成或排队")
		}
		if cast.ParentID != "" {
			base, err := repo.DramaCast(projectID, cast.ParentID)
			if err != nil {
				return plan, err
			}
			snapshot = append(snapshot, base)
			if (base.ImageStatus != model.DramaMediaReady || base.ImageResourceID == "") && !options.pendingParents[base.ID] {
				blocked("请先生成角色本体「" + base.Name + "」参考图")
				v.MissingCasts = append(v.MissingCasts, DramaStudioMissingCast{ID: base.ID, Name: base.Name})
			} else if base.ImageStatus == model.DramaMediaReady && base.ImageResourceID != "" {
				parentImageID = base.ImageResourceID
				if _, err := repo.ResourceForUser(userID, base.ImageResourceID); err != nil {
					return plan, err
				}
			}
		}
		imagePlan, err := s.dramaCastImagePlanFor(repo, userID, settings, *cast)
		if err != nil {
			blocked(err.Error())
		}
		choice, intent = imagePlan.Choice, imagePlan.Intent
		// 保存会递增记录版本，但不会改变已向用户展示的真实生成内容与参考顺序。
		modelScope := []string{imagePlan.Choice.LogicalModelID, imagePlan.Choice.ChannelID, imagePlan.Choice.ModelKey}
		// 编辑器把缺省参考组展开为空数组，两种表示具有相同的生成输入。
		subjectReferences := append([]string{}, imagePlan.Options.SubjectReferenceIDs...)
		styleReferences := append([]string{}, imagePlan.Options.StyleReferenceIDs...)
		scope, _ := json.Marshal([]any{projectID, v.EpisodeID, cast.ID, cast.Kind, cast.Name, cast.LookName, cast.Appearance, cast.ImagePrompt, cast.ImageStyleID, cast.ImageStyleName, cast.ImageStylePrompt, modelScope, imagePlan.Ratio, imagePlan.Request, imagePlan.Intent, subjectReferences, styleReferences, parentImageID, buildDramaCastImagePrompt(settings, meta, *cast)})
		digest := sha256.Sum256(scope)
		v.ScopeHash = hex.EncodeToString(digest[:])
		snapshot = append(snapshot, imagePlan)
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
		settings, meta := dramaEpisodeStyleSettings(settings, parseDramaBibleMeta(p.BibleJSON), *episode)
		snapshot = append(snapshot, episode.SettingsJSON)
		plan.segment, v.EpisodeID, v.TargetRevision = segment, segment.EpisodeID, segment.Revision
		if storyMedia {
			readiness, err := dramaWorkflowEpisodeReadiness(repo, p, episode)
			if err != nil {
				return plan, err
			}
			snapshot = append(snapshot, readiness)
			if !readiness.TextReady {
				blocked(readiness.BlockingReason)
			}
		}
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
				v.Reprocessable = segment.VideoStatus == model.DramaMediaFailed && segment.VideoResourceID != "" && dramaVideoJobReplayableForSegment(job, *segment)
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
			if mediaBusyStatus(segment.PromptStatus) || segment.PromptStatus == "" && !options.allowPendingPrompt {
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
			if episode.Stage == model.DramaEpisodeDraft || episode.Stage == model.DramaEpisodeQueued || episode.Stage == model.DramaEpisodeScript || episode.Error != "" {
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
			drafts := buildDramaSegmentDrafts(settings, meta, shots, castByID, rows)
			for i, row := range rows {
				if row.ID != segment.ID {
					continue
				}
				var previous *model.DramaSegment
				if i > 0 && !settings.parallelVideo() {
					previous = &rows[i-1]
					plan.previousVideo = previous
					snapshot = append(snapshot, previous)
					if !dramaSegmentVideoDone(*previous) {
						if options.pendingVideos[previous.ID] || options.pendingVideos != nil && mediaBusyStatus(previous.VideoStatus) {
							plan.pendingVideoID = previous.ID
						} else {
							blocked("等待上一段视频生成（需要它的最后一帧）")
						}
					}
				}
				for _, draft := range drafts {
					if draft.view.Index != row.SegmentIndex {
						continue
					}
					snapshot = append(snapshot, draft.shots)
					request, refs, audios, prepareErr := s.prepareDramaSegment(settings, draft, row, previous, castByID)
					v.Request = &request
					for _, reference := range request.AudioReferences {
						if cast, ok := castByID[reference.CastID]; ok {
							snapshot = append(snapshot, cast)
						}
					}
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
					if request.FirstFramePending && plan.pendingVideoID == "" {
						blocked("等待上一段尾帧就绪")
					}
					if max := request.PromptMaxChars; max > 0 && utf8.RuneCountInString(strings.TrimSpace(request.Header+"\n\n"+firstNonEmpty(segment.VideoPromptOverride, segment.VideoPrompt))) > max {
						blocked("段提示词与最新资产说明超过所选模型上限，请精简资产描述或提示词，或换用上限更大的模型；原段稿已保留")
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
					imageCount := len(refs)
					if request.FirstFramePending {
						imageCount++ // 批次中的后段等尾帧就绪再提交，报价仍须包含这张实际首帧。
					}
					intent = ModelRequestIntent{Capability: "video", Operation: request.Operation, Options: options, Inputs: map[string]int{"image": imageCount, "audio": len(audios)}}
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
	if req.CastDraft != nil {
		return nil, BadAuthRequest("请先保存资产图片配置，再提交生成")
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
		return applyDramaStudioAction(tx, req.Action, plan)
	})
	if err != nil {
		return nil, dramaGuideError(err)
	}
	queued := 1
	if req.Action == "segment_assets" {
		queued = len(plan.casts)
	}
	warnings, pending := s.finishDramaStudioEnqueue(plan.production)
	return map[string]any{"queued": queued, "action": req.Action, "targetId": req.TargetID, "warnings": warnings, "dispatchPending": pending}, nil
}

// 单项和批量共用真实写路径；调用前必须完成全部预检与确认，批量不得边验证边写。
func applyDramaStudioAction(tx *repository.Repository, action string, plan dramaStudioActionPlan) error {
	projectID := plan.production.ProjectID
	switch action {
	case "cast_image":
		changed, err := tx.UpdateDramaCastImageRevision(plan.cast.ID, plan.cast.Revision, []string{plan.cast.ImageStatus}, map[string]any{"image_status": model.DramaMediaQueued, "image_episode_id": plan.view.EpisodeID})
		if err != nil {
			return err
		}
		if !changed {
			return dramaGuideConflict("资产状态已改变，请重新确认")
		}
		return nil
	case "segment_assets":
		for _, cast := range plan.casts {
			changed, err := tx.UpdateDramaCastImageRevision(cast.ID, cast.Revision, []string{cast.ImageStatus}, map[string]any{"image_status": model.DramaMediaQueued, "image_episode_id": plan.view.EpisodeID})
			if err != nil {
				return err
			}
			if !changed {
				return dramaGuideConflict("资产状态已改变，请重新确认")
			}
		}
		return nil
	case "segment_video":
		return tx.RequestDramaSegmentVideoExact(projectID, plan.segment.ID, plan.segment.Revision, plan.videoModelJSON, plan.invalidateLater)
	case "segment_prompt":
		return tx.RequestDramaSegmentPromptExact(projectID, plan.segment.ID, plan.segment.Revision, plan.invalidateLater, plan.allowPendingPrompt)
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
}
