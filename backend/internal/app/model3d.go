package app

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"image"
	"image/png"
	"io"
	"strings"
	"time"
	"unicode/utf8"

	_ "golang.org/x/image/webp"
	"gorm.io/gorm"
	"infinite-canvas/backend/internal/assets"
	"infinite-canvas/backend/internal/model"
	"infinite-canvas/backend/internal/model3d"
	"infinite-canvas/backend/internal/repository"
)

type Model3DParameters = model3d.Parameters
type Model3DProviderRequest struct {
	Name           string   `json:"name"`
	Type           string   `json:"type"`
	Enabled        bool     `json:"enabled"`
	DefaultModel   string   `json:"defaultModel"`
	AllowedModels  []string `json:"allowedModels"`
	AllowedModes   []string `json:"allowedModes"`
	TimeoutSeconds int      `json:"timeoutSeconds"`
	MaxTasksPerDay int      `json:"maxTasksPerDay"`
	APIKey         string   `json:"apiKey,omitempty"`
}
type Model3DProviderView struct {
	ID               string   `json:"id"`
	Name             string   `json:"name"`
	Type             string   `json:"type"`
	Enabled          bool     `json:"enabled"`
	Archived         bool     `json:"archived"`
	ConfigID         string   `json:"configId"`
	Version          int      `json:"version"`
	DefaultModel     string   `json:"defaultModel"`
	AllowedModels    []string `json:"allowedModels"`
	AllowedModes     []string `json:"allowedModes"`
	TimeoutSeconds   int      `json:"timeoutSeconds"`
	MaxTasksPerDay   int      `json:"maxTasksPerDay"`
	APIKeyConfigured bool     `json:"apiKeyConfigured"`
}
type Model3DProviderType struct {
	Type          string                 `json:"type"`
	Label         string                 `json:"label"`
	ModelVersions []model3d.ModelVersion `json:"modelVersions"`
	Modes         []string               `json:"modes"`
}
type Model3DAdminState struct {
	Providers        []Model3DProviderView `json:"providers"`
	ActiveProviderID string                `json:"activeProviderId"`
	ActiveConfigID   string                `json:"activeConfigId"`
	PolicyRevision   int64                 `json:"policyRevision"`
	ProviderTypes    []Model3DProviderType `json:"providerTypes"`
}
type Model3DInputLimits struct {
	MaxBytes     int64    `json:"maxBytes"`
	MimeTypes    []string `json:"mimeTypes"`
	MinViews     int      `json:"minViews"`
	MaxViews     int      `json:"maxViews"`
	RequiredView string   `json:"requiredView"`
}
type Model3DCapabilities struct {
	Available           bool                   `json:"available"`
	ProviderName        string                 `json:"providerName"`
	PolicyRevision      int64                  `json:"policyRevision"`
	ActiveConfigVersion int                    `json:"activeConfigVersion"`
	DefaultModel        string                 `json:"defaultModel"`
	ModelVersions       []model3d.ModelVersion `json:"modelVersions"`
	Modes               []string               `json:"modes"`
	InputLimits         Model3DInputLimits     `json:"inputLimits"`
}
type Model3DViews struct {
	Front string `json:"front"`
	Left  string `json:"left,omitempty"`
	Back  string `json:"back,omitempty"`
	Right string `json:"right,omitempty"`
}
type Model3DCreateRequest struct {
	RequestID              string             `json:"requestId"`
	SourceFingerprint      string             `json:"sourceFingerprint"`
	CanvasID               string             `json:"canvasId"`
	NodeID                 string             `json:"nodeId"`
	Mode                   string             `json:"mode"`
	Prompt                 string             `json:"prompt,omitempty"`
	ImageResourceID        string             `json:"imageResourceId,omitempty"`
	Views                  *Model3DViews      `json:"views,omitempty"`
	Parameters             model3d.Parameters `json:"parameters"`
	ExpectedPolicyRevision *int64             `json:"expectedPolicyRevision"`
}
type model3DReference struct {
	ResourceID      string `json:"resourceId"`
	View            string `json:"view"`
	ResourceVersion string `json:"resourceVersion"`
	ContentHash     string `json:"contentHash"`
}
type model3DClientContext struct {
	CanvasID string `json:"canvasId"`
	NodeID   string `json:"nodeId"`
}
type model3DInput struct {
	ConfigID          string               `json:"configId"`
	Mode              string               `json:"mode"`
	Prompt            string               `json:"prompt,omitempty"`
	Parameters        model3d.Parameters   `json:"parameters"`
	ReferenceImages   []model3DReference   `json:"referenceImages"`
	SourceFingerprint string               `json:"sourceFingerprint"`
	ClientContext     model3DClientContext `json:"metadata"`
}
type Model3DResult struct {
	AssetID    string `json:"assetId"`
	ResourceID string `json:"resourceId"`
	StorageKey string `json:"storageKey"`
	URL        string `json:"url"`
	FileName   string `json:"fileName"`
	MimeType   string `json:"mimeType"`
	Bytes      int64  `json:"bytes"`
	Format     string `json:"format"`
}
type Model3DTaskError struct {
	Code       string `json:"code"`
	Reason     string `json:"reason"`
	Message    string `json:"message"`
	RetryClass string `json:"retryClass"`
}
type Model3DTaskView struct {
	ID                string               `json:"id"`
	Status            model.TaskStatus     `json:"status"`
	Stage             string               `json:"stage"`
	Progress          int                  `json:"progress"`
	Mode              string               `json:"mode"`
	SourceFingerprint string               `json:"sourceFingerprint"`
	ClientContext     model3DClientContext `json:"clientContext"`
	SubmissionOutcome string               `json:"submissionOutcome"`
	CanRetryStorage   bool                 `json:"canRetryStorage"`
	Result            *Model3DResult       `json:"result,omitempty"`
	Error             *Model3DTaskError    `json:"error,omitempty"`
	CreatedAt         time.Time            `json:"createdAt"`
	UpdatedAt         time.Time            `json:"updatedAt"`
}

