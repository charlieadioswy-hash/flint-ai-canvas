package app

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"sort"
	"strings"

	"yingce/backend/internal/model"
	"yingce/backend/internal/repository"

	"gorm.io/gorm"
)

type DramaStudioBatchRequest struct {
	Action            string            `json:"action"`
	TargetIDs         []string          `json:"targetIds"`
	EpisodeID         string            `json:"episodeId,omitempty"`
	VideoModel        *DramaModelChoice `json:"videoModel,omitempty"`
	BaseRevision      *int64            `json:"baseRevision,omitempty"`
	ConfirmationToken string            `json:"confirmationToken,omitempty"`
}

type DramaStudioBatchItem struct {
	TargetID           string                   `json:"targetId"`
	TargetKind         string                   `json:"targetKind"`
	Name               string                   `json:"name,omitempty"`
	EpisodeID          string                   `json:"episodeId,omitempty"`
	SegmentIndex       *int                     `json:"segmentIndex,omitempty"`
	TargetRevision     int64                    `json:"targetRevision"`
	SourceTargetIDs    []string                 `json:"sourceTargetIds,omitempty"`
	Status             string                   `json:"status"`
	Reason             string                   `json:"reason,omitempty"`
	AmountMicrocredits int64                    `json:"amountMicrocredits"`
	Priced             bool                     `json:"priced"`
	MissingCasts       []DramaStudioMissingCast `json:"missingCasts,omitempty"`
	Warnings           []string                 `json:"warnings,omitempty"`
}

type DramaStudioBatchView struct {
	Action             string                 `json:"action"`
	TargetIDs          []string               `json:"targetIds"`
	BaseRevision       int64                  `json:"baseRevision"`
	Ready              bool                   `json:"ready"`
	Reason             string                 `json:"reason,omitempty"`
	ConfirmationToken  string                 `json:"confirmationToken"`
	AmountMicrocredits int64                  `json:"amountMicrocredits"`
	Priced             bool                   `json:"priced"`
	Items              []DramaStudioBatchItem `json:"items"`
	Counts             map[string]int         `json:"counts"`
	Warnings           []string               `json:"warnings,omitempty"`
	DispatchPending    bool                   `json:"dispatchPending,omitempty"`
}

type dramaStudioBatchPlan struct {
	view             DramaStudioBatchView
	production       *model.DramaProduction
	plans            map[string]dramaStudioActionPlan
	aggregateBlocked bool
}

func normalizeDramaStudioBatch(req DramaStudioBatchRequest) (DramaStudioBatchRequest, error) {
	switch req.Action {
	case "cast_image", "segment_video", "segment_prompt", "segment_assets":
	default:
		return req, BadAuthRequest("不支持的批量制作操作")
	}
	if len(req.TargetIDs) == 0 || len(req.TargetIDs) > 200 {
		return req, BadAuthRequest("请明确选择 1 到 200 个资产或剧情段")
	}
	ids := make(map[string]bool, len(req.TargetIDs))
	for _, id := range req.TargetIDs {
		if id == "" || id != strings.TrimSpace(id) {
			return req, BadAuthRequest("批量范围不能包含空白目标")
		}
		ids[id] = true
	}
	req.TargetIDs = make([]string, 0, len(ids))
	for id := range ids {
		req.TargetIDs = append(req.TargetIDs, id)
	}
	sort.Strings(req.TargetIDs)
	if req.VideoModel != nil && req.Action != "segment_video" {
		return req, BadAuthRequest("只有批量视频生成支持指定视频模型")
	}
	return req, nil
}

func (s *Service) PreflightDramaStudioBatch(userID, projectID string, req DramaStudioBatchRequest) (DramaStudioBatchView, error) {
	if _, _, err := s.dramaForUser(userID, projectID); err != nil {
		return DramaStudioBatchView{}, err
	}
	req, err := normalizeDramaStudioBatch(req)
	if err != nil {
		return DramaStudioBatchView{}, err
	}
	plan, err := s.prepareDramaStudioBatch(s.repo, userID, projectID, req)
	if err == nil && req.BaseRevision != nil && *req.BaseRevision != plan.view.BaseRevision {
		err = dramaStudioBatchConflict(&plan.view, "制作配置已改变，请重新预检本批次")
	}
	return plan.view, err
}

