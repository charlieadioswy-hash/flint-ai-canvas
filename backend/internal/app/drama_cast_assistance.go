package app

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"strings"
	"unicode/utf8"

	"yingce/backend/internal/model"
	"yingce/backend/internal/repository"
)

type DramaCastAssistanceRequest struct {
	Purpose           string           `json:"purpose"`
	ExpectedRevision  *int64           `json:"expectedRevision"`
	CastRevision      *int64           `json:"castRevision"`
	Model             DramaModelChoice `json:"model"`
	Instruction       string           `json:"instruction"`
	SampleText        string           `json:"sampleText"`
	VoiceKey          string           `json:"voiceKey"`
	SourceResourceID  string           `json:"sourceResourceId"`
	ConfirmationToken string           `json:"confirmationToken,omitempty"`
	ClientOperationID string           `json:"clientOperationId,omitempty"`
}

type DramaCastAssistancePreflight struct {
	Ready              bool   `json:"ready"`
	Reason             string `json:"reason,omitempty"`
	AmountMicrocredits int64  `json:"amountMicrocredits"`
	Priced             bool   `json:"priced"`
	Estimated          bool   `json:"estimated"`
	ConfirmationToken  string `json:"confirmationToken"`
}

type DramaCastAssistanceResult struct {
	ID             string           `json:"id"`
	TaskID         string           `json:"taskId"`
	Purpose        string           `json:"purpose"`
	Version        int              `json:"version"`
	Status         model.TaskStatus `json:"status"`
	Progress       int              `json:"progress"`
	Text           string           `json:"text,omitempty"`
	ResourceID     string           `json:"resourceId,omitempty"`
	Error          string           `json:"error,omitempty"`
	SourceRevision int64            `json:"sourceRevision"`
	Stale          bool             `json:"stale"`
	CreatedAt      string           `json:"createdAt"`
}

type dramaCastAssistanceMetadata struct {
	Source         string `json:"source"`
	CastID         string `json:"dramaCastId"`
	Purpose        string `json:"purpose"`
	SourceRevision int64  `json:"sourceRevision"`
	RequestHash    string `json:"requestHash"`
}

type dramaCastAssistancePlan struct {
	view    DramaCastAssistancePreflight
	cast    model.DramaCast
	request CreateTaskRequest
}

func dramaCastAssistanceKind(purpose string) string {
	switch purpose {
	case "voice_sample":
		return "cast_voice"
	case "fill_description":
		return "cast_desc"
	case "image_prompt":
		return "cast_prompt"
	}
	return ""
}

func dramaCastAssistanceDigest(value any) string {
	encoded, _ := json.Marshal(value)
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:])
}

func (s *Service) dramaCastAssistanceScope(userID, projectID, castID string) (*model.DramaCast, error) {
	if _, _, err := s.dramaForUser(userID, projectID); err != nil {
		return nil, err
	}
	return s.repo.DramaCast(projectID, castID)
}

func normalizeDramaCastAssistanceRequest(req DramaCastAssistanceRequest) (DramaCastAssistanceRequest, error) {
	req.Instruction, req.SampleText = strings.TrimSpace(req.Instruction), strings.TrimSpace(req.SampleText)
	req.VoiceKey, req.SourceResourceID = strings.TrimSpace(req.VoiceKey), strings.TrimSpace(req.SourceResourceID)
	if dramaCastAssistanceKind(req.Purpose) == "" {
		return req, BadAuthRequest("不支持的资产辅助任务")
	}
	if req.ExpectedRevision == nil || req.CastRevision == nil {
		return req, BadAuthRequest("请提供作品与资产的当前版本")
	}
	if utf8.RuneCountInString(req.Instruction) > 4000 || utf8.RuneCountInString(req.SampleText) > 1000 || len(req.VoiceKey) > 160 {
		return req, BadAuthRequest("辅助要求不超过 4000 字，试听文本不超过 1000 字")
	}
	if req.Purpose == "voice_sample" && (req.SampleText == "" || req.VoiceKey == "") {
		return req, BadAuthRequest("请填写试听文本并选择音色")
	}
	if req.Purpose != "voice_sample" && (req.SampleText != "" || req.VoiceKey != "") || req.Purpose != "image_prompt" && req.SourceResourceID != "" {
		return req, BadAuthRequest("辅助参数与任务类型不一致")
	}
	return req, nil
}

func (s *Service) PreflightDramaCastAssistance(userID, projectID, castID string, req DramaCastAssistanceRequest) (DramaCastAssistancePreflight, error) {
	if _, err := s.dramaCastAssistanceScope(userID, projectID, castID); err != nil {
		return DramaCastAssistancePreflight{}, err
	}
	plan, err := s.prepareDramaCastAssistance(s.repo, userID, projectID, castID, req)
	return plan.view, dramaGuideError(err)
}