func model3DError(err error) error {
	switch {
	case errors.Is(err, repository.ErrModel3DConflict):
		return NewAppError(409, "3D 配置或请求已变化，请刷新后重试")
	case errors.Is(err, repository.ErrModel3DUnavailable):
		return NewAppError(503, "3D 生成服务未配置或已停用")
	case errors.Is(err, repository.ErrModel3DBudget):
		return QuotaExceeded("今日 3D 生成任务额度已用完")
	case errors.Is(err, repository.ErrModel3DReferenced):
		return NewAppError(409, "3D 生成正在使用该资源，请等待任务完成")
	case errors.Is(err, gorm.ErrRecordNotFound):
		return NotFound("3D 任务、配置或资源不存在或不可访问")
	default:
		return err
	}
}

func model3DView(provider model.Model3DProvider, config model.Model3DConfig) Model3DProviderView {
	models, modes := []string{}, []string{}
	_ = json.Unmarshal([]byte(config.AllowedModelsJSON), &models)
	_ = json.Unmarshal([]byte(config.AllowedModesJSON), &modes)
	return Model3DProviderView{ID: provider.ID, Name: provider.Name, Type: provider.Type, Enabled: provider.Enabled, Archived: provider.Archived, ConfigID: config.ID, Version: config.Version, DefaultModel: config.DefaultModel, AllowedModels: models, AllowedModes: modes, TimeoutSeconds: config.TimeoutSeconds, MaxTasksPerDay: config.MaxTasksPerDay, APIKeyConfigured: config.APIKeyEncrypted != ""}
}