func (s *Service) prepareDramaStudioBatch(repo *repository.Repository, userID, projectID string, req DramaStudioBatchRequest) (dramaStudioBatchPlan, error) {
	plan := dramaStudioBatchPlan{view: DramaStudioBatchView{Action: req.Action, TargetIDs: req.TargetIDs, Items: []DramaStudioBatchItem{}}, plans: map[string]dramaStudioActionPlan{}}
	p, err := repo.DramaProduction(projectID)
	if err != nil {
		return plan, err
	}
	plan.production, plan.view.BaseRevision = p, p.Revision
	jobs, err := repo.DramaJobsByStatus(projectID, model.DramaJobQueued, model.DramaJobRunning)
	if err != nil {
		return plan, err
	}
	busy := map[string]bool{}
	for _, job := range jobs {
		busy[dramaJobKey(job.Kind, job.EpisodeID, job.ShotID, job.CastID)] = true
	}
	sources := map[string][]string{}
	sourceEpisodes := map[string]string{}
	conflictingEpisodes := map[string]bool{}
	targets := map[string]bool{}
	pendingParents := map[string]bool{}
	snapshots := []any{req.Action, projectID, req.TargetIDs, req.EpisodeID, req.VideoModel, p.Revision, p.SettingsJSON, p.BibleJSON, p.GuideStep, p.SampleApproved, p.MediaRequestsOnly, p.AssetsReleased, p.BudgetMicrocredits}
	if req.Action == "segment_assets" {
		for _, id := range req.TargetIDs {
			source, err := s.prepareDramaStudioAction(repo, userID, projectID, DramaStudioActionRequest{Action: req.Action, TargetID: id, EpisodeID: req.EpisodeID})
			if err != nil {
				item, itemErr := dramaStudioBatchReadFailure(id, "segment", err)
				if itemErr != nil {
					return plan, itemErr
				}
				plan.view.Items = append(plan.view.Items, item)
				continue
			}
			snapshots = append(snapshots, source.view)
			if dramaGuideActive(p) && p.GuideStep != model.DramaGuideStory {
				plan.view.Items = append(plan.view.Items, DramaStudioBatchItem{TargetID: id, TargetKind: "segment", EpisodeID: source.view.EpisodeID, TargetRevision: source.view.TargetRevision, SegmentIndex: source.view.SegmentIndex, Status: "blocked", Reason: "请先确认剧本与分镜文字"})
				continue
			}
			if len(source.sourceCasts) == 0 {
				plan.view.Items = append(plan.view.Items, DramaStudioBatchItem{TargetID: id, TargetKind: "segment", EpisodeID: source.view.EpisodeID, TargetRevision: source.view.TargetRevision, SegmentIndex: source.view.SegmentIndex, Status: "blocked", Reason: firstNonEmpty(source.view.Reason, "本段没有可生成的引用资产")})
			}
			for _, cast := range source.sourceCasts {
				targets[cast.ID], pendingParents[cast.ID] = true, true
				sources[cast.ID] = append(sources[cast.ID], id)
				if previous := sourceEpisodes[cast.ID]; previous != "" && previous != source.view.EpisodeID {
					conflictingEpisodes[cast.ID] = true
				}
				sourceEpisodes[cast.ID] = source.view.EpisodeID
			}
		}
	} else {
		for _, id := range req.TargetIDs {
			targets[id], pendingParents[id] = true, true
		}
	}
	ids := make([]string, 0, len(targets))
	for id := range targets {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		action := req.Action
		episodeID := req.EpisodeID
		if action == "segment_assets" {
			action = "cast_image"
			episodeID = sourceEpisodes[id]
			if conflictingEpisodes[id] {
				plan.view.Items = append(plan.view.Items, DramaStudioBatchItem{TargetID: id, TargetKind: "cast", SourceTargetIDs: sources[id], Status: "blocked", Reason: "同一主体涉及多个分集，请按集补图"})
				continue
			}
		}
		if action == "cast_image" {
			if cast, err := repo.DramaCast(projectID, id); err == nil && cast.ParentID != "" {
				if parent, err := repo.DramaCast(projectID, cast.ParentID); err == nil && (mediaBusyStatus(parent.ImageStatus) || busy[dramaJobKey(model.DramaJobCastImage, "", "", parent.ID)]) {
					pendingParents[parent.ID] = true
				}
			}
		}
		target, err := s.prepareDramaStudioActionWithOptions(repo, userID, projectID, DramaStudioActionRequest{Action: action, TargetID: id, EpisodeID: episodeID, VideoModel: req.VideoModel}, dramaStudioActionOptions{pendingParents: pendingParents, allowPendingPrompt: true})
		if err != nil {
			kind := "segment"
			if action == "cast_image" {
				kind = "cast"
			}
			item, itemErr := dramaStudioBatchReadFailure(id, kind, err)
			if itemErr != nil {
				return plan, itemErr
			}
			item.SourceTargetIDs = sources[id]
			plan.view.Items = append(plan.view.Items, item)
			continue
		}
		plan.plans[id] = target
		item := dramaStudioBatchItem(action, target, busy)
		item.SourceTargetIDs = sources[id]
		plan.view.Items = append(plan.view.Items, item)
		snapshots = append(snapshots, target.view)
	}
	plan.propagateBlockedParents()
	plan.summarize()
	if plan.view.Counts["ready"] > 0 && plan.view.Priced {
		account, err := repo.CreditAccount(userID)
		if err != nil {
			return plan, err
		}
		if account.AvailableMicrocredits < plan.view.AmountMicrocredits {
			plan.blockReady("本批次积分不足，请充值后重新预检")
		} else if p.BudgetMicrocredits > 0 {
			totals, err := s.dramaBillingTotals(p)
			if err != nil {
				return plan, err
			}
			if totals.ChargedMicrocredits()+totals.HeldMicrocredits()+plan.view.AmountMicrocredits > p.BudgetMicrocredits {
				plan.blockReady("本批次剩余制作预算不足，请调整预算后重新预检")
			}
		}
	}
	snapshots = append(snapshots, plan.view)
	encoded, err := json.Marshal(snapshots)
	if err != nil {
		return plan, err
	}
	digest := sha256.Sum256(encoded)
	plan.view.ConfirmationToken = hex.EncodeToString(digest[:])
	return plan, nil
}

