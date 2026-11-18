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
	Model                DramaModelChoice  `json:"model"`
	Prompt               string            `json:"prompt"`
	PromptSourceHash     *string           `json:"promptSourceHash,omitempty"`
	Operation            string            `json:"operation"`
	AspectRatio          string            `json:"aspectRatio"`
	Resolution           string            `json:"resolution"`
	Seconds              int               `json:"seconds,omitempty"`
	GenerateAudio        bool              `json:"generateAudio"`
	ReferenceResourceIDs []string          `json:"referenceResourceIds"`
	ReferenceNames       map[string]string `json:"referenceNames,omitempty"`
	ReferenceSubjects    map[string]string `json:"referenceSubjects,omitempty"`
	FirstFrameResourceID string            `json:"firstFrameResourceId,omitempty"`
	LastFrameResourceID  string            `json:"lastFrameResourceId,omitempty"`
	AudioVoice           string            `json:"audioVoice,omitempty"`
	AudioInstructions    string            `json:"audioInstructions,omitempty"`
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
	ScopeHash          string               `json:"scopeHash"`
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
	// Display name, order and timestamps aren't generation inputs.
	shot.CreatedAt, shot.UpdatedAt = time.Time{}, time.Time{}
	shot.Position = 0
	shot.Name = ""
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

func defaultDramaShotMediaConfig(shot model.DramaShot, settings DramaSettings, kind string) DramaShotMediaConfig {
	if kind == "audio" {
		return DramaShotMediaConfig{Prompt: shot.Dialogue, Operation: "audio", ReferenceResourceIDs: []string{}}
	}
	config := DramaShotMediaConfig{Model: settings.Models.Image, Prompt: shot.ImagePrompt, Operation: "text_to_image", AspectRatio: settings.AspectRatio, Resolution: "1K", ReferenceResourceIDs: []string{}}
	if kind == "video" {
		config.Model, config.Prompt, config.Operation = settings.Models.Video, shot.VideoPrompt, "text_to_video"
		config.Seconds = max(1, int((shot.DurationMs+999)/1000))
	}
	return config
}

func (s *Service) loadDramaShotMedia(repo *repository.Repository, shot model.DramaShot, p model.DramaProduction, kind string) (model.DramaShotMedia, DramaShotMediaConfig, error) {
	row, err := repo.DramaShotMedia(shot.ProjectID, shot.ID, kind)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		episode, episodeErr := repo.DramaEpisode(shot.ProjectID, shot.EpisodeID)
		if episodeErr != nil {
			return model.DramaShotMedia{}, DramaShotMediaConfig{}, episodeErr
		}
		settings := dramaEpisodeSettings(parseDramaSettings(p.SettingsJSON), *episode)
		config := defaultDramaShotMediaConfig(shot, settings, kind)
		var configErr error
		if kind == "video" {
			profile, _ := s.dramaVideoProfile(config.Model)
			config.Resolution = dramaShotEpisodeResolution(settings, profile.video)
			config, configErr = s.defaultDramaShotVideoReferences(repo, shot, p, settings, profile.video, config)
		}
		if configErr == nil {
			config, configErr = s.readDramaShotMediaConfig(repo, shot, p, kind, config)
		}
		return model.DramaShotMedia{ProjectID: shot.ProjectID, EpisodeID: shot.EpisodeID, ShotID: shot.ID, Kind: kind, Status: "idle"}, config, configErr
	}
	if err != nil {
		return model.DramaShotMedia{}, DramaShotMediaConfig{}, err
	}
	var config DramaShotMediaConfig
	if err := json.Unmarshal([]byte(row.ConfigJSON), &config); err != nil {
		return *row, config, errors.New("镜头媒体配置损坏，请重新保存")
	}
	// Recover legacy slots that stored a model default instead of a concrete
	// screen setting without refreshing any of their media.
	if kind == "video" && (missingDramaShotAspectRatio(config.AspectRatio) || isAutomaticVideoResolution(config.Resolution)) {
		episode, err := repo.DramaEpisode(shot.ProjectID, shot.EpisodeID)
		if err != nil {
			return *row, config, err
		}
		settings := dramaEpisodeSettings(parseDramaSettings(p.SettingsJSON), *episode)
		if missingDramaShotAspectRatio(config.AspectRatio) {
			config.AspectRatio = settings.AspectRatio
		}
		if isAutomaticVideoResolution(config.Resolution) {
			profile, _ := s.dramaVideoProfile(settings.Models.Video)
			config.Resolution = dramaShotEpisodeResolution(settings, profile.video)
		}
	}
	config, err = s.readDramaShotMediaConfig(repo, shot, p, kind, config)
	return *row, config, err
}