func (s *Service) model3DDomainConfig(record *model.Model3DConfig) (model3d.Config, error) {
	config := model3d.Config{Type: record.Type, DefaultModel: record.DefaultModel, TimeoutSeconds: record.TimeoutSeconds, MaxTasksPerDay: record.MaxTasksPerDay}
	if err := json.Unmarshal([]byte(record.AllowedModelsJSON), &config.AllowedModels); err != nil {
		return config, err
	}
	if err := json.Unmarshal([]byte(record.AllowedModesJSON), &config.AllowedModes); err != nil {
		return config, err
	}
	key, err := s.decryptSettingSecret(record.APIKeyEncrypted)
	config.APIKey = key
	return config, err
}

func (s *Service) AdminModel3D(actor *model.User) (*Model3DAdminState, error) {
	if err := s.RequireAdmin(actor); err != nil {
		return nil, err
	}
	providers, configs, policy, err := s.repo.Model3DState()
	if err != nil {
		return nil, err
	}
	byID := map[string]model.Model3DConfig{}
	for _, config := range configs {
		byID[config.ID] = config
	}
	state := &Model3DAdminState{Providers: []Model3DProviderView{}, ActiveProviderID: policy.ActiveProviderID, ActiveConfigID: policy.ActiveConfigID, PolicyRevision: policy.Revision, ProviderTypes: []Model3DProviderType{{Type: model3d.ProviderTripo, Label: "Tripo3D", ModelVersions: model3d.Models(), Modes: []string{"text", "image", "multiview"}}}}
	for _, provider := range providers {
		config, ok := byID[provider.LatestConfigID]
		if !ok {
			return nil, NewAppError(503, "3D 配置版本缺失")
		}
		state.Providers = append(state.Providers, model3DView(provider, config))
	}
	return state, nil
}

func (s *Service) SaveModel3DProvider(actor *model.User, id string, req Model3DProviderRequest) (*Model3DProviderView, error) {
	if err := s.RequireAdmin(actor); err != nil {
		return nil, err
	}
	req.Name = strings.TrimSpace(req.Name)
	req.Type = strings.TrimSpace(req.Type)
	if req.Name == "" || utf8.RuneCountInString(req.Name) > 120 {
		return nil, BadAuthRequest("Provider 名称须为 1–120 字")
	}
	provider := model.Model3DProvider{ID: id, Name: req.Name, Type: req.Type, Enabled: req.Enabled}
	previous := ""
	version := 1
	config := model3d.Config{Type: req.Type, APIKey: strings.TrimSpace(req.APIKey), DefaultModel: req.DefaultModel, AllowedModels: req.AllowedModels, AllowedModes: req.AllowedModes, TimeoutSeconds: req.TimeoutSeconds, MaxTasksPerDay: req.MaxTasksPerDay}
	if id != "" {
		current, err := s.repo.Model3DProvider(id)
		if err != nil {
			return nil, model3DError(err)
		}
		if current.Archived || current.Type != req.Type {
			return nil, BadAuthRequest("平台类型不可修改，已归档 Provider 不可编辑")
		}
		provider.CreatedAt = current.CreatedAt
		previous = current.LatestConfigID
		old, err := s.repo.Model3DConfig(previous)
		if err != nil {
			return nil, model3DError(err)
		}
		version = old.Version + 1
		if config.APIKey == "" {
			config.APIKey, err = s.decryptSettingSecret(old.APIKeyEncrypted)
			if err != nil {
				return nil, NewAppError(503, "旧凭据无法解密，请重新填写 API Key")
			}
		}
	} else {
		provider.ID = newID()
	}
	if err := model3d.ValidateConfig(config); err != nil {
		return nil, BadAuthRequest(err.Error())
	}
	encrypted, err := s.encryptSettingSecret(config.APIKey)
	if err != nil {
		return nil, err
	}
	modelsJSON, _ := json.Marshal(config.AllowedModels)
	modesJSON, _ := json.Marshal(config.AllowedModes)
	record := model.Model3DConfig{ID: newID(), ProviderID: provider.ID, Version: version, Type: config.Type, DefaultModel: config.DefaultModel, AllowedModelsJSON: string(modelsJSON), AllowedModesJSON: string(modesJSON), TimeoutSeconds: config.TimeoutSeconds, MaxTasksPerDay: config.MaxTasksPerDay, APIKeyEncrypted: encrypted, CreatedBy: actor.ID}
	provider.LatestConfigID = record.ID
	audit, err := newAdminAuditEvent(actor, "model3d.configure", "model3d_provider", provider.ID, "保存 3D 生成配置", map[string]any{"configId": record.ID, "version": record.Version, "enabled": provider.Enabled})
	if err != nil {
		return nil, err
	}
	if err := s.repo.SaveModel3DProvider(&provider, &record, previous, audit); err != nil {
		return nil, model3DError(err)
	}
	view := model3DView(provider, record)
	return &view, nil
}

