package app

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
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
	"yingce/backend/internal/assets"
	"yingce/backend/internal/model"
	"yingce/backend/internal/model3d"
	"yingce/backend/internal/repository"
)

type Model3DParameters = model3d.Parameters
type Model3DProviderRequest struct {
	Name           string   `json:"name"`
	Type           string   `json:"type"`
	BaseURL        string   `json:"baseUrl"`
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
	BaseURL          string   `json:"baseUrl"`
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
	Scope                  string             `json:"scope,omitempty"`
	GroupID                string             `json:"groupId,omitempty"`
	CandidateIndex         int                `json:"candidateIndex,omitempty"`
	CandidateCount         int                `json:"candidateCount,omitempty"`
}
type model3DReference struct {
	ResourceID      string `json:"resourceId"`
	View            string `json:"view"`
	ResourceVersion string `json:"resourceVersion"`
	ContentHash     string `json:"contentHash"`
}
type model3DClientContext struct {
	CanvasID       string `json:"canvasId,omitempty"`
	NodeID         string `json:"nodeId,omitempty"`
	Scope          string `json:"scope"`
	GroupID        string `json:"groupId,omitempty"`
	CandidateIndex int    `json:"candidateIndex,omitempty"`
	CandidateCount int    `json:"candidateCount,omitempty"`
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
	RequestID         string               `json:"requestId"`
	Scope             string               `json:"scope"`
	GroupID           string               `json:"groupId,omitempty"`
	CandidateIndex    int                  `json:"candidateIndex,omitempty"`
	CandidateCount    int                  `json:"candidateCount,omitempty"`
	Prompt            string               `json:"prompt"`
	Parameters        model3d.Parameters   `json:"parameters"`
	ImageResourceID   string               `json:"imageResourceId,omitempty"`
	Views             *Model3DViews        `json:"views,omitempty"`
	Status            model.TaskStatus     `json:"status"`
	Stage             string               `json:"stage"`
	Progress          int                  `json:"progress"`
	ProviderProgress  *int                 `json:"providerProgress,omitempty"`
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

type Model3DTaskListOptions struct {
	Scope      string
	Limit      int
	Cursor     string
	ActiveOnly bool
}

type Model3DTaskPage struct {
	Tasks      []Model3DTaskView `json:"tasks"`
	NextCursor string            `json:"nextCursor,omitempty"`
}

type model3DTaskCursor struct {
	CreatedAt time.Time `json:"createdAt"`
	ID        string    `json:"id"`
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
	return Model3DProviderView{ID: provider.ID, Name: provider.Name, Type: provider.Type, BaseURL: config.BaseURL, Enabled: provider.Enabled, Archived: provider.Archived, ConfigID: config.ID, Version: config.Version, DefaultModel: config.DefaultModel, AllowedModels: models, AllowedModes: modes, TimeoutSeconds: config.TimeoutSeconds, MaxTasksPerDay: config.MaxTasksPerDay, APIKeyConfigured: config.APIKeyEncrypted != ""}
}

func (s *Service) model3DDomainConfig(record *model.Model3DConfig) (model3d.Config, error) {
	config := model3d.Config{Type: record.Type, BaseURL: record.BaseURL, DefaultModel: record.DefaultModel, TimeoutSeconds: record.TimeoutSeconds, MaxTasksPerDay: record.MaxTasksPerDay}
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
	baseURL, err := model3d.NormalizeBaseURL(req.BaseURL)
	if err != nil {
		return nil, BadAuthRequest(err.Error())
	}
	provider := model.Model3DProvider{ID: id, Name: req.Name, Type: req.Type, Enabled: req.Enabled}
	previous := ""
	version := 1
	config := model3d.Config{Type: req.Type, BaseURL: baseURL, APIKey: strings.TrimSpace(req.APIKey), DefaultModel: req.DefaultModel, AllowedModels: req.AllowedModels, AllowedModes: req.AllowedModes, TimeoutSeconds: req.TimeoutSeconds, MaxTasksPerDay: req.MaxTasksPerDay}
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
	record := model.Model3DConfig{ID: newID(), ProviderID: provider.ID, Version: version, Type: config.Type, BaseURL: config.BaseURL, DefaultModel: config.DefaultModel, AllowedModelsJSON: string(modelsJSON), AllowedModesJSON: string(modesJSON), TimeoutSeconds: config.TimeoutSeconds, MaxTasksPerDay: config.MaxTasksPerDay, APIKeyEncrypted: encrypted, CreatedBy: actor.ID}
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

func model3DScope(scope string) (string, error) {
	if scope == "" || scope == "canvas" {
		return "canvas", nil
	}
	if scope == "standalone" {
		return scope, nil
	}
	return "", BadAuthRequest("3D 任务范围无效")
}

func validateModel3DCandidates(req Model3DCreateRequest) error {
	if req.GroupID == "" && req.CandidateIndex == 0 && req.CandidateCount == 0 {
		return nil
	}
	if req.GroupID == "" || len(req.GroupID) > 96 || req.CandidateIndex < 1 || req.CandidateCount < req.CandidateIndex || req.CandidateCount > 4 {
		return BadAuthRequest("候选版本须提供分组标识，且满足 1 ≤ 候选序号 ≤ 候选数量 ≤ 4")
	}
	for _, char := range req.GroupID {
		if (char < 'a' || char > 'z') && (char < 'A' || char > 'Z') && (char < '0' || char > '9') && char != '-' && char != '_' {
			return BadAuthRequest("候选分组标识无效")
		}
	}
	return nil
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
	if req.RequestID == "" || len(req.RequestID) > 96 || strings.ContainsAny(req.RequestID, "\r\n") || req.SourceFingerprint == "" || len(req.SourceFingerprint) > 128 || req.ExpectedPolicyRevision == nil || *req.ExpectedPolicyRevision < 0 {
		return nil, BadAuthRequest("须提供请求身份、来源指纹和生效配置版本")
	}
	scope, err := model3DScope(req.Scope)
	if err != nil {
		return nil, err
	}
	if scope == "standalone" {
		if req.CanvasID != "" || req.NodeID != "" {
			return nil, BadAuthRequest("独立 3D 任务不能关联画布或节点")
		}
	} else {
		if assets.ValidID(req.CanvasID) == "" || assets.ValidID(req.NodeID) == "" {
			return nil, BadAuthRequest("画布 3D 任务须提供有效画布和节点")
		}
		// The omitted scope and explicit canvas scope identify the same request.
		req.Scope = ""
	}
	if err := validateModel3DCandidates(req); err != nil {
		return nil, err
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
	if scope == "canvas" {
		if _, err := s.repo.CanvasProjectForUser(userID, req.CanvasID); err != nil {
			return nil, model3DError(err)
		}
		if err := s.ensureTaskProjectActive(userID, req.CanvasID); err != nil {
			return nil, err
		}
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
	input := model3DInput{ConfigID: record.ID, Mode: req.Mode, Prompt: req.Prompt, Parameters: req.Parameters, ReferenceImages: []model3DReference{}, SourceFingerprint: req.SourceFingerprint, ClientContext: model3DClientContext{CanvasID: req.CanvasID, NodeID: req.NodeID, Scope: scope, GroupID: req.GroupID, CandidateIndex: req.CandidateIndex, CandidateCount: req.CandidateCount}}
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
	if scope == "standalone" {
		task.WorkbenchKind = model.WorkbenchKindModel3D
	}
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
	return model3DTaskView(task, submission)
}

func model3DTaskView(task *model.Task, submission *model.Model3DSubmission) (*Model3DTaskView, error) {
	var input model3DInput
	if json.Unmarshal([]byte(task.InputJSON), &input) != nil {
		return nil, NewAppError(503, "3D 任务输入无效")
	}
	scope := "canvas"
	if task.WorkbenchKind == model.WorkbenchKindModel3D {
		scope = "standalone"
	}
	input.ClientContext.Scope = scope
	view := &Model3DTaskView{ID: task.ID, RequestID: submission.RequestID, Scope: scope, GroupID: input.ClientContext.GroupID, CandidateIndex: input.ClientContext.CandidateIndex, CandidateCount: input.ClientContext.CandidateCount, Prompt: input.Prompt, Parameters: input.Parameters, Status: task.Status, Stage: task.Stage, Progress: task.Progress, ProviderProgress: publicProviderProgress(*task), Mode: input.Mode, SourceFingerprint: input.SourceFingerprint, ClientContext: input.ClientContext, SubmissionOutcome: "not_submitted", CreatedAt: task.CreatedAt, UpdatedAt: task.UpdatedAt}
	for _, ref := range input.ReferenceImages {
		if ref.View == "single" {
			view.ImageResourceID = ref.ResourceID
			continue
		}
		if view.Views == nil {
			view.Views = &Model3DViews{}
		}
		switch ref.View {
		case "front":
			view.Views.Front = ref.ResourceID
		case "left":
			view.Views.Left = ref.ResourceID
		case "back":
			view.Views.Back = ref.ResourceID
		case "right":
			view.Views.Right = ref.ResourceID
		}
	}
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

func (s *Service) Model3DTasks(userID string, options Model3DTaskListOptions) (*Model3DTaskPage, error) {
	if userID == "" {
		return nil, Unauthorized("请先登录")
	}
	scope, err := model3DScope(options.Scope)
	if err != nil {
		return nil, err
	}
	if options.Limit == 0 {
		options.Limit = 30
	}
	if options.Limit < 1 || options.Limit > 100 {
		return nil, BadAuthRequest("任务列表数量须为 1–100")
	}
	var before *time.Time
	var cursor model3DTaskCursor
	if options.Cursor != "" {
		if len(options.Cursor) > 512 {
			return nil, BadAuthRequest("任务列表游标无效")
		}
		encoded, err := base64.RawURLEncoding.DecodeString(options.Cursor)
		if err != nil || json.Unmarshal(encoded, &cursor) != nil || cursor.CreatedAt.IsZero() || assets.ValidID(cursor.ID) == "" {
			return nil, BadAuthRequest("任务列表游标无效")
		}
		before = &cursor.CreatedAt
	}
	tasks, err := s.repo.Model3DTasks(userID, scope == "standalone", options.ActiveOnly, options.Limit+1, before, cursor.ID)
	if err != nil {
		return nil, err
	}
	page := &Model3DTaskPage{Tasks: []Model3DTaskView{}}
	if len(tasks) > options.Limit {
		tasks = tasks[:options.Limit]
		last := tasks[len(tasks)-1]
		encoded, _ := json.Marshal(model3DTaskCursor{CreatedAt: last.CreatedAt, ID: last.ID})
		page.NextCursor = base64.RawURLEncoding.EncodeToString(encoded)
	}
	ids := make([]string, 0, len(tasks))
	for _, task := range tasks {
		ids = append(ids, task.ID)
	}
	submissions, err := s.repo.Model3DSubmissions(userID, ids)
	if err != nil {
		return nil, err
	}
	byTaskID := make(map[string]model.Model3DSubmission, len(submissions))
	for _, submission := range submissions {
		byTaskID[submission.TaskID] = submission
	}
	for _, task := range tasks {
		submission, ok := byTaskID[task.ID]
		if !ok {
			return nil, NewAppError(503, "3D 任务提交记录缺失")
		}
		view, err := model3DTaskView(&task, &submission)
		if err != nil {
			return nil, err
		}
		page.Tasks = append(page.Tasks, *view)
	}
	return page, nil
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
