package app

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	_ "golang.org/x/image/bmp"
	_ "golang.org/x/image/webp"
	"image"
	"io"
	"net/http"
	"path"
	"strings"
	"time"
	"unicode/utf8"

	"gorm.io/gorm"
	"yingce/backend/internal/model"
	"yingce/backend/internal/moderation"
	"yingce/backend/internal/repository"
)

const imageModerationMaxBytes = 20 << 20

type ImageModerationProviderRequest struct {
	Name               string   `json:"name"`
	Type               string   `json:"type"`
	Enabled            bool     `json:"enabled"`
	Region             string   `json:"region"`
	Services           []string `json:"services"`
	TimeoutSeconds     int      `json:"timeoutSeconds"`
	MaxCallsPerDay     int      `json:"maxCallsPerDay"`
	MinIntervalSeconds int      `json:"minIntervalSeconds"`
	AccessKeyID        string   `json:"accessKeyId"`
	AccessKeySecret    string   `json:"accessKeySecret"`
}

type ImageModerationProviderView struct {
	ID                        string   `json:"id"`
	Name                      string   `json:"name"`
	Type                      string   `json:"type"`
	Enabled                   bool     `json:"enabled"`
	Archived                  bool     `json:"archived"`
	ConfigID                  string   `json:"configId"`
	Version                   int      `json:"version"`
	Region                    string   `json:"region"`
	Services                  []string `json:"services"`
	TimeoutSeconds            int      `json:"timeoutSeconds"`
	MaxCallsPerDay            int      `json:"maxCallsPerDay"`
	MinIntervalSeconds        int      `json:"minIntervalSeconds"`
	AccessKeyIDConfigured     bool     `json:"accessKeyIdConfigured"`
	AccessKeySecretConfigured bool     `json:"accessKeySecretConfigured"`
}

type ImageModerationAdminState struct {
	Providers        []ImageModerationProviderView `json:"providers"`
	ActiveProviderID string                        `json:"activeProviderId"`
	ActiveConfigID   string                        `json:"activeConfigId"`
	PolicyRevision   int64                         `json:"policyRevision"`
	ProviderTypes    []moderation.ProviderType     `json:"providerTypes"`
}

type ImageModerationActivationRequest struct {
	ConfigID         string `json:"configId"`
	ExpectedRevision int64  `json:"expectedRevision"`
}

type ImageModerationReport struct {
	CheckID        string               `json:"checkId"`
	ResourceID     string               `json:"resourceId"`
	ContentVersion string               `json:"contentVersion"`
	Status         string               `json:"status"`
	OverallRisk    string               `json:"overallRisk"`
	RiskTags       []moderation.RiskTag `json:"riskTags"`
	Summary        string               `json:"summary"`
	CreatedAt      time.Time            `json:"createdAt"`
	CompletedAt    *time.Time           `json:"completedAt,omitempty"`
	IsCurrent      bool                 `json:"isCurrent"`
	Reused         bool                 `json:"reused,omitempty"`
}

func imageModerationError(err error) error {
	switch {
	case errors.Is(err, gorm.ErrRecordNotFound):
		return NotFound("检测配置、报告或图片不存在或不可访问")
	case errors.Is(err, repository.ErrImageModerationConflict), errors.Is(err, repository.ErrImageModerationActive):
		return NewAppError(409, err.Error())
	case errors.Is(err, repository.ErrImageModerationUnavailable):
		return NewAppError(503, "图片内容检测服务尚未配置，请联系管理员")
	case errors.Is(err, repository.ErrImageModerationInterval):
		return RateLimited(err.Error())
	case errors.Is(err, repository.ErrImageModerationBudget):
		return QuotaExceeded(err.Error())
	default:
		return err
	}
}

func imageModerationView(provider model.ImageModerationProvider, config model.ImageModerationConfig) ImageModerationProviderView {
	services := []string{}
	_ = json.Unmarshal([]byte(config.ServicesJSON), &services)
	return ImageModerationProviderView{ID: provider.ID, Name: provider.Name, Type: provider.Type, Enabled: provider.Enabled, Archived: provider.Archived, ConfigID: config.ID, Version: config.Version, Region: config.Region, Services: services, TimeoutSeconds: config.TimeoutSeconds, MaxCallsPerDay: config.MaxCallsPerDay, MinIntervalSeconds: config.MinIntervalSeconds, AccessKeyIDConfigured: config.AccessKeyIDEncrypted != "", AccessKeySecretConfigured: config.AccessKeySecretEncrypted != ""}
}