func (s *Service) readDramaShotMediaConfig(repo *repository.Repository, shot model.DramaShot, p model.DramaProduction, kind string, config DramaShotMediaConfig) (DramaShotMediaConfig, error) {
	config, _, err := resolveDramaShotReferenceImages(repo, p.UserID, shot.ProjectID, kind, config)
	if err != nil {
		return config, err
	}
	return s.enrichDramaShotVideoPrompt(repo, shot, p, kind, config)
}

func missingDramaShotAspectRatio(ratio string) bool {
	ratio = strings.TrimSpace(ratio)
	return ratio == "" || strings.EqualFold(ratio, "auto") || strings.EqualFold(ratio, "default")
}

func dramaShotEpisodeResolution(settings DramaSettings, video *VideoCapabilityConfig) string {
	if !isAutomaticVideoResolution(settings.VideoResolution) {
		// Keep an explicit episode choice visible even after a model change;
		// the shot editor requires a compatible selection before saving.
		return firstNonEmpty(dramaShotVideoResolutionOption(video, settings.AspectRatio, settings.VideoResolution), settings.VideoResolution)
	}
	if video == nil {
		return ""
	}
	if video.FixedScreenSpec != nil {
		screen := dramaVideoScreenFor(video, settings.AspectRatio, "")
		return dramaShotVideoResolutionOption(video, settings.AspectRatio, screen.Resolution)
	}
	return dramaShotVideoResolutionOption(video, settings.AspectRatio, video.DefaultResolution)
}

// The shot editor uses the same resolution options as episode settings. Fixed
// screen models need the orientation-specific label only at the task boundary.
func dramaShotVideoResolutionOption(video *VideoCapabilityConfig, ratio, resolution string) string {
	if video == nil || isAutomaticVideoResolution(resolution) {
		return ""
	}
	if video.FixedScreenSpec != nil {
		screen := dramaVideoScreenFor(video, ratio, resolution)
		if screen.Issue != "" {
			return ""
		}
		if tier := dramaResolutionTier(screen.Resolution); tier != "" {
			return tier + "p"
		}
		return screen.Resolution
	}
	if len(video.Ratios) > 0 && !videoRatioAllowed(video.Ratios, ratio) {
		return ""
	}
	key := dramaVideoResolutionKey(resolution)
	for _, option := range video.Resolutions {
		if dramaVideoResolutionKey(option) == key {
			return option
		}
	}
	return ""
}

func (s *Service) validateDramaShotVideoScreen(config DramaShotMediaConfig) error {
	if missingDramaShotAspectRatio(config.AspectRatio) {
		return BadAuthRequest("请选择镜头视频画幅")
	}
	if isAutomaticVideoResolution(config.Resolution) {
		return BadAuthRequest("请选择镜头视频分辨率")
	}
	profile, err := s.dramaVideoProfile(config.Model)
	if profile.video == nil {
		return BadAuthRequest(fmt.Sprintf("请选择可用的镜头视频模型：%v", err))
	}
	if profile.video.FixedScreenSpec != nil {
		if screen := profile.screen(config.AspectRatio, config.Resolution); screen.Issue != "" {
			return BadAuthRequest(screen.Issue)
		}
		return nil
	}
	if len(profile.video.Ratios) > 0 && !videoRatioAllowed(profile.video.Ratios, config.AspectRatio) {
		return BadAuthRequest(fmt.Sprintf("当前视频模型不支持 %s 画幅，请选择可用画幅", config.AspectRatio))
	}
	if dramaShotVideoResolutionOption(profile.video, config.AspectRatio, config.Resolution) == "" {
		return BadAuthRequest(fmt.Sprintf("当前视频模型不支持 %s 分辨率，请选择可用分辨率", config.Resolution))
	}
	return nil
}

