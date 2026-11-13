package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"gorm.io/gorm"
	"yingce/backend/internal/model"
	"yingce/backend/internal/production"
	"yingce/backend/internal/protocol"
	"yingce/backend/internal/repository"
)

type DramaShotMediaConfig struct {
	Model                DramaModelChoice `json:"model"`
	Prompt               string           `json:"prompt"`
	Operation            string           `json:"operation"`
	AspectRatio          string           `json:"aspectRatio"`
	Resolution           string           `json:"resolution"`
	Seconds              int              `json:"seconds,omitempty"`
	GenerateAudio        bool             `json:"generateAudio"`
	ReferenceResourceIDs []string         `json:"referenceResourceIds"`
	FirstFrameResourceID string           `json:"firstFrameResourceId,omitempty"`
	LastFrameResourceID  string           `json:"lastFrameResourceId,omitempty"`
	AudioVoice           string           `json:"audioVoice,omitempty"`
	AudioInstructions    string           `json:"audioInstructions,omitempty"`
}

type DramaShotMediaSaveRequest struct {
	ExpectedRevision *int64               `json:"expectedRevision"`
	Config           DramaShotMediaConfig `json:"config"`
}

type DramaShotMediaActionRequest struct {
	ExpectedRevision  *int64 `json:"expectedRevision"`
	BaseRevision      *int64 `json:"baseRevision,omitempty"`
	ConfirmationToken string `json:"confirmationToken,omitempty"`
	ClientOperationID string `json:"clientOperationId,omitempty"`
}

type DramaShotMediaAdoptRequest struct {
	ExpectedRevision *int64 `json:"expectedRevision"`
	TakeID           string `json:"takeId"`
}

type DramaShotMediaTakeView struct {
	model.DramaTake
	Status  string `json:"status"`
	Current bool   `json:"current"`
	Error   string `json:"error,omitempty"`
}

type DramaShotMediaView struct {
	model.DramaShotMedia
	Config DramaShotMediaConfig     `json:"config"`
	Takes  []DramaShotMediaTakeView `json:"takes"`
	Error  string                   `json:"error,omitempty"`
}

type DramaShotMediaPreflight struct {
	ShotID             string               `json:"shotId"`
	Kind               string               `json:"kind"`
	Revision           int64                `json:"revision"`
	BaseRevision       int64                `json:"baseRevision"`
	Ready              bool                 `json:"ready"`
	Reason             string               `json:"reason,omitempty"`
	AmountMicrocredits int64                `json:"amountMicrocredits"`
	Priced             bool                 `json:"priced"`
	Estimated          bool                 `json:"estimated"`
	ConfirmationToken  string               `json:"confirmationToken"`
	Config             DramaShotMediaConfig `json:"config"`
}

type dramaShotMediaPlan struct {
	view       DramaShotMediaPreflight
	row        model.DramaShotMedia
	shot       model.DramaShot
	production model.DramaProduction
	request    CreateTaskRequest
}

func validDramaShotMediaKind(kind string) bool {
	return kind == "image" || kind == "video" || kind == "audio"
}

func dramaShotScriptHash(shot model.DramaShot) string {
	// Ordering and timestamps are persistence metadata. Reindexing an unrelated
	// scene must not invalidate saved media; script and dependency fields remain.
	shot.CreatedAt, shot.UpdatedAt = time.Time{}, time.Time{}
	shot.Position = 0
	return dramaShotMediaDigest(shot)
}

func dramaShotMediaDigest(value any) string {
	encoded, _ := json.Marshal(value)
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:])
}

func (s *Service) dramaShotMediaScope(userID, projectID, shotID, kind string) (*model.DramaShot, *model.DramaProduction, error) {
	if !validDramaShotMediaKind(kind) {
		return nil, nil, BadAuthRequest("镜头媒体类型无效")
	}
	_, production, err := s.dramaForUser(userID, projectID)
	if err != nil {
		return nil, nil, err
	}
	shot, err := s.repo.DramaShot(projectID, shotID)
	return shot, production, err
}

func defaultDramaShotMediaConfig(shot model.DramaShot, p model.DramaProduction, kind string) DramaShotMediaConfig {
	if kind == "audio" {
		return DramaShotMediaConfig{Prompt: shot.Dialogue, Operation: "audio", ReferenceResourceIDs: []string{}}
	}
	settings := parseDramaSettings(p.SettingsJSON)
	config := DramaShotMediaConfig{Model: settings.Models.Image, Prompt: shot.ImagePrompt, Operation: "text_to_image", AspectRatio: settings.AspectRatio, Resolution: "1K", ReferenceResourceIDs: []string{}}
	if kind == "video" {
		config.Model, config.Prompt, config.Operation = settings.Models.Video, shot.VideoPrompt, "text_to_video"
		config.Resolution = settings.VideoResolution
		config.Seconds = max(1, int((shot.DurationMs+999)/1000))
	}
	return config
}