func (s *Service) AdminImageModeration(actor *model.User) (*ImageModerationAdminState, error) {
	if err := s.RequireAdmin(actor); err != nil {
		return nil, err
	}
	providers, configs, policy, err := s.repo.ImageModerationState()
	if err != nil {
		return nil, err
	}
	byID := make(map[string]model.ImageModerationConfig, len(configs))
	for _, config := range configs {
		byID[config.ID] = config
	}
	state := &ImageModerationAdminState{Providers: []ImageModerationProviderView{}, ActiveProviderID: policy.ActiveProviderID, ActiveConfigID: policy.ActiveConfigID, PolicyRevision: policy.Revision, ProviderTypes: moderation.SupportedTypes()}
	for _, provider := range providers {
		state.Providers = append(state.Providers, imageModerationView(provider, byID[provider.LatestConfigID]))
	}
	return state, nil
}

func (s *Service) imageModerationDomainConfig(record *model.ImageModerationConfig) (moderation.Config, error) {
	config := moderation.Config{Type: record.Type, Region: record.Region, TimeoutSeconds: record.TimeoutSeconds, MaxCallsPerDay: record.MaxCallsPerDay, MinIntervalSeconds: record.MinIntervalSeconds}
	if err := json.Unmarshal([]byte(record.ServicesJSON), &config.Services); err != nil {
		return config, err
	}
	var err error
	config.AccessKeyID, err = s.decryptSettingSecret(record.AccessKeyIDEncrypted)
	if err != nil {
		return config, err
	}
	config.AccessKeySecret, err = s.decryptSettingSecret(record.AccessKeySecretEncrypted)
	return config, err
}

func (s *Service) moderationProvider(kind string) (moderation.Provider, error) {
	if s.imageModerationProviderFactory != nil {
		return s.imageModerationProviderFactory(kind)
	}
	return moderation.NewProvider(kind)
}

