package app

import (
	"encoding/json"
	"fmt"
	"strings"
	"unicode/utf8"

	"yingce/backend/internal/model"
	"yingce/backend/internal/production"
	"yingce/backend/internal/repository"
)

type DramaSceneSplitRequest struct {
	ExpectedRevision  *int64           `json:"expectedRevision"`
	EpisodeRevision   *int64           `json:"episodeRevision"`
	ShotIDs           []string         `json:"shotIds"`
	TargetShotCount   int              `json:"targetShotCount"`
	DirectorTemplate  string           `json:"directorTemplate"`
	Instruction       string           `json:"instruction"`
	Model             DramaModelChoice `json:"model"`
	ConfirmationToken string           `json:"confirmationToken,omitempty"`
	ClientOperationID string           `json:"clientOperationId,omitempty"`
}

type DramaSceneSplitPreflight struct {
	Ready              bool   `json:"ready"`
	Reason             string `json:"reason,omitempty"`
	AmountMicrocredits int64  `json:"amountMicrocredits"`
	Priced             bool   `json:"priced"`
	Estimated          bool   `json:"estimated"`
	ConfirmationToken  string `json:"confirmationToken"`
}

type dramaSceneSplitMetadata struct {
	Source          string   `json:"source"`
	EpisodeID       string   `json:"episodeId"`
	ShotIDs         []string `json:"shotIds"`
	SourceHash      string   `json:"sourceHash"`
	TargetShotCount int      `json:"targetShotCount"`
	RequestHash     string   `json:"requestHash"`
}

type dramaSceneSplitPlan struct {
	view     DramaSceneSplitPreflight
	request  CreateTaskRequest
	metadata dramaSceneSplitMetadata
}

func dramaSceneKey(shot model.DramaShot) string {
	return shot.SceneCastID + "\x00" + strings.TrimSpace(shot.Scene)
}

func dramaSceneRange(shots []model.DramaShot, ids []string) ([]model.DramaShot, error) {
	if len(ids) == 0 || len(ids) > production.MaxScriptShots {
		return nil, BadAuthRequest("请选择一个完整的连续场景组")
	}
	start := -1
	for i, shot := range shots {
		if shot.ID == ids[0] {
			start = i
			break
		}
	}
	if start < 0 || start+len(ids) > len(shots) {
		return nil, BadAuthRequest("场景组已变化，请刷新后重试")
	}
	key := dramaSceneKey(shots[start])
	for i, id := range ids {
		if shots[start+i].ID != id || dramaSceneKey(shots[start+i]) != key {
			return nil, BadAuthRequest("请选择一个完整的连续场景组")
		}
	}
	if start > 0 && dramaSceneKey(shots[start-1]) == key || start+len(ids) < len(shots) && dramaSceneKey(shots[start+len(ids)]) == key {
		return nil, BadAuthRequest("重拆需要包含整个连续场景组")
	}
	return shots[start : start+len(ids)], nil
}

func dramaSceneSourceHash(p model.DramaProduction, episode model.DramaEpisode, shots []model.DramaShot, segments []model.DramaSegment) string {
	return dramaShotMediaDigest([]any{p.Revision, p.SettingsJSON, episode.Revision, shots, segments})
}

func taskHasDramaSceneSplitOrigin(raw string) bool {
	var input struct {
		Metadata struct {
			Source string `json:"source"`
		} `json:"metadata"`
	}
	return json.Unmarshal([]byte(raw), &input) == nil && input.Metadata.Source == "drama_scene_split"
}

func (s *Service) PreflightDramaSceneSplit(userID, projectID, episodeID string, req DramaSceneSplitRequest) (DramaSceneSplitPreflight, error) {
	if _, _, err := s.dramaForUser(userID, projectID); err != nil {
		return DramaSceneSplitPreflight{}, err
	}
	plan, err := s.prepareDramaSceneSplit(s.repo, userID, projectID, episodeID, req)
	return plan.view, dramaGuideError(err)
}