func dramaStudioBatchReadFailure(id, kind string, err error) (DramaStudioBatchItem, error) {
	item := DramaStudioBatchItem{TargetID: id, TargetKind: kind, Status: "failed", Reason: "所选目标不存在或不属于当前作品"}
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return item, nil
	}
	var appErr *AppError
	if !errors.As(err, &appErr) || appErr.Status >= 500 {
		return item, err
	}
	item.Reason = appErr.Message
	if appErr.Status == 409 {
		item.Status = "conflict"
	} else if appErr.Status == 400 {
		item.Status = "blocked"
	}
	return item, nil
}

func dramaStudioBatchItem(action string, plan dramaStudioActionPlan, busy map[string]bool) DramaStudioBatchItem {
	v := plan.view
	item := DramaStudioBatchItem{TargetID: v.TargetID, TargetKind: "segment", EpisodeID: v.EpisodeID, SegmentIndex: v.SegmentIndex, TargetRevision: v.TargetRevision, Status: "ready", AmountMicrocredits: v.AmountMicrocredits, Priced: v.Priced, MissingCasts: v.MissingCasts, Warnings: v.Warnings}
	ready, queued := false, false
	if plan.cast != nil {
		item.TargetKind, item.Name = "cast", plan.cast.Name
		ready = plan.cast.ImageStatus == model.DramaMediaReady && plan.cast.ImageResourceID != ""
		queued = mediaBusyStatus(plan.cast.ImageStatus) || busy[dramaJobKey(model.DramaJobCastImage, "", "", plan.cast.ID)]
	} else if plan.segment != nil {
		if action == "segment_prompt" {
			ready = dramaPromptReady(*plan.segment)
			queued = mediaBusyStatus(plan.segment.PromptStatus) || busy[dramaJobKey(model.DramaJobSegmentPrompt, plan.segment.EpisodeID, plan.segment.ID, "")]
		} else {
			ready = dramaSegmentVideoDone(*plan.segment)
			queued = mediaBusyStatus(plan.segment.VideoStatus) || busy[dramaJobKey(model.DramaJobSegmentVideo, plan.segment.EpisodeID, plan.segment.ID, "")]
		}
	}
	switch {
	case queued:
		item.Status, item.Reason = "already_queued", "已在生成或排队，本次跳过"
	case ready:
		item.Status, item.Reason = "skipped_ready", "已有成功结果，本次跳过"
	case action == "segment_video" && v.Reprocessable:
		item.Status, item.Reason = "blocked", "已有成功视频结果待处理，请先重新处理，避免重复生成"
	case !v.Ready:
		item.Status, item.Reason = "blocked", v.Reason
	}
	if item.Status != "ready" {
		item.AmountMicrocredits, item.Priced = 0, true
	}
	return item
}