func (s *Service) loadDramaShotMedia(repo *repository.Repository, shot model.DramaShot, p model.DramaProduction, kind string) (model.DramaShotMedia, DramaShotMediaConfig, error) {
	row, err := repo.DramaShotMedia(shot.ProjectID, shot.ID, kind)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return model.DramaShotMedia{ProjectID: shot.ProjectID, EpisodeID: shot.EpisodeID, ShotID: shot.ID, Kind: kind, Status: "idle"}, defaultDramaShotMediaConfig(shot, p, kind), nil
	}
	if err != nil {
		return model.DramaShotMedia{}, DramaShotMediaConfig{}, err
	}
	var config DramaShotMediaConfig
	if err := json.Unmarshal([]byte(row.ConfigJSON), &config); err != nil {
		return *row, config, errors.New("镜头媒体配置损坏，请重新保存")
	}
	return *row, config, nil
}

// Config saves are separate from generation. They never reserve credits or
// release the existing segment pipeline.
func (s *Service) SaveDramaShotMedia(userID, projectID, shotID, kind string, req DramaShotMediaSaveRequest) (DramaShotMediaView, error) {
	_, _, err := s.dramaShotMediaScope(userID, projectID, shotID, kind)
	if err != nil {
		return DramaShotMediaView{}, err
	}
	if req.ExpectedRevision == nil || *req.ExpectedRevision < 0 {
		return DramaShotMediaView{}, BadAuthRequest("请提供镜头媒体版本")
	}
	config, err := s.normalizeDramaShotMediaConfig(s.repo, userID, kind, req.Config)
	if err != nil {
		return DramaShotMediaView{}, err
	}
	err = s.repo.Transaction(func(repo *repository.Repository) error {
		p, err := repo.DramaProductionForUpdate(projectID)
		if err != nil {
			return err
		}
		shot, err := repo.DramaShot(projectID, shotID)
		if err != nil {
			return err
		}
		if err := repo.LockDramaCastImageReferences(userID, dramaShotMediaReferenceIDs(config)); err != nil {
			return BadAuthRequest("参考图或首尾帧已变化，请重新选择")
		}
		config, err = s.normalizeDramaShotMediaConfig(repo, userID, kind, config)
		if err != nil {
			return err
		}
		row, _, err := s.loadDramaShotMedia(repo, *shot, *p, kind)
		if err != nil {
			return err
		}
		if row.Revision != *req.ExpectedRevision {
			return repository.ErrDramaShotMediaChanged
		}
		if row.TaskID != "" {
			task, err := repo.TaskForUser(userID, row.TaskID)
			if err != nil {
				return err
			}
			if !dramaShotMediaTaskTerminal(task.Status) {
				return dramaGuideConflict("本镜头媒体正在排队或生成，请等待完成后修改配置")
			}
		}
		if row.ID == "" {
			row.ID, row.CreatedAt = newID(), time.Now()
		}
		encoded, _ := json.Marshal(config)
		row.ConfigJSON, row.Revision, row.TaskID = string(encoded), row.Revision+1, ""
		row.Status, row.ScriptHash, row.UpdatedAt = "idle", dramaShotScriptHash(*shot), time.Now()
		if row.ResourceID != "" {
			row.Status = "stale"
		}
		return repo.SaveDramaShotMediaConfig(&row, *req.ExpectedRevision)
	})
	if err != nil {
		return DramaShotMediaView{}, dramaShotMediaError(err)
	}
	return s.DramaShotMedia(userID, projectID, shotID, kind)
}

func dramaShotMediaReferenceIDs(config DramaShotMediaConfig) []string {
	ids := append([]string{}, config.ReferenceResourceIDs...)
	for _, id := range []string{config.FirstFrameResourceID, config.LastFrameResourceID} {
		if id != "" {
			ids = append(ids, id)
		}
	}
	return ids
}