func (s *Service) prepareDramaSceneSplit(repo *repository.Repository, userID, projectID, episodeID string, req DramaSceneSplitRequest) (dramaSceneSplitPlan, error) {
	var plan dramaSceneSplitPlan
	if req.ExpectedRevision == nil || req.EpisodeRevision == nil {
		return plan, BadAuthRequest("请刷新作品与分集当前版本")
	}
	if err := (production.StoryboardSettings{TargetShotCount: req.TargetShotCount, DirectorTemplate: req.DirectorTemplate}).ValidateDirector(); err != nil {
		return plan, BadAuthRequest(err.Error())
	}
	if req.TargetShotCount < 1 || utf8.RuneCountInString(req.Instruction) > 4000 {
		return plan, BadAuthRequest("重拆目标镜头数至少为1，要求不超过4000字")
	}
	p, err := repo.DramaProduction(projectID)
	if err != nil {
		return plan, err
	}
	episode, err := repo.DramaEpisode(projectID, episodeID)
	if err != nil {
		return plan, err
	}
	if p.UserID != userID || p.Revision != *req.ExpectedRevision || episode.Revision != *req.EpisodeRevision {
		return plan, repository.ErrDramaGuideChanged
	}
	shots, err := repo.DramaShots(episodeID)
	if err != nil {
		return plan, err
	}
	group, err := dramaSceneRange(shots, req.ShotIDs)
	if err != nil {
		return plan, err
	}
	if len(shots)-len(group)+req.TargetShotCount > production.MaxScriptShots {
		return plan, BadAuthRequest("重拆后单集镜头总数不能超过240")
	}
	indexes := map[int]bool{}
	for _, shot := range group {
		indexes[shot.SegmentIndex] = true
	}
	if req.TargetShotCount < len(indexes) {
		return plan, BadAuthRequest(fmt.Sprintf("本场景跨%d个剧情段，每段至少保留1镜", len(indexes)))
	}
	segments, err := repo.DramaSegments(episodeID)
	if err != nil {
		return plan, err
	}
	blocked := func(reason string) (dramaSceneSplitPlan, error) { plan.view.Reason = reason; return plan, nil }
	if dramaGuideActive(p) && p.GuideStep != model.DramaGuideStory {
		return blocked("请先完成资产确认与分镜文字制作")
	}
	active, err := repo.DramaSceneSplitActive(projectID, episodeID)
	if err != nil {
		return plan, err
	}
	if active {
		return blocked("有文字或媒体任务正在排队、生成，请完成后重拆")
	}
	settings := parseDramaSettings(p.SettingsJSON)
	if req.Model.Empty() {
		req.Model = settings.Models.textFor(DramaStepScript)
	}
	if req.Model.Empty() {
		return blocked("请选择可用文字模型")
	}
	skill, err := s.dramaWritingSkill(userID, settings.ScriptSkill, "分镜拆分")
	if err != nil {
		return plan, err
	}
	rules := settings.Storyboard
	rules.DirectorTemplate, rules.TargetShotCount = req.DirectorTemplate, req.TargetShotCount
	settings.Storyboard = rules
	cast, err := repo.DramaCasts(projectID)
	if err != nil {
		return plan, err
	}
	castJSON, _ := json.Marshal(cast)
	// The selected saved shots are the bounded source. No unrelated chapter is
	// supplied, and the model cannot expand the operation into a whole episode.
	source, _ := json.Marshal(group)
	prompt := production.ScriptPrompt(production.ScriptContext{Title: "场景范围重拆", EpisodeNumber: episode.Number, EpisodeTitle: episode.Title, Settings: settings.Settings, SourceFormat: production.SourceScript, Skill: skill, CastSummary: string(castJSON), SourceChapters: []production.Chapter{{Title: group[0].Scene, Text: string(source)}}})
	prompt += fmt.Sprintf("\n【范围重拆的优先约束】\n仅重拆上述连续场景，scene必须保持为%s；恰好%d镜，角色、造型、场景、道具仅能引用已存在名称。不得新增或猜测资产，不得改写、遗漏或新增台词。原有剧情段边界与组外镜头保持不变。用户要求：%s\n", group[0].Scene, req.TargetShotCount, strings.TrimSpace(req.Instruction))
	segmentIndexes, allocation, err := dramaSceneSegmentAllocation(group, req.TargetShotCount)
	if err != nil {
		return plan, err
	}
	offset := 0
	for i, count := range allocation {
		prompt += fmt.Sprintf("输出第%d到%d镜属于原第%d段，只能使用该原段内的剧情与台词，不得将其他段的台词移入或将本段台词移出。\n", offset+1, offset+count, segmentIndexes[i]+1)
		offset += count
	}
	config := map[string]any{"thinking": settings.TextThinking.levelFor(DramaStepScript)}
	if req.Model.ChannelID != "" {
		config["channelId"], config["model"], config["channelModelKey"] = req.Model.ChannelID, req.Model.ModelKey, req.Model.ModelKey
	}
	metadata := dramaSceneSplitMetadata{Source: "drama_scene_split", EpisodeID: episodeID, ShotIDs: req.ShotIDs, SourceHash: dramaSceneSourceHash(*p, *episode, shots, segments), TargetShotCount: req.TargetShotCount}
	input := map[string]any{"mode": "text", "prompt": prompt, "config": config, "metadata": metadata}
	encoded, _ := json.Marshal(input)
	var unresolved map[string]any
	_ = json.Unmarshal(encoded, &unresolved)
	frontend, err := s.FeatureEnabled(FeatureFrontendModels)
	if err != nil {
		return plan, err
	}
	_, resolved, err := s.resolveTaskModelSelection(userID, input, req.Model.LogicalModelID, "canvas_text", "text", frontend)
	if err != nil {
		return blocked(err.Error())
	}
	if err := s.ValidateTaskCapability(resolved); err != nil {
		return blocked(err.Error())
	}
	intent := ModelRequestIntentFromTaskInput(resolved, "canvas_text", "text")
	var quote *LogicalModelQuote
	if req.Model.LogicalModelID != "" {
		quote, err = s.QuoteLogicalModel(userID, req.Model.LogicalModelID, intent)
	} else {
		quote, err = s.QuoteChannelModel(userID, ChannelModelQuoteRequest{ChannelID: req.Model.ChannelID, ModelKey: req.Model.ModelKey, Intent: intent})
	}
	if err != nil || quote == nil {
		return blocked("当前文字任务无法取得有效报价")
	}
	if p.BudgetMicrocredits > 0 {
		totals, err := s.dramaBillingTotals(p)
		if err != nil {
			return plan, err
		}
		if totals.ChargedMicrocredits()+totals.HeldMicrocredits()+quote.AmountMicrocredits > p.BudgetMicrocredits {
			return blocked("剩余制作预算不足")
		}
	}
	plan.view.Ready, plan.view.Priced, plan.view.Estimated, plan.view.AmountMicrocredits = true, true, quote.Estimated, quote.AmountMicrocredits
	req.ConfirmationToken, req.ClientOperationID = "", ""
	plan.view.ConfirmationToken = dramaShotMediaDigest([]any{metadata, req, prompt, quote, intent})
	plan.metadata = metadata
	plan.request = CreateTaskRequest{ProjectID: projectID, Type: "canvas_text", Operation: "text", Prompt: prompt, LogicalModelID: req.Model.LogicalModelID, Model: req.Model.ModelKey, Input: unresolved}
	return plan, nil
}