func (p *dramaStudioBatchPlan) propagateBlockedParents() {
	indexes := map[string]int{}
	for i, item := range p.view.Items {
		indexes[item.TargetID] = i
	}
	visited := map[string]int{}
	var visit func(string) bool
	visit = func(id string) bool {
		index, ok := indexes[id]
		if !ok {
			return true
		}
		item := &p.view.Items[index]
		if item.Status == "already_queued" || item.Status == "skipped_ready" {
			return true
		}
		if item.Status != "ready" {
			return false
		}
		if visited[id] == 1 {
			item.Status, item.Reason = "blocked", "角色造型的本体依赖存在循环，请先修正资产设定"
			return false
		}
		if visited[id] == 2 {
			return item.Status == "ready"
		}
		visited[id] = 1
		if cast := p.plans[id].cast; cast != nil && cast.ParentID != "" && !visit(cast.ParentID) {
			item.Status, item.Reason = "blocked", "角色本体尚未就绪且无法在本批次生成，请先处理本体的阻塞项"
		}
		visited[id] = 2
		return item.Status == "ready"
	}
	for id := range indexes {
		visit(id)
	}
}

func (p *dramaStudioBatchPlan) summarize() {
	p.view.Counts = map[string]int{"ready": 0, "queued": 0, "already_queued": 0, "skipped_ready": 0, "blocked": 0, "conflict": 0, "failed": 0}
	p.view.AmountMicrocredits, p.view.Priced = 0, true
	for _, item := range p.view.Items {
		p.view.Counts[item.Status]++
		if item.Status == "ready" || item.Status == "queued" {
			p.view.AmountMicrocredits += item.AmountMicrocredits
			p.view.Priced = p.view.Priced && item.Priced
		}
	}
	p.view.Ready = p.view.Counts["ready"] > 0
}

func (p *dramaStudioBatchPlan) blockReady(reason string) {
	p.aggregateBlocked = true
	amount, priced := p.view.AmountMicrocredits, p.view.Priced
	for i := range p.view.Items {
		if p.view.Items[i].Status == "ready" {
			p.view.Items[i].Status, p.view.Items[i].Reason = "blocked", reason
		}
	}
	p.view.Reason = reason
	p.summarize()
	// 余额或预算不足时仍展示这批真实目标的报价，方便用户判断需要补足多少。
	p.view.AmountMicrocredits, p.view.Priced = amount, priced
}

func dramaStudioBatchConflict(view *DramaStudioBatchView, message string) error {
	hasReady := view.Counts["ready"] > 0
	for i := range view.Items {
		status := view.Items[i].Status
		if status == "ready" || !hasReady && status != "already_queued" && status != "skipped_ready" {
			view.Items[i].Status, view.Items[i].Reason = "conflict", message
		}
	}
	p := dramaStudioBatchPlan{view: *view}
	p.summarize()
	*view = p.view
	view.Reason = message
	err := dramaGuideConflict(message).(*AppError)
	err.Details = map[string]any{"batch": view}
	return err
}