func (s *Service) SaveImageModerationProvider(actor *model.User, id string, req ImageModerationProviderRequest) (*ImageModerationProviderView, error) {
	if err := s.RequireAdmin(actor); err != nil {
		return nil, err
	}
	req.Name = strings.TrimSpace(req.Name)
	req.Type = strings.TrimSpace(req.Type)
	req.Region = strings.TrimSpace(req.Region)
	if req.Name == "" || utf8.RuneCountInString(req.Name) > 120 {
		return nil, BadAuthRequest("Provider 名称须为 1–120 个字符")
	}
	provider := model.ImageModerationProvider{ID: id, Name: req.Name, Type: req.Type, Enabled: req.Enabled}
	previous := ""
	version := 1
	config := moderation.Config{Type: req.Type, Region: req.Region, Services: req.Services, TimeoutSeconds: req.TimeoutSeconds, MaxCallsPerDay: req.MaxCallsPerDay, MinIntervalSeconds: req.MinIntervalSeconds, AccessKeyID: strings.TrimSpace(req.AccessKeyID), AccessKeySecret: strings.TrimSpace(req.AccessKeySecret)}
	if (config.AccessKeyID == "") != (config.AccessKeySecret == "") {
		return nil, BadAuthRequest("AccessKey ID 和 Secret 须同时填写，编辑时可同时留空沿用原凭据")
	}
	if id != "" {
		current, err := s.repo.ImageModerationProvider(id)
		if err != nil {
			return nil, imageModerationError(err)
		}
		if current.Archived {
			return nil, BadAuthRequest("已归档 Provider 不可修改")
		}
		if current.Type != req.Type {
			return nil, BadAuthRequest("平台类型不可修改，请新建 Provider")
		}
		provider.CreatedAt = current.CreatedAt
		previous = current.LatestConfigID
		old, err := s.repo.ImageModerationConfig(previous)
		if err != nil {
			return nil, imageModerationError(err)
		}
		version = old.Version + 1
		if config.AccessKeyID == "" {
			config.AccessKeyID, err = s.decryptSettingSecret(old.AccessKeyIDEncrypted)
			if err != nil {
				return nil, NewAppError(503, "检测凭据无法解密，请重新填写完整凭据")
			}
		}
		if config.AccessKeySecret == "" {
			config.AccessKeySecret, err = s.decryptSettingSecret(old.AccessKeySecretEncrypted)
			if err != nil {
				return nil, NewAppError(503, "检测凭据无法解密，请重新填写完整凭据")
			}
		}
	} else {
		provider.ID = newID()
	}
	adapter, err := s.moderationProvider(req.Type)
	if err != nil {
		return nil, BadAuthRequest("不支持的检测平台")
	}
	if err := adapter.Validate(config); err != nil {
		return nil, BadAuthRequest(err.Error())
	}
	keyID, err := s.encryptSettingSecret(config.AccessKeyID)
	if err != nil {
		return nil, err
	}
	secret, err := s.encryptSettingSecret(config.AccessKeySecret)
	if err != nil {
		return nil, err
	}
	servicesJSON, _ := json.Marshal(config.Services)
	record := model.ImageModerationConfig{ID: newID(), ProviderID: provider.ID, Version: version, Type: config.Type, Region: config.Region, ServicesJSON: string(servicesJSON), TimeoutSeconds: config.TimeoutSeconds, MaxCallsPerDay: config.MaxCallsPerDay, MinIntervalSeconds: config.MinIntervalSeconds, AccessKeyIDEncrypted: keyID, AccessKeySecretEncrypted: secret, CreatedBy: actor.ID}
	provider.LatestConfigID = record.ID
	audit, err := newAdminAuditEvent(actor, "image_moderation.configure", "image_moderation_provider", provider.ID, "保存图片内容检测配置", map[string]any{"configId": record.ID, "version": record.Version, "type": record.Type, "services": config.Services, "enabled": provider.Enabled})
	if err != nil {
		return nil, err
	}
	if err := s.repo.SaveImageModerationProvider(&provider, &record, previous, audit); err != nil {
		return nil, imageModerationError(err)
	}
	view := imageModerationView(provider, record)
	return &view, nil
}

func (s *Service) ActivateImageModerationProvider(actor *model.User, id string, req ImageModerationActivationRequest) (*ImageModerationAdminState, error) {
	if err := s.RequireAdmin(actor); err != nil {
		return nil, err
	}
	if id == "" || req.ConfigID == "" {
		return nil, BadAuthRequest("须指定 Provider 和配置版本")
	}
	if err := s.ValidateImageModerationProvider(actor, id, req.ConfigID); err != nil {
		return nil, err
	}
	audit, err := newAdminAuditEvent(actor, "image_moderation.activate", "image_moderation_provider", id, "启用图片内容检测配置", map[string]any{"configId": req.ConfigID, "previousRevision": req.ExpectedRevision})
	if err != nil {
		return nil, err
	}
	if err := s.repo.SetImageModerationPolicy(id, req.ConfigID, req.ExpectedRevision, audit); err != nil {
		return nil, imageModerationError(err)
	}
	return s.AdminImageModeration(actor)
}

func (s *Service) DisableImageModeration(actor *model.User, expectedRevision int64) (*ImageModerationAdminState, error) {
	if err := s.RequireAdmin(actor); err != nil {
		return nil, err
	}
	audit, err := newAdminAuditEvent(actor, "image_moderation.disable", "image_moderation_policy", "image-content", "停用图片内容检测服务", map[string]any{"previousRevision": expectedRevision})
	if err != nil {
		return nil, err
	}
	if err := s.repo.SetImageModerationPolicy("", "", expectedRevision, audit); err != nil {
		return nil, imageModerationError(err)
	}
	return s.AdminImageModeration(actor)
}

func (s *Service) ArchiveImageModerationProvider(actor *model.User, id string) (*ImageModerationAdminState, error) {
	if err := s.RequireAdmin(actor); err != nil {
		return nil, err
	}
	audit, err := newAdminAuditEvent(actor, "image_moderation.archive", "image_moderation_provider", id, "归档图片内容检测 Provider", nil)
	if err != nil {
		return nil, err
	}
	if err := s.repo.ArchiveImageModerationProvider(id, audit); err != nil {
		return nil, imageModerationError(err)
	}
	return s.AdminImageModeration(actor)
}