func (s *Service) ActivateModel3DProvider(actor *model.User, id, configID string, expected int64) (*Model3DAdminState, error) {
	if err := s.RequireAdmin(actor); err != nil {
		return nil, err
	}
	record, err := s.repo.Model3DConfig(configID)
	if err != nil {
		return nil, model3DError(err)
	}
	if record.ProviderID != id {
		return nil, BadAuthRequest("配置版本不属于该 Provider")
	}
	config, err := s.model3DDomainConfig(record)
	if err != nil {
		return nil, NewAppError(503, "3D 凭据无法解密")
	}
	if err := model3d.ValidateConfig(config); err != nil {
		return nil, BadAuthRequest(err.Error())
	}
	audit, err := newAdminAuditEvent(actor, "model3d.activate", "model3d_provider", id, "启用 3D 生成配置", map[string]any{"configId": configID, "previousRevision": expected})
	if err != nil {
		return nil, err
	}
	if err := s.repo.SetModel3DPolicy(id, configID, expected, audit); err != nil {
		return nil, model3DError(err)
	}
	return s.AdminModel3D(actor)
}
func (s *Service) DisableModel3D(actor *model.User, expected int64) (*Model3DAdminState, error) {
	if err := s.RequireAdmin(actor); err != nil {
		return nil, err
	}
	audit, err := newAdminAuditEvent(actor, "model3d.disable", "model3d_policy", "model3d", "停用 3D 生成", nil)
	if err != nil {
		return nil, err
	}
	if err := s.repo.SetModel3DPolicy("", "", expected, audit); err != nil {
		return nil, model3DError(err)
	}
	return s.AdminModel3D(actor)
}
func (s *Service) ArchiveModel3DProvider(actor *model.User, id string) (*Model3DAdminState, error) {
	if err := s.RequireAdmin(actor); err != nil {
		return nil, err
	}
	audit, err := newAdminAuditEvent(actor, "model3d.archive", "model3d_provider", id, "归档 3D 生成 Provider", nil)
	if err != nil {
		return nil, err
	}
	if err := s.repo.ArchiveModel3DProvider(id, audit); err != nil {
		return nil, model3DError(err)
	}
	return s.AdminModel3D(actor)
}

func (s *Service) Model3DCapabilities(userID string) (*Model3DCapabilities, error) {
	if userID == "" {
		return nil, Unauthorized("请先登录")
	}
	view := &Model3DCapabilities{ModelVersions: []model3d.ModelVersion{}, Modes: []string{}, InputLimits: Model3DInputLimits{MaxBytes: model3d.MaxInputBytes, MimeTypes: []string{"image/png", "image/jpeg", "image/webp"}, MinViews: 2, MaxViews: 4, RequiredView: "front"}}
	record, revision, err := s.repo.ActiveModel3DConfig()
	view.PolicyRevision = revision
	if errors.Is(err, repository.ErrModel3DUnavailable) {
		return view, nil
	}
	if err != nil {
		return nil, err
	}
	config, err := s.model3DDomainConfig(record)
	if err != nil || model3d.ValidateConfig(config) != nil {
		return view, nil
	}
	provider, err := s.repo.Model3DProvider(record.ProviderID)
	if err != nil {
		return nil, err
	}
	view.Available = true
	view.ProviderName = provider.Name
	view.ActiveConfigVersion = record.Version
	view.DefaultModel = config.DefaultModel
	view.Modes = config.AllowedModes
	for _, version := range model3d.Models() {
		if model3d.Contains(config.AllowedModels, version.ID) {
			view.ModelVersions = append(view.ModelVersions, version)
		}
	}
	return view, nil
}