func (s *Service) ExecuteDramaStudioBatch(userID, projectID string, req DramaStudioBatchRequest) (DramaStudioBatchView, error) {
	if _, _, err := s.dramaForUser(userID, projectID); err != nil {
		return DramaStudioBatchView{}, err
	}
	req, err := normalizeDramaStudioBatch(req)
	if err != nil {
		return DramaStudioBatchView{}, err
	}
	if req.BaseRevision == nil || req.ConfirmationToken == "" {
		return DramaStudioBatchView{}, BadAuthRequest("请先预检并确认本批次操作")
	}
	var plan dramaStudioBatchPlan
	err = s.repo.Transaction(func(tx *repository.Repository) error {
		if _, err := tx.DramaProductionForUpdate(projectID); err != nil {
			return err
		}
		var err error
		plan, err = s.prepareDramaStudioBatch(tx, userID, projectID, req)
		if err != nil {
			return err
		}
		if plan.view.Counts["ready"] == 0 {
			if plan.view.Counts["already_queued"]+plan.view.Counts["skipped_ready"] == len(plan.view.Items) {
				return nil
			}
			if *req.BaseRevision != plan.view.BaseRevision || !plan.aggregateBlocked && req.ConfirmationToken != plan.view.ConfirmationToken {
				return dramaStudioBatchConflict(&plan.view, "内容、依赖或报价已改变，本批次未入队，请重新预检")
			}
			return nil
		}
		if *req.BaseRevision != plan.view.BaseRevision || req.ConfirmationToken != plan.view.ConfirmationToken {
			return dramaStudioBatchConflict(&plan.view, "内容、依赖或报价已改变，本批次未入队，请重新预检")
		}
		if err := tx.RestrictDramaImplicitMedia(projectID); err != nil {
			return err
		}
		plan.production.MediaRequestsOnly = true
		indexes := make([]int, 0, plan.view.Counts["ready"])
		for i, item := range plan.view.Items {
			if item.Status == "ready" {
				indexes = append(indexes, i)
			}
		}
		// 续接批次先写后段，避免前段失效后段的版本使同批请求发生自冲突。
		sort.SliceStable(indexes, func(i, j int) bool {
			a, b := plan.view.Items[indexes[i]], plan.view.Items[indexes[j]]
			if a.EpisodeID == b.EpisodeID && a.SegmentIndex != nil && b.SegmentIndex != nil {
				return *a.SegmentIndex > *b.SegmentIndex
			}
			return a.EpisodeID < b.EpisodeID
		})
		for _, index := range indexes {
			item := &plan.view.Items[index]
			action := req.Action
			if action == "segment_assets" {
				action = "cast_image"
			}
			if err := applyDramaStudioAction(tx, action, plan.plans[item.TargetID]); err != nil {
				return err
			}
			item.Status, item.Reason = "queued", "已加入生成队列"
		}
		return nil
	})
	if err != nil {
		// 任意入队写失败时外层事务已整体回滚，不能回显循环中暂时标记的 queued。
		for i := range plan.view.Items {
			if plan.view.Items[i].Status == "queued" {
				plan.view.Items[i].Status = "ready"
			}
		}
		var appErr *AppError
		if errors.As(err, &appErr) && appErr.Details != nil {
			return plan.view, err
		}
		if errors.Is(err, repository.ErrDramaGuideChanged) || appErr != nil && appErr.Status == 409 {
			return plan.view, dramaStudioBatchConflict(&plan.view, "目标状态已改变，本批次已回滚，请重新预检")
		}
		for i := range plan.view.Items {
			if plan.view.Items[i].Status == "ready" {
				plan.view.Items[i].Status, plan.view.Items[i].Reason = "failed", "本批次入队失败，全部操作已回滚"
			}
		}
		plan.summarize()
		failure := WrapAppError(500, "本批次入队失败，全部操作已回滚", err)
		failure.Details = map[string]any{"batch": plan.view}
		return plan.view, failure
	}
	if plan.view.Counts["ready"] > 0 {
		plan.summarize()
		plan.view.Warnings, plan.view.DispatchPending = s.finishDramaStudioEnqueue(plan.production)
	}
	return plan.view, nil
}

// 入队已经持久化后，恢复制作失败只能报告“待调度”，不能把成功入队伪装成未提交。
func (s *Service) finishDramaStudioEnqueue(p *model.DramaProduction) ([]string, bool) {
	if err := s.requestDramaWork(p); err != nil {
		slog.Warn("drama scoped work queued but resume failed", "project", p.ProjectID, "error", err)
		return []string{"任务已加入队列，恢复制作失败，请点击继续制作重试；无需重新提交生成"}, true
	}
	return nil, false
}