// Validation never submits an image or consumes a provider API call.
func (s *Service) ValidateImageModerationProvider(actor *model.User, id, configID string) error {
	if err := s.RequireAdmin(actor); err != nil {
		return err
	}
	provider, err := s.repo.ImageModerationProvider(id)
	if err != nil {
		return imageModerationError(err)
	}
	if provider.Archived {
		return BadAuthRequest("已归档 Provider 不可使用")
	}
	record, err := s.repo.ImageModerationConfig(configID)
	if err != nil {
		return imageModerationError(err)
	}
	if record.ProviderID != id {
		return BadAuthRequest("配置不属于当前 Provider")
	}
	config, err := s.imageModerationDomainConfig(record)
	if err != nil {
		return NewAppError(503, "检测凭据无法解密，请检查服务器配置")
	}
	adapter, err := s.moderationProvider(config.Type)
	if err != nil {
		return BadAuthRequest("不支持的检测平台")
	}
	if err := adapter.Validate(config); err != nil {
		return BadAuthRequest(err.Error())
	}
	return nil
}

func (s *Service) ImageModerationAvailable(userID string) (bool, error) {
	if userID == "" {
		return false, Unauthorized("请先登录")
	}
	_, err := s.repo.ActiveImageModerationConfig()
	if errors.Is(err, repository.ErrImageModerationUnavailable) {
		return false, nil
	}
	return err == nil, err
}

func imageModerationResourceVersion(resource *model.Resource) string {
	return model.ImageModerationResourceVersion(resource)
}

func (s *Service) readImageModerationImage(userID, resourceID string) (*model.Resource, moderation.Image, string, error) {
	resource, err := s.repo.ResourceForUser(userID, resourceID)
	if err != nil {
		return nil, moderation.Image{}, "", imageModerationError(err)
	}
	if resource.Kind != "image" || resource.Status != model.ResourceStatusReady {
		return nil, moderation.Image{}, "", BadAuthRequest("只能检测已保存的图片资源")
	}
	if resource.Size > imageModerationMaxBytes {
		return nil, moderation.Image{}, "", BadAuthRequest("检测图片不能超过 20 MiB")
	}
	_, body, err := s.OpenResource(userID, resourceID)
	if err != nil {
		return nil, moderation.Image{}, "", NewAppError(503, "图片原始资源暂不可读取")
	}
	defer body.Close()
	data, err := io.ReadAll(io.LimitReader(body, imageModerationMaxBytes+1))
	if err != nil {
		return nil, moderation.Image{}, "", NewAppError(503, "图片原始资源读取失败")
	}
	if len(data) == 0 || len(data) > imageModerationMaxBytes {
		return nil, moderation.Image{}, "", BadAuthRequest("图片大小不符合检测要求")
	}
	mimeType := http.DetectContentType(data)
	if mimeType != "image/jpeg" && mimeType != "image/png" && mimeType != "image/gif" && mimeType != "image/webp" && mimeType != "image/bmp" {
		return nil, moderation.Image{}, "", BadAuthRequest("检测仅支持 JPEG、PNG、GIF、WebP 和 BMP 图片")
	}
	imageConfig, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || imageConfig.Width <= 0 || imageConfig.Height <= 0 {
		return nil, moderation.Image{}, "", BadAuthRequest("图片原始内容无法解析，请重新保存图片")
	}
	if imageConfig.Width > 16384 || imageConfig.Height > 16384 || int64(imageConfig.Width)*int64(imageConfig.Height) > 250000000 {
		return nil, moderation.Image{}, "", BadAuthRequest("检测图片长边不能超过 16384 像素，总像素不能超过 2.5 亿")
	}
	digest := sha256.Sum256(data)
	return resource, moderation.Image{Data: data, Name: path.Base(resource.ObjectKey), ContentType: mimeType}, hex.EncodeToString(digest[:]), nil
}