func (s *Service) normalizeDramaShotMediaConfig(repo *repository.Repository, userID, kind string, config DramaShotMediaConfig) (DramaShotMediaConfig, error) {
	if kind == "audio" {
		return normalizeDramaShotAudioConfig(config)
	}
	if config.AudioVoice != "" || config.AudioInstructions != "" {
		return config, BadAuthRequest("音色与演绎要求只用于独立镜头音频")
	}
	config.Prompt = strings.TrimSpace(config.Prompt)
	config.FirstFrameResourceID = strings.TrimSpace(config.FirstFrameResourceID)
	config.LastFrameResourceID = strings.TrimSpace(config.LastFrameResourceID)
	if utf8.RuneCountInString(config.Prompt) > 50000 {
		return config, BadAuthRequest("镜头提示词过长")
	}
	if len(config.ReferenceResourceIDs) > 20 {
		return config, BadAuthRequest("参考图最多 20 张")
	}
	if kind == "image" && (config.FirstFrameResourceID != "" || config.LastFrameResourceID != "") {
		return config, BadAuthRequest("首尾帧只用于镜头视频")
	}
	validOperation := kind == "image" && (config.Operation == "text_to_image" || config.Operation == "image_to_image") || kind == "video" && (config.Operation == "text_to_video" || config.Operation == "image_to_video" || config.Operation == "reference_to_video")
	if !validOperation {
		return config, BadAuthRequest("镜头生成模式无效")
	}
	if config.Seconds < 0 || config.Seconds > 600 {
		return config, BadAuthRequest("镜头视频时长无效")
	}
	refs := make([]string, 0, len(config.ReferenceResourceIDs))
	seen := map[string]bool{}
	for _, id := range config.ReferenceResourceIDs {
		id = strings.TrimSpace(id)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		refs = append(refs, id)
	}
	config.ReferenceResourceIDs = refs
	if kind == "image" && config.Operation == "image_to_image" && len(refs) == 0 {
		return config, BadAuthRequest("参考图生图需要至少一张参考图片")
	}
	if kind == "video" && config.Operation != "text_to_video" && len(refs) == 0 && config.FirstFrameResourceID == "" && config.LastFrameResourceID == "" {
		return config, BadAuthRequest("所选视频模式需要参考图片或首尾帧")
	}
	for _, id := range append(append([]string{}, refs...), config.FirstFrameResourceID, config.LastFrameResourceID) {
		if id == "" {
			continue
		}
		resource, err := repo.ResourceForUser(userID, id)
		if err != nil || resource.Status != model.ResourceStatusReady || resource.Kind != "image" || !strings.HasPrefix(resource.MimeType, "image/") {
			return config, BadAuthRequest("参考图或首尾帧不存在、未就绪或不属于当前账号")
		}
	}
	if kind == "video" {
		frames := config.FirstFrameResourceID != "" || config.LastFrameResourceID != ""
		if frames && config.Operation != "image_to_video" {
			return config, BadAuthRequest("首尾帧需要选择图生视频模式")
		}
		if config.Operation == "text_to_video" && len(refs) > 0 {
			return config, BadAuthRequest("文生视频不能携带参考图")
		}
	} else if config.Operation == "text_to_image" && len(refs) > 0 {
		return config, BadAuthRequest("文生图不能携带参考图，请选择参考图生图")
	}
	return config, nil
}

func (s *Service) PreflightDramaShotMedia(userID, projectID, shotID, kind string, req DramaShotMediaActionRequest) (DramaShotMediaPreflight, error) {
	if _, _, err := s.dramaShotMediaScope(userID, projectID, shotID, kind); err != nil {
		return DramaShotMediaPreflight{}, err
	}
	plan, err := s.prepareDramaShotMedia(s.repo, userID, projectID, shotID, kind, req)
	return plan.view, dramaShotMediaError(err)
}