func (s *Service) defaultDramaShotVideoReferences(repo *repository.Repository, shot model.DramaShot, p model.DramaProduction, settings DramaSettings, video *VideoCapabilityConfig, config DramaShotMediaConfig) (DramaShotMediaConfig, error) {
	validImage := func(id string) (bool, error) {
		resource, err := repo.ResourceForUser(p.UserID, id)
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return false, nil
		}
		if err != nil {
			return false, err
		}
		return resource.Status == model.ResourceStatusReady && resource.Kind == "image" && strings.HasPrefix(resource.MimeType, "image/"), nil
	}
	switch settings.Storyboard.GenerationMode {
	case "reference_video", "smart_director":
		config.Operation = "reference_to_video"
		casts, err := repo.DramaCasts(shot.ProjectID)
		if err != nil {
			return config, err
		}
		castByID := make(map[string]model.DramaCast, len(casts))
		for _, cast := range casts {
			castByID[cast.ID] = cast
		}
		// Reuse the script pipeline's selected-look substitution and stable
		// character, prop, scene order for independent shot generation.
		drafts := buildDramaSegmentDrafts(settings, dramaBibleMeta{}, []model.DramaShot{shot}, castByID, nil)
		limit := dramaMaxReferenceLimit
		if settings.ReferenceLimit > 0 {
			limit = min(limit, settings.ReferenceLimit)
		}
		if video != nil {
			limit = min(limit, max(video.References.MaxImages, 0))
		}
		seen := map[string]bool{}
		for _, reference := range drafts[0].view.Request.References {
			if len(config.ReferenceResourceIDs) >= limit {
				break
			}
			cast := castByID[reference.CastID]
			id := cast.ImageResourceID
			// Image status also tracks regeneration; the adopted resource stays
			// usable while a replacement is queued, running or has failed.
			if id == "" || seen[id] {
				continue
			}
			valid, err := validImage(id)
			if err != nil {
				return config, err
			}
			if valid {
				seen[id] = true
				config.ReferenceResourceIDs = append(config.ReferenceResourceIDs, id)
				if config.ReferenceSubjects == nil {
					config.ReferenceSubjects = map[string]string{}
				}
				config.ReferenceSubjects[id] = cast.ID
			}
		}
	case "grid_image", "storyboard":
		config.Operation = "image_to_video"
		image, err := repo.DramaShotMedia(shot.ProjectID, shot.ID, "image")
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return config, nil
		}
		if err != nil {
			return config, err
		}
		if image.ResourceID == "" || image.Status == "stale" || image.ScriptHash != "" && image.ScriptHash != dramaShotScriptHash(shot) {
			return config, nil
		}
		valid, err := validImage(image.ResourceID)
		if err != nil {
			return config, err
		}
		if valid {
			config.FirstFrameResourceID = image.ResourceID
		}
	}
	return config, nil
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
	config, issue, err := resolveDramaShotReferenceImages(s.repo, userID, projectID, kind, req.Config)
	if err != nil {
		return DramaShotMediaView{}, err
	}
	if issue != "" {
		return DramaShotMediaView{}, BadAuthRequest(issue)
	}
	config, err = s.normalizeDramaShotMediaConfig(s.repo, userID, projectID, kind, config)
	if err != nil {
		return DramaShotMediaView{}, err
	}
	if kind == "video" {
		if err := s.validateDramaShotVideoScreen(config); err != nil {
			return DramaShotMediaView{}, err
		}
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
		if err := lockDramaShotReferenceSubjects(repo, projectID, kind, req.Config); err != nil {
			return err
		}
		config, issue, err = resolveDramaShotReferenceImages(repo, userID, projectID, kind, req.Config)
		if err != nil {
			return err
		}
		if issue != "" {
			return BadAuthRequest(issue)
		}
		config, err = s.normalizeDramaShotMediaConfig(repo, userID, projectID, kind, config)
		if err != nil {
			return err
		}
		if err := repo.LockDramaCastImageReferences(userID, dramaShotMediaReferenceIDs(config)); err != nil {
			return BadAuthRequest("参考图或首尾帧已变化，请重新选择")
		}
		config, err = s.enrichDramaShotVideoPrompt(repo, *shot, *p, kind, config)
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

func (s *Service) normalizeDramaShotMediaConfig(repo *repository.Repository, userID, projectID, kind string, config DramaShotMediaConfig) (DramaShotMediaConfig, error) {
	if kind == "audio" {
		config.ReferenceNames = nil
		config.ReferenceSubjects = nil
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
	boundIDs := make(map[string]bool, len(refs)+2)
	for _, id := range dramaShotMediaReferenceIDs(config) {
		boundIDs[id] = true
	}
	names := make(map[string]string, len(boundIDs))
	for id, name := range config.ReferenceNames {
		id, name = strings.TrimSpace(id), strings.TrimSpace(name)
		if !boundIDs[id] || name == "" {
			continue
		}
		if utf8.RuneCountInString(name) > 120 {
			return config, BadAuthRequest("参考图片名称不超过 120 字")
		}
		if previous, exists := names[id]; exists && previous != name {
			return config, BadAuthRequest("同一参考图片只能设置一个名称")
		}
		names[id] = name
	}
	config.ReferenceNames = nil
	if len(names) > 0 {
		config.ReferenceNames = names
	}
	subjects := make(map[string]string, len(config.ReferenceSubjects))
	for resourceID, castID := range config.ReferenceSubjects {
		resourceID, castID = strings.TrimSpace(resourceID), strings.TrimSpace(castID)
		if !boundIDs[resourceID] {
			continue
		}
		if previous, exists := subjects[resourceID]; exists && previous != castID {
			return config, BadAuthRequest("同一参考图片只能关联一个主体")
		}
		if castID == "" {
			return config, BadAuthRequest("请选择参考图片对应的主体")
		}
		if _, err := repo.DramaCast(projectID, castID); err != nil {
			if !errors.Is(err, gorm.ErrRecordNotFound) {
				return config, err
			}
			return config, BadAuthRequest("参考图片关联的主体不存在或不属于当前作品")
		}
		subjects[resourceID] = castID
	}
	config.ReferenceSubjects = nil
	if len(subjects) > 0 {
		config.ReferenceSubjects = subjects
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
	return s.prepareDramaShotMediaDraft(repo, userID, projectID, shotID, kind, req, nil)
}

// QuoteDramaShotMedia checks an unsaved visual draft without saving configuration or reserving credits.
func (s *Service) QuoteDramaShotMedia(userID, projectID, shotID, kind string, req DramaShotMediaSaveRequest) (DramaShotMediaPreflight, error) {
	if kind != "image" && kind != "video" {
		return DramaShotMediaPreflight{}, BadAuthRequest("草稿报价只用于镜头图片或视频")
	}
	if _, _, err := s.dramaShotMediaScope(userID, projectID, shotID, kind); err != nil {
		return DramaShotMediaPreflight{}, err
	}
	if req.ExpectedRevision == nil {
		return DramaShotMediaPreflight{}, BadAuthRequest("请提供镜头媒体版本")
	}
	plan, err := s.prepareDramaShotMediaDraft(s.repo, userID, projectID, shotID, kind, DramaShotMediaActionRequest{ExpectedRevision: req.ExpectedRevision}, &req.Config)
	plan.view.ConfirmationToken = ""
	return plan.view, dramaShotMediaError(err)
}

func (s *Service) prepareDramaShotMediaDraft(repo *repository.Repository, userID, projectID, shotID, kind string, req DramaShotMediaActionRequest, draft *DramaShotMediaConfig) (dramaShotMediaPlan, error) {
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
	if draft != nil {
		config = *draft
		plan.view.Config = config
	}
	if row.ID == "" && draft == nil {
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
	config, issue, err := resolveDramaShotReferenceImages(repo, userID, projectID, kind, config)
	plan.view.Config = config
	if err != nil {
		return plan, err
	}
	if issue != "" {
		return blocked(issue)
	}
	config, err = s.normalizeDramaShotMediaConfig(repo, userID, projectID, kind, config)
	plan.view.Config = config
	if err != nil {
		return blocked(err.Error())
	}
	// 切换模式或清空参考图时允许先保存草稿，缺图只阻止生成准入。
	if kind == "image" && config.Operation == "image_to_image" && len(config.ReferenceResourceIDs) == 0 {
		return blocked("参考图生图需要至少一张参考图片")
	}
	if kind == "video" && config.Operation != "text_to_video" && len(config.ReferenceResourceIDs) == 0 && config.FirstFrameResourceID == "" && config.LastFrameResourceID == "" {
		return blocked("所选视频模式需要参考图片或首尾帧")
	}
	config, err = s.enrichDramaShotVideoPrompt(repo, *shot, *p, kind, config)
	plan.view.Config = config
	if err != nil {
		return plan, err
	}
	if config.Model.Empty() || config.Prompt == "" {
		return blocked("请填写镜头提示词并选择模型")
	}
	if kind == "video" {
		if err := s.validateDramaShotVideoScreen(config); err != nil {
			return blocked(err.Error())
		}
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
	effectivePrompt := stringValue(requestInput["prompt"])
	plan.view.ScopeHash = dramaShotMediaDigest([]any{projectID, shot, kind, config, effectivePrompt, p.Revision, p.GuideStep, intent})
	// The digest never contains credentials or signed URLs. Resource identities
	// and normalized parameters are immutable inputs; the real request is private.
	plan.view.ConfirmationToken = dramaShotMediaDigest([]any{projectID, shot, row, config, effectivePrompt, p.Revision, p.GuideStep, quote, intent})
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
		resolution := config.Resolution
		if profile, _ := s.dramaVideoProfile(config.Model); profile.video != nil {
			if profile.video.FixedScreenSpec != nil {
				if screen := profile.screen(config.AspectRatio, resolution); screen.Issue == "" {
					providerConfig["size"], resolution = screen.Size, screen.Resolution
				}
			} else if option := dramaShotVideoResolutionOption(profile.video, config.AspectRatio, resolution); option != "" {
				resolution = option
			}
		}
		providerConfig["vquality"], providerConfig["videoSeconds"], providerConfig["videoGenerateAudio"] = resolution, strconv.Itoa(config.Seconds), strconv.FormatBool(config.GenerateAudio)
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
	prompt, err := compileDramaShotReferencePrompt(config)
	if err != nil {
		return nil, err
	}
	if kind == "image" {
		instructions, err := dramaShotReferenceSubjectInstructions(repo, shot.ProjectID, config)
		if err != nil {
			return nil, err
		}
		if instructions != "" {
			prompt = instructions + "\n\n" + prompt
		}
	}
	var audios []any
	if kind == "video" {
		instructions, references, err := s.dramaShotVideoAssetInstructions(repo, userID, shot, config)
		if err != nil {
			return nil, err
		}
		if instructions != "" {
			prompt = instructions + "\n\n" + prompt
		}
		audios = references
		if rule := production.CameraPresetRule(shot.Camera); rule != "" {
			prompt += "\n运镜要求：" + rule
		}
	}
	input := map[string]any{"mode": kind, "prompt": prompt, "config": providerConfig, "referenceImages": refs, "metadata": metadata}
	if len(audios) > 0 {
		input["referenceAudios"] = audios
	}
	return input, nil
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