func (s *Service) Model3DTaskByRequest(userID, requestID string) (*Model3DTaskView, error) {
	if userID == "" {
		return nil, Unauthorized("请先登录")
	}
	if requestID == "" || len(requestID) > 96 || strings.ContainsAny(requestID, "\r\n") {
		return nil, BadAuthRequest("请求标识无效")
	}
	submission, err := s.repo.Model3DSubmissionForRequest(userID, requestID)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return s.Model3DTask(userID, submission.TaskID)
}

func (s *Service) readModel3DImage(userID, id, view string) (*model.Resource, model3d.Image, string, error) {
	resource, reader, err := s.OpenResource(userID, id)
	if err != nil {
		return nil, model3d.Image{}, "", model3DError(err)
	}
	defer reader.Close()
	if resource.Kind != "image" || resource.Size <= 0 || resource.Size > model3d.MaxInputBytes {
		return nil, model3d.Image{}, "", BadAuthRequest("参考图须为 20 MB 以内的已上传图片")
	}
	data, err := io.ReadAll(io.LimitReader(reader, model3d.MaxInputBytes+1))
	if err != nil || len(data) == 0 || int64(len(data)) > model3d.MaxInputBytes {
		return nil, model3d.Image{}, "", BadAuthRequest("无法读取参考图或图片超过 20 MB")
	}
	configuration, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || !model3d.Contains([]string{"png", "jpeg", "webp"}, format) || configuration.Width <= 0 || configuration.Height <= 0 || int64(configuration.Width)*int64(configuration.Height) > 40000000 {
		return nil, model3d.Image{}, "", BadAuthRequest("参考图须为 PNG、JPEG 或 WebP，像素数量不超过 4000 万")
	}
	digest := sha256.Sum256(data)
	contentHash := hex.EncodeToString(digest[:])
	fileName, mimeType := "reference.png", "image/png"
	if format == "jpeg" {
		fileName, mimeType = "reference.jpg", "image/jpeg"
	}
	if format == "webp" {
		decoded, _, err := image.Decode(bytes.NewReader(data))
		if err != nil {
			return nil, model3d.Image{}, "", BadAuthRequest("WebP 图片解码失败")
		}
		var encoded bytes.Buffer
		if err := png.Encode(&encoded, decoded); err != nil {
			return nil, model3d.Image{}, "", err
		}
		if int64(encoded.Len()) > model3d.MaxInputBytes {
			return nil, model3d.Image{}, "", BadAuthRequest("WebP 转 PNG 后超过 20 MB，请压缩图片")
		}
		data = encoded.Bytes()
	}
	return resource, model3d.Image{View: view, FileName: fileName, ContentType: mimeType, Data: data}, contentHash, nil
}

func model3DRequestHash(req Model3DCreateRequest) string {
	encoded, _ := json.Marshal(req)
	sum := sha256.Sum256(encoded)
	return hex.EncodeToString(sum[:])
}

