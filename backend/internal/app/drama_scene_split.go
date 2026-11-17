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

func dramaSceneRange(shots []model.DramaShot, ids []string) ([]model.DramaShot, error) {
	if len(ids) == 0 || len(ids) > production.MaxScriptShots {
		return nil, BadAuthRequest("请选择一个完整段的全部镜头")
	}
	start := -1
	for i, shot := range shots {
		if shot.ID == ids[0] {
			start = i
			break
		}
	}
	if start < 0 || start+len(ids) > len(shots) {
		return nil, BadAuthRequest("本段镜头已变化，请刷新后重试")
	}
	segmentIndex := shots[start].SegmentIndex
	for i, id := range ids {
		if shots[start+i].ID != id || shots[start+i].SegmentIndex != segmentIndex {
			return nil, BadAuthRequest("请按原顺序选择同一完整段的全部镜头")
		}
	}
	for i, shot := range shots {
		if shot.SegmentIndex == segmentIndex && (i < start || i >= start+len(ids)) {
			return nil, BadAuthRequest("重拆需要包含本段全部镜头")
		}
	}
	return shots[start : start+len(ids)], nil
}

func dramaSceneSourceHash(p model.DramaProduction, episode model.DramaEpisode, shots []model.DramaShot, segments []model.DramaSegment) string {
	return dramaShotMediaDigest([]any{p.Revision, p.SettingsJSON, episode.Revision, episode.SettingsJSON, shots, segments})
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
	if _, err := dramaSceneSourceScenes(group); err != nil {
		return plan, err
	}
	if len(shots)-len(group)+req.TargetShotCount > production.MaxScriptShots {
		return plan, BadAuthRequest("重拆后单集镜头总数不能超过240")
	}
	segments, err := repo.DramaSegments(episodeID)
	if err != nil {
		return plan, err
	}
	var sourceSegment *model.DramaSegment
	for i := range segments {
		if segments[i].SegmentIndex == group[0].SegmentIndex {
			sourceSegment = &segments[i]
			break
		}
	}
	if sourceSegment == nil {
		return plan, BadAuthRequest("原段缺失，请先修复本集分镜")
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
	settings, _ := dramaEpisodeStyleSettings(parseDramaSettings(p.SettingsJSON), dramaBibleMeta{}, *episode)
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
	rules.ShotCountMode = production.ShotCountFixed
	settings.Storyboard = rules
	cast, err := repo.DramaCasts(projectID)
	if err != nil {
		return plan, err
	}
	castJSON, _ := json.Marshal(cast)
	// The selected saved shots are the bounded source. No unrelated chapter is
	// supplied, and the model cannot expand the operation into a whole episode.
	source, _ := json.Marshal(group)
	prompt := production.ScriptPrompt(production.ScriptContext{Title: "本段分镜重拆", EpisodeNumber: episode.Number, EpisodeTitle: episode.Title, Settings: settings.Settings, SourceFormat: production.SourceScript, Skill: skill, CastSummary: string(castJSON), SourceChapters: []production.Chapter{{Title: group[0].SegmentTitle, Text: string(source)}}})
	scenes := []string{}
	for _, shot := range group {
		if !containsString(scenes, shot.Scene) {
			scenes = append(scenes, shot.Scene)
		}
	}
	sceneJSON, _ := json.Marshal(scenes)
	prompt += fmt.Sprintf("\n【本段重拆的优先约束】\n仅重拆上述原第%d段的全部镜头；恰好%d镜，所有输出仍属于该原段。scene只能使用源段已有场景%s，保留本段场景转换，不能引入其他段场景。角色、造型、道具仅能引用已存在名称，不得新增或猜测资产。不得改写、遗漏或新增台词及说话人，不得将其他段剧情或台词移入。段边界与其他段镜头保持不变。用户要求：%s\n", sourceSegment.SegmentIndex+1, req.TargetShotCount, sceneJSON, strings.TrimSpace(req.Instruction))
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