func (s *Service) CreateImageModerationCheck(userID, resourceID string) (*ImageModerationReport, error) {
	if userID == "" {
		return nil, Unauthorized("请先登录")
	}
	if s.IsDraining() {
		return nil, NewAppError(503, "服务正在维护，请稍后重试")
	}
	record, err := s.repo.ActiveImageModerationConfig()
	if err != nil {
		return nil, imageModerationError(err)
	}
	resource, _, version, err := s.readImageModerationImage(userID, resourceID)
	if err != nil {
		return nil, err
	}
	services := []string{}
	if err := json.Unmarshal([]byte(record.ServicesJSON), &services); err != nil {
		return nil, NewAppError(503, "检测配置不可用")
	}
	key := sha256.Sum256([]byte(userID + "\n" + resourceID + "\n" + version + "\n" + record.ID))
	activeKey := hex.EncodeToString(key[:])
	now := time.Now().UTC()
	check := &model.ImageModerationCheck{ID: newID(), UserID: userID, ResourceID: resourceID, ContentVersion: version, ResourceVersion: imageModerationResourceVersion(resource), ProviderID: record.ProviderID, ConfigID: record.ID, ActiveKey: &activeKey, Status: "queued", OverallRisk: "unknown", RiskTagsJSON: "[]", Summary: "检测已排队", CreatedAt: now}
	items := make([]model.ImageModerationItem, 0, len(services))
	for _, service := range services {
		items = append(items, model.ImageModerationItem{ID: newID(), CheckID: check.ID, Service: service, Status: "queued", RiskLevel: "unknown", RiskTagsJSON: "[]", CreatedAt: now})
	}
	check, reused, err := s.repo.AdmitImageModerationCheck(check, items, record.MinIntervalSeconds)
	if err != nil {
		return nil, imageModerationError(err)
	}
	report, err := s.imageModerationReport(check)
	if report != nil {
		report.Reused = reused
	}
	return report, err
}

func (s *Service) ImageModerationCheck(userID, id string) (*ImageModerationReport, error) {
	if userID == "" {
		return nil, Unauthorized("请先登录")
	}
	check, err := s.repo.ImageModerationCheckForUser(userID, id)
	if err != nil {
		return nil, imageModerationError(err)
	}
	return s.imageModerationReport(check)
}

func (s *Service) LatestImageModerationCheck(userID, resourceID string) (*ImageModerationReport, error) {
	if userID == "" {
		return nil, Unauthorized("请先登录")
	}
	if _, err := s.repo.ResourceForUser(userID, resourceID); err != nil {
		return nil, imageModerationError(err)
	}
	check, err := s.repo.LatestImageModerationCheck(userID, resourceID)
	if err != nil || check == nil {
		return nil, err
	}
	return s.imageModerationReport(check)
}

func (s *Service) imageModerationReport(check *model.ImageModerationCheck) (*ImageModerationReport, error) {
	tags := []moderation.RiskTag{}
	if err := json.Unmarshal([]byte(check.RiskTagsJSON), &tags); err != nil {
		return nil, fmt.Errorf("decode moderation report: %w", err)
	}
	resource, err := s.repo.ResourceForUser(check.UserID, check.ResourceID)
	if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, err
	}
	current := err == nil && resource.Status == model.ResourceStatusReady && imageModerationResourceVersion(resource) == check.ResourceVersion
	latest, latestErr := s.repo.LatestImageModerationCheck(check.UserID, check.ResourceID)
	if latestErr != nil {
		return nil, latestErr
	}
	active, activeErr := s.repo.ActiveImageModerationConfig()
	if activeErr != nil && !errors.Is(activeErr, repository.ErrImageModerationUnavailable) {
		return nil, activeErr
	}
	current = current && latest != nil && latest.ID == check.ID && activeErr == nil && active.ID == check.ConfigID
	return &ImageModerationReport{CheckID: check.ID, ResourceID: check.ResourceID, ContentVersion: check.ContentVersion, Status: check.Status, OverallRisk: check.OverallRisk, RiskTags: tags, Summary: check.Summary, CreatedAt: check.CreatedAt, CompletedAt: check.CompletedAt, IsCurrent: current}, nil
}