func (s *Service) prepareDramaShotMedia(repo *repository.Repository, userID, projectID, shotID, kind string, req DramaShotMediaActionRequest) (dramaShotMediaPlan, error) {
	plan := dramaShotMediaPlan{view: DramaShotMediaPreflight{ShotID: shotID, Kind: kind}}
	shot, err := repo.DramaShot(projectID, shotID)
	if err != nil {
		return plan, err
	}
	p, err := repo.DramaProduction(projectID)
	if err != nil {
		return plan, err
	}
	plan.shot, plan.production = *shot, *p
	row, config, err := s.loadDramaShotMedia(repo, *shot, *p, kind)
	if err != nil {
		return plan, err
	}
	plan.row, plan.view.Revision, plan.view.BaseRevision, plan.view.Config = row, row.Revision, p.Revision, config
	if req.ExpectedRevision != nil && *req.ExpectedRevision != row.Revision || req.BaseRevision != nil && *req.BaseRevision != p.Revision {
		return plan, repository.ErrDramaShotMediaChanged
	}
	blocked := func(reason string) (dramaShotMediaPlan, error) { plan.view.Reason = reason; return plan, nil }
	if row.ID == "" {
		return blocked("请先保存本镜头的生成配置")
	}
	if dramaGuideActive(p) && p.GuideStep != model.DramaGuideStory {
		return blocked("请先完成资产与分镜文字确认")
	}
	if row.TaskID != "" {
		task, err := repo.TaskForUser(userID, row.TaskID)
		if err != nil {
			return plan, err
		}
		if !dramaShotMediaTaskTerminal(task.Status) {
			return blocked("本镜头媒体正在排队或生成")
		}
	}
	config, err = s.normalizeDramaShotMediaConfig(repo, userID, kind, config)
	if err != nil {
		return blocked(err.Error())
	}
	if config.Model.Empty() || config.Prompt == "" {
		return blocked("请填写镜头提示词并选择模型")
	}
	input, err := s.dramaShotMediaInput(repo, userID, *shot, kind, config)
	if err != nil {
		return plan, err
	}
	// Keep the logical choice unresolved for CreateTask. Passing the resolved
	// channel beside logicalModelId would turn it into a conflicting selection.
	requestInputJSON, _ := json.Marshal(input)
	var requestInput map[string]any
	_ = json.Unmarshal(requestInputJSON, &requestInput)
	frontendEnabled, err := s.FeatureEnabled(FeatureFrontendModels)
	if err != nil {
		return plan, err
	}
	_, input, err = s.resolveTaskModelSelection(userID, input, config.Model.LogicalModelID, "canvas_"+kind, config.Operation, frontendEnabled)
	if err != nil {
		return blocked(err.Error())
	}
	if err := s.ValidateTaskCapability(input); err != nil {
		return blocked(err.Error())
	}
	if kind == "video" {
		if err := s.validateDramaShotMediaFrameProtocol(input); err != nil {
			return blocked(err.Error())
		}
	}
	intent := ModelRequestIntentFromTaskInput(input, "canvas_"+kind, config.Operation)
	var quote *LogicalModelQuote
	if config.Model.LogicalModelID != "" {
		quote, err = s.QuoteLogicalModel(userID, config.Model.LogicalModelID, intent)
	} else {
		quote, err = s.QuoteChannelModel(userID, ChannelModelQuoteRequest{ChannelID: config.Model.ChannelID, ModelKey: config.Model.ModelKey, Intent: intent})
	}
	if err != nil || quote == nil {
		return blocked("当前镜头参数无法取得有效报价")
	}
	plan.view.AmountMicrocredits, plan.view.Priced, plan.view.Estimated = quote.AmountMicrocredits, true, quote.Estimated
	if p.BudgetMicrocredits > 0 {
		totals, err := s.dramaBillingTotals(p)
		if err != nil {
			return plan, err
		}
		if totals.ChargedMicrocredits()+totals.HeldMicrocredits()+quote.AmountMicrocredits > p.BudgetMicrocredits {
			return blocked("剩余制作预算不足")
		}
	}
	plan.view.Ready = true
	// The digest never contains credentials or signed URLs. Resource identities
	// and normalized parameters are immutable inputs; the real request is private.
	plan.view.ConfirmationToken = dramaShotMediaDigest([]any{projectID, shot, row, config, p.Revision, p.GuideStep, quote, intent})
	plan.request = CreateTaskRequest{ProjectID: projectID, Type: "canvas_" + kind, Operation: config.Operation, Prompt: stringValue(requestInput["prompt"]), LogicalModelID: config.Model.LogicalModelID, Model: config.Model.ModelKey, Input: requestInput}
	return plan, nil
}