func (s *Service) CreateModel3DTask(userID string, req Model3DCreateRequest) (*Model3DTaskView, error) {
	if userID == "" {
		return nil, Unauthorized("请先登录")
	}
	if s.IsDraining() {
		return nil, NewAppError(503, "服务维护中，暂不接受 3D 生成")
	}
	req.RequestID = strings.TrimSpace(req.RequestID)
	req.Prompt = strings.TrimSpace(req.Prompt)
	if req.RequestID == "" || len(req.RequestID) > 96 || strings.ContainsAny(req.RequestID, "\r\n") || req.SourceFingerprint == "" || len(req.SourceFingerprint) > 128 || assets.ValidID(req.CanvasID) == "" || assets.ValidID(req.NodeID) == "" || req.ExpectedPolicyRevision == nil || *req.ExpectedPolicyRevision < 0 {
		return nil, BadAuthRequest("须提供请求身份、画布节点、来源指纹和生效配置版本")
	}
	hash := model3DRequestHash(req)
	if existing, err := s.repo.Model3DSubmissionForRequest(userID, req.RequestID); err == nil {
		if existing.RequestHash != hash {
			return nil, NewAppError(409, "相同 requestId 不能用于不同生成请求")
		}
		return s.Model3DTask(userID, existing.TaskID)
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, err
	}
	if _, err := s.repo.CanvasProjectForUser(userID, req.CanvasID); err != nil {
		return nil, model3DError(err)
	}
	if err := s.ensureTaskProjectActive(userID, req.CanvasID); err != nil {
		return nil, err
	}
	record, revision, err := s.repo.ActiveModel3DConfig()
	if err != nil {
		return nil, model3DError(err)
	}
	if revision != *req.ExpectedPolicyRevision {
		return nil, model3DError(repository.ErrModel3DConflict)
	}
	config, err := s.model3DDomainConfig(record)
	if err != nil {
		return nil, NewAppError(503, "3D 凭据无法解密")
	}
	if err := model3d.ValidateConfig(config); err != nil {
		return nil, NewAppError(503, "3D 配置无效")
	}
	if err := model3d.ValidateParameters(req.Mode, req.Prompt, req.Parameters, config); err != nil {
		return nil, BadAuthRequest(err.Error())
	}
	inputs := map[string]string{}
	switch req.Mode {
	case "text":
		if req.ImageResourceID != "" || req.Views != nil {
			return nil, BadAuthRequest("文本生成不接受图片输入")
		}
	case "image":
		if req.ImageResourceID == "" || req.Views != nil {
			return nil, BadAuthRequest("单图生成须选择一张参考图")
		}
		inputs["single"] = req.ImageResourceID
	case "multiview":
		if req.ImageResourceID != "" || req.Views == nil || req.Views.Front == "" {
			return nil, BadAuthRequest("多视图须包含正面图")
		}
		for view, id := range map[string]string{"front": req.Views.Front, "left": req.Views.Left, "back": req.Views.Back, "right": req.Views.Right} {
			if id != "" {
				inputs[view] = id
			}
		}
		if len(inputs) < 2 {
			return nil, BadAuthRequest("多视图须至少两张图片")
		}
	default:
		return nil, BadAuthRequest("生成方式无效")
	}
	input := model3DInput{ConfigID: record.ID, Mode: req.Mode, Prompt: req.Prompt, Parameters: req.Parameters, ReferenceImages: []model3DReference{}, SourceFingerprint: req.SourceFingerprint, ClientContext: model3DClientContext{CanvasID: req.CanvasID, NodeID: req.NodeID}}
	versions := map[string]string{}
	seen := map[string]bool{}
	for _, view := range []string{"single", "front", "left", "back", "right"} {
		id := inputs[view]
		if id == "" {
			continue
		}
		if assets.ValidID(id) == "" || seen[id] {
			return nil, BadAuthRequest("视图资源无效或重复，请分别选择不同视图")
		}
		seen[id] = true
		resource, _, contentHash, err := s.readModel3DImage(userID, id, view)
		if err != nil {
			return nil, err
		}
		version := model.ImageModerationResourceVersion(resource)
		versions[id] = version
		input.ReferenceImages = append(input.ReferenceImages, model3DReference{ResourceID: id, View: view, ResourceVersion: version, ContentHash: contentHash})
	}
	policy, err := s.RuntimePolicy()
	if err != nil {
		return nil, err
	}
	if err := s.requireStoredFileCapacityForTask(userID, model.TaskTypeCanvasModel3D, policy); err != nil {
		return nil, err
	}
	encoded, _ := json.Marshal(input)
	task := &model.Task{ID: newID(), UserID: userID, ProjectID: req.CanvasID, Type: model.TaskTypeCanvasModel3D, Status: model.TaskStatusQueued, Stage: "等待队列调度", Prompt: firstNonEmpty(req.Prompt, "3D 模型生成"), Operation: "model3d_" + req.Mode, Provider: model3d.ProviderTripo, Model: req.Parameters.Model, InputJSON: string(encoded)}
	submission := &model.Model3DSubmission{TaskID: task.ID, UserID: userID, RequestID: req.RequestID, RequestHash: hash, ConfigID: record.ID, State: "prepared"}
	s.storageMu.Lock()
	admitted, err := s.repo.AdmitModel3D(task, submission, revision, versions, func(repo *repository.Repository) error {
		return createTaskWithStorageQuotaRepository(repo, task, nil, policy)
	})
	s.storageMu.Unlock()
	if err != nil {
		return nil, model3DError(err)
	}
	s.wakeTaskDispatcher()
	return s.Model3DTask(userID, admitted.ID)
}