func (s *Service) prepareDramaCastAssistance(repo *repository.Repository, userID, projectID, castID string, raw DramaCastAssistanceRequest) (dramaCastAssistancePlan, error) {
	var plan dramaCastAssistancePlan
	req, err := normalizeDramaCastAssistanceRequest(raw)
	if err != nil {
		return plan, err
	}
	p, err := repo.DramaProduction(projectID)
	if err != nil {
		return plan, err
	}
	cast, err := repo.DramaCast(projectID, castID)
	if err != nil {
		return plan, err
	}
	plan.cast = *cast
	if p.UserID != userID || p.Revision != *req.ExpectedRevision || cast.Revision != *req.CastRevision {
		return plan, repository.ErrDramaGuideChanged
	}
	blocked := func(reason string) (dramaCastAssistancePlan, error) { plan.view.Reason = reason; return plan, nil }
	if req.Purpose == "voice_sample" && (cast.Kind != "character" || cast.ParentID != "") {
		return blocked("声音只能绑定到角色本体，造型沿用本体声音")
	}
	if req.Model.Empty() {
		return blocked("请先选择可用模型")
	}
	active, err := repo.ActiveDramaCastAssistance(projectID, castID, dramaCastAssistanceKind(req.Purpose))
	if err != nil {
		return plan, err
	}
	if active {
		return blocked("该资产已有同类辅助任务排队或生成中")
	}
	settings := parseDramaSettings(p.SettingsJSON)
	stylePrompt := settings.StylePrompt
	if strings.TrimSpace(cast.ImageStylePrompt) != "" {
		stylePrompt = cast.ImageStylePrompt
	}
	mode, prompt, err := dramaCastAssistancePrompt(*cast, req.Purpose, req.Instruction, req.SampleText, stylePrompt)
	if err != nil {
		return plan, err
	}
	config := map[string]any{}
	if req.Model.ChannelID != "" {
		config["channelId"], config["model"], config["channelModelKey"] = req.Model.ChannelID, req.Model.ModelKey, req.Model.ModelKey
	}
	if mode == "audio" {
		config["audioVoice"], config["audioFormat"], config["audioSpeed"] = req.VoiceKey, "mp3", "1"
		config["audioInstructions"] = strings.TrimSpace(strings.Join([]string{cast.VoiceInstructions, req.Instruction}, "\n"))
	}
	metadata := map[string]any{"source": "drama_cast_assistance", "dramaCastId": castID, "purpose": req.Purpose, "sourceRevision": cast.Revision}
	input := map[string]any{"mode": mode, "prompt": prompt, "config": config, "metadata": metadata}
	if req.Purpose == "image_prompt" {
		resource, err := repo.ResourceForUser(userID, req.SourceResourceID)
		if req.SourceResourceID == "" || err != nil || resource.Kind != "image" || resource.Status != model.ResourceStatusReady || !strings.HasPrefix(resource.MimeType, "image/") {
			return blocked("请选择当前账号已就绪的图片作为反推来源")
		}
		input["referenceImages"] = []any{map[string]any{"id": resource.ID, "name": "反推来源图片", "storageKey": "resource:" + resource.ID, "type": resource.MimeType, "mimeType": resource.MimeType, "bytes": resource.Size, "width": resource.Width, "height": resource.Height}}
	}
	encoded, _ := json.Marshal(input)
	var unresolved map[string]any
	_ = json.Unmarshal(encoded, &unresolved)
	frontendEnabled, err := s.FeatureEnabled(FeatureFrontendModels)
	if err != nil {
		return plan, err
	}
	_, resolved, err := s.resolveTaskModelSelection(userID, input, req.Model.LogicalModelID, "canvas_"+mode, mode, frontendEnabled)
	if err != nil {
		return blocked(err.Error())
	}
	if err := s.ValidateTaskCapability(resolved); err != nil {
		return blocked(err.Error())
	}
	intent := ModelRequestIntentFromTaskInput(resolved, "canvas_"+mode, mode)
	var quote *LogicalModelQuote
	if req.Model.LogicalModelID != "" {
		quote, err = s.QuoteLogicalModel(userID, req.Model.LogicalModelID, intent)
	} else {
		quote, err = s.QuoteChannelModel(userID, ChannelModelQuoteRequest{ChannelID: req.Model.ChannelID, ModelKey: req.Model.ModelKey, Intent: intent})
	}
	if err != nil || quote == nil {
		return blocked("当前辅助任务无法取得有效报价")
	}
	plan.view.AmountMicrocredits, plan.view.Priced, plan.view.Estimated = quote.AmountMicrocredits, true, quote.Estimated
	if p.BudgetMicrocredits > 0 {
		totals, err := repo.DramaBillingTotals(userID, []string{projectID})
		if err != nil {
			return plan, err
		}
		spent := totals[projectID]
		if spent.ChargedMicrocredits()+spent.HeldMicrocredits()+quote.AmountMicrocredits > p.BudgetMicrocredits {
			return blocked("剩余制作预算不足")
		}
	}
	req.ConfirmationToken, req.ClientOperationID = "", ""
	plan.view.Ready = true
	plan.view.ConfirmationToken = dramaCastAssistanceDigest([]any{projectID, cast, p.Revision, p.GuideStep, settings.StylePrompt, req, quote, intent})
	plan.request = CreateTaskRequest{ProjectID: projectID, Type: "canvas_" + mode, Operation: mode, Prompt: prompt, LogicalModelID: req.Model.LogicalModelID, Model: req.Model.ModelKey, Input: unresolved}
	return plan, nil
}