func (s *Service) dramaShotMediaInput(repo *repository.Repository, userID string, shot model.DramaShot, kind string, config DramaShotMediaConfig) (map[string]any, error) {
	if kind == "audio" {
		return dramaShotAudioInput(shot, config), nil
	}
	providerConfig := map[string]any{"size": config.AspectRatio, "count": "1"}
	if config.Model.ChannelID != "" {
		providerConfig["channelId"], providerConfig["model"], providerConfig["channelModelKey"] = config.Model.ChannelID, config.Model.ModelKey, config.Model.ModelKey
	}
	metadata := map[string]any{"source": "drama_shot_media", "domainProjectId": shot.ProjectID, "episodeId": shot.EpisodeID, "dramaShotId": shot.ID}
	if kind == "image" {
		providerConfig["imageResolution"] = config.Resolution
	} else {
		providerConfig["vquality"], providerConfig["videoSeconds"], providerConfig["videoGenerateAudio"] = config.Resolution, strconv.Itoa(config.Seconds), strconv.FormatBool(config.GenerateAudio)
		metadata["videoEditOperation"] = config.Operation
	}
	refs := []any{}
	add := func(id, role string) error {
		if id == "" {
			return nil
		}
		resource, err := repo.ResourceForUser(userID, id)
		if err != nil || resource.Kind != "image" || resource.Status != model.ResourceStatusReady {
			return BadAuthRequest("参考图片不可用")
		}
		refs = append(refs, map[string]any{"id": id, "name": id, "type": resource.MimeType, "mimeType": resource.MimeType, "storageKey": "resource:" + id, "bytes": resource.Size, "width": resource.Width, "height": resource.Height, "role": role})
		return nil
	}
	for _, id := range config.ReferenceResourceIDs {
		if err := add(id, "reference_image"); err != nil {
			return nil, err
		}
	}
	for _, frame := range []struct{ id, role, key string }{{config.FirstFrameResourceID, "first_frame", "videoStartFrameNodeId"}, {config.LastFrameResourceID, "last_frame", "videoEndFrameNodeId"}} {
		if err := add(frame.id, frame.role); err != nil {
			return nil, err
		}
		if frame.id != "" {
			metadata[frame.key] = frame.id
		}
	}
	prompt := config.Prompt
	if kind == "video" {
		if rule := production.CameraPresetRule(shot.Camera); rule != "" {
			prompt += "\n运镜要求：" + rule
		}
	}
	return map[string]any{"mode": kind, "prompt": prompt, "config": providerConfig, "referenceImages": refs, "metadata": metadata}, nil
}

// BuildCreate is a local protocol translation, not an upstream request. This
// catches providers that reject a last frame or frame/reference combinations
// before admission; it uses placeholders rather than reading media or signing URLs.
func (s *Service) validateDramaShotMediaFrameProtocol(input map[string]any) error {
	encoded, _ := json.Marshal(input)
	var generation canvasGenerationInput
	if err := json.Unmarshal(encoded, &generation); err != nil {
		return err
	}
	if metadataString(generation.Metadata, "videoStartFrameNodeId") == "" && metadataString(generation.Metadata, "videoEndFrameNodeId") == "" {
		return nil
	}
	adapter, ok := s.protocolRegistry().Resolve(generation.Config.InterfaceType)
	if !ok {
		return BadAuthRequest("当前视频模型未提供可验证的首尾帧协议")
	}
	for index := range generation.ReferenceImages {
		generation.ReferenceImages[index].URL = fmt.Sprintf("https://shot-media.invalid/image/%d.png", index)
	}
	request := protocolRequestFromInput(generation)
	spec, err := adapter.BuildCreate(context.Background(), protocol.RequestContext{BaseURL: generation.Config.BaseURL, Request: request})
	if err != nil {
		return err
	}
	encodedSpec, _ := json.Marshal(spec)
	for index, image := range request.Images {
		if image.Role != "first_frame" && image.Role != "last_frame" {
			continue
		}
		// A successful translation that discards the image or treats it exactly
		// like an ordinary reference has not implemented frame semantics.
		if !strings.Contains(string(encodedSpec), image.URL) {
			return BadAuthRequest("当前模型协议不支持所选首尾帧组合")
		}
		probe := request
		probe.Images = append([]protocol.MediaReference{}, request.Images...)
		probe.Images[index].Role = "reference_image"
		probe.Inputs = append([]protocol.MediaReference{}, probe.Images...)
		changed, probeErr := adapter.BuildCreate(context.Background(), protocol.RequestContext{BaseURL: generation.Config.BaseURL, Request: probe})
		if probeErr == nil && dramaShotMediaDigest(changed) == dramaShotMediaDigest(spec) {
			return BadAuthRequest("当前模型协议未声明所选首帧或尾帧能力")
		}
	}
	return nil
}

func dramaShotMediaTaskTerminal(status model.TaskStatus) bool {
	return status == model.TaskStatusSucceeded || status == model.TaskStatusFailed || status == model.TaskStatusCancelled
}

func dramaShotMediaError(err error) error {
	if errors.Is(err, repository.ErrDramaShotMediaChanged) {
		return dramaGuideConflict(err.Error())
	}
	return err
}