func (s *Service) Model3DTask(userID, id string) (*Model3DTaskView, error) {
	if userID == "" {
		return nil, Unauthorized("请先登录")
	}
	task, err := s.repo.TaskForUser(userID, id)
	if err != nil {
		return nil, model3DError(err)
	}
	if task.Type != model.TaskTypeCanvasModel3D {
		return nil, NotFound("3D 任务不存在")
	}
	submission, err := s.repo.Model3DSubmission(id)
	if err != nil {
		return nil, model3DError(err)
	}
	var input model3DInput
	if json.Unmarshal([]byte(task.InputJSON), &input) != nil {
		return nil, NewAppError(503, "3D 任务输入无效")
	}
	view := &Model3DTaskView{ID: task.ID, Status: task.Status, Stage: task.Stage, Progress: task.Progress, Mode: input.Mode, SourceFingerprint: input.SourceFingerprint, ClientContext: input.ClientContext, SubmissionOutcome: "not_submitted", CreatedAt: task.CreatedAt, UpdatedAt: task.UpdatedAt}
	if task.ProviderRequestID != "" {
		view.SubmissionOutcome = "submitted"
	} else if submission.State == "inflight" || submission.State == "unknown" {
		view.SubmissionOutcome = "unknown"
	}
	view.CanRetryStorage = task.Status == model.TaskStatusFailed && task.ProviderRequestID != "" && (submission.State == "accepted" || submission.State == "storing")
	if task.Status == model.TaskStatusSucceeded {
		var result Model3DResult
		if json.Unmarshal([]byte(task.ResultJSON), &result) == nil && result.ResourceID != "" {
			view.Result = &result
		}
	}
	if task.Status == model.TaskStatusFailed {
		retryClass := "new_request"
		if view.CanRetryStorage {
			retryClass = "recover_original"
		}
		if view.SubmissionOutcome == "unknown" {
			retryClass = "manual_review"
		}
		view.Error = &Model3DTaskError{Code: submission.ErrorCode, Reason: "failed_precondition", Message: task.Error, RetryClass: retryClass}
	}
	return view, nil
}

func (s *Service) RecoverModel3DTask(userID, id string) (*Model3DTaskView, error) {
	if s.IsDraining() {
		return nil, NewAppError(503, "服务维护中，暂不接受恢复")
	}
	view, err := s.Model3DTask(userID, id)
	if err != nil {
		return nil, err
	}
	if !view.CanRetryStorage {
		return nil, BadAuthRequest("仅能恢复已有上游任务的查询或模型保存，未知提交不能重发")
	}
	policy, err := s.RuntimePolicy()
	if err != nil {
		return nil, err
	}
	if err := s.repo.RecoverModel3DTask(userID, id, policy.Task.ActiveTaskLimit); err != nil {
		return nil, model3DError(err)
	}
	s.wakeTaskDispatcher()
	return s.Model3DTask(userID, id)
}
