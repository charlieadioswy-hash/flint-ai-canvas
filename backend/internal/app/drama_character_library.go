package app

import (
	"errors"
	"strings"
	"time"
	"unicode/utf8"

	"yingce/backend/internal/model"
	"yingce/backend/internal/repository"

	"gorm.io/gorm"
)

type ImportDramaCharacterLibraryRequest struct {
	EpisodeID            string `json:"episodeId,omitempty"`
	ExpectedRevision     *int64 `json:"expectedRevision"`
	LibraryAssetID       string `json:"libraryAssetId"`
	LibraryVersionID     string `json:"libraryVersionId"`
	TargetCastID         string `json:"targetCastId,omitempty"`
	ExpectedCastRevision *int64 `json:"expectedCastRevision,omitempty"`
	ReplaceText          bool   `json:"replaceText"`
	RepresentationID     string `json:"representationId,omitempty"`
	IncludeVoice         bool   `json:"includeVoice"`
}

type SaveDramaCharacterLibraryRequest struct {
	ExpectedRevision     *int64 `json:"expectedRevision"`
	ExpectedCastRevision *int64 `json:"expectedCastRevision"`
	Name                 string `json:"name"`
}

type UpdateDramaCharacterDefinitionRequest struct {
	ExpectedRevision     *int64            `json:"expectedRevision"`
	ExpectedCastRevision *int64            `json:"expectedCastRevision"`
	Fields               map[string]string `json:"fields"`
}

func requireDramaCharacterSnapshot(revision *int64) error {
	if revision == nil || *revision < 0 {
		return BadAuthRequest("请刷新作品后提交当前版本")
	}
	return nil
}

func requireDramaCharacterBase(cast *model.DramaCast, expected *int64) error {
	if cast.Kind != "character" || cast.ParentID != "" {
		return BadAuthRequest("此操作只支持基础角色，请从所属角色进入")
	}
	if expected != nil && cast.Revision != *expected {
		return dramaGuideConflict("人物信息已有更新，请刷新后重试")
	}
	return nil
}

func requireDramaCharacterIdle(repo *repository.Repository, projectID string, cast model.DramaCast) error {
	active, err := repo.DramaTextJobsActive(projectID)
	if err != nil {
		return err
	}
	if active {
		return dramaGuideConflict("文字任务正在进行，请完成后再调整人物")
	}
	jobs, err := repo.DramaJobsByStatus(projectID, model.DramaJobQueued, model.DramaJobRunning)
	if err != nil {
		return err
	}
	for _, job := range jobs {
		if job.Kind == model.DramaJobCastImage && job.CastID == cast.ID {
			return dramaGuideConflict("角色参考图正在生成，请完成后重试")
		}
	}
	if cast.ImageStatus == model.DramaMediaQueued || cast.ImageStatus == model.DramaMediaRunning {
		return dramaGuideConflict("角色参考图正在生成，请完成后重试")
	}
	return nil
}

// 导入是一次可审阅的复制：只采用所选的现有形象/声音，不调度任务、不收费、不修改角色库。
func (s *Service) ImportDramaCharacterLibrary(userID, projectID string, req ImportDramaCharacterLibraryRequest) (model.DramaCast, error) {
	if _, _, err := s.dramaForUser(userID, projectID); err != nil {
		return model.DramaCast{}, err
	}
	if err := requireDramaCharacterSnapshot(req.ExpectedRevision); err != nil {
		return model.DramaCast{}, err
	}
	if strings.TrimSpace(req.LibraryAssetID) == "" || strings.TrimSpace(req.LibraryVersionID) == "" {
		return model.DramaCast{}, BadAuthRequest("请选择角色库中的具体版本")
	}
	if req.TargetCastID != "" && req.ExpectedCastRevision == nil {
		return model.DramaCast{}, BadAuthRequest("请刷新要导入的目标角色")
	}
	release, err := s.lockDramaSchedule(projectID)
	if err != nil {
		return model.DramaCast{}, err
	}
	defer release()
	var result model.DramaCast
	err = s.withDramaTextEdit(projectID, req.ExpectedRevision, false, func(repo *repository.Repository) error {
		p, err := repo.DramaProduction(projectID)
		if err != nil {
			return err
		}
		if dramaGuideActive(p) {
			if err := requireDramaGuideAssetEdit(p); err != nil {
				return err
			}
		}
		if req.EpisodeID != "" {
			if _, err := repo.DramaEpisode(projectID, req.EpisodeID); err != nil {
				return err
			}
		}
		activeText, err := repo.DramaTextJobsActive(projectID)
		if err != nil {
			return err
		}
		if activeText {
			return dramaGuideConflict("文字任务正在进行，请完成后再导入人物")
		}
		asset, err := repo.UserCharacterAssetForUpdate(userID, req.LibraryAssetID)
		if err != nil {
			return err
		}
		if asset.PrimaryVersionID != req.LibraryVersionID {
			return dramaGuideConflict("角色库版本已有更新，请重新选择后导入")
		}
		version, err := repo.AssetVersion(req.LibraryVersionID)
		if err != nil {
			return err
		}
		if version.AssetID != asset.ID || version.Status == model.AssetVersionStatusArchived {
			return BadAuthRequest("角色库版本不可用")
		}
		definition, err := parseDramaCharacterDefinition(version.DefinitionJSON)
		if err != nil {
			return err
		}
		casts, err := repo.DramaCastsForUpdate(projectID)
		if err != nil {
			return err
		}
		now := time.Now()
		copy := model.DramaCast{ID: newID(), ProjectID: projectID, Kind: "character", Revision: 1, AliasesJSON: "[]", ImageStatus: model.DramaMediaDraft, CreatedAt: now, UpdatedAt: now}
		var current *model.DramaCast
		for _, cast := range casts {
			copy.Position = max(copy.Position, cast.Position+1)
			if cast.ID == req.TargetCastID {
				row := cast
				current = &row
			}
		}
		if req.TargetCastID != "" && current == nil {
			return gorm.ErrRecordNotFound
		}
		if current != nil {
			if err := requireDramaCharacterBase(current, req.ExpectedCastRevision); err != nil {
				return err
			}
			if err := requireDramaCharacterIdle(repo, projectID, *current); err != nil {
				return err
			}
			copy = *current
		}
		if current == nil || req.ReplaceText {
			if current != nil {
				previous, err := parseDramaCharacterDefinition(current.DefinitionJSON)
				if err != nil {
					return err
				}
				for key, value := range previous {
					if _, exists := definition[key]; !exists && !knownDramaCharacterDefinitionKey(key) {
						definition[key] = value
					}
				}
			}
			dramaCharacterLibraryText(&copy, strings.TrimSpace(asset.Title), definition)
			if current != nil {
				// 目标角色的身份名称由剧本决定；采用库文字不会把镜头里的角色改名。
				copy.Name = current.Name
			}
		} else {
			// 未勾选替换时，当前手工文字和来源原文优先，库中扩展信息可以补充。
			preserved, err := dramaCharacterDefinitionForCast(*current)
			if err != nil {
				return err
			}
			for key := range definition {
				if knownDramaCharacterDefinitionKey(key) {
					delete(definition, key)
				}
			}
			for key, value := range preserved {
				definition[key] = value
			}
		}
		if copy.Name == "" || utf8.RuneCountInString(copy.Name) > 60 {
			return BadAuthRequest("角色库名称需为 1 到 60 字，请先在角色库调整")
		}
		if utf8.RuneCountInString(copy.Role) > 120 {
			return BadAuthRequest("角色库的角色定位不能超过 120 字，请先在角色库调整")
		}
		for _, cast := range casts {
			if cast.ID != copy.ID && cast.Kind == "character" && cast.ParentID == "" && strings.EqualFold(strings.TrimSpace(cast.Name), copy.Name) {
				return dramaGuideConflict("当前作品已有同名角色，请选中该角色后导入")
			}
		}
		if req.RepresentationID != "" {
			representations, err := repo.AssetRepresentations(version.ID)
			if err != nil {
				return err
			}
			resourceID := ""
			for _, representation := range representations {
				if representation.ID == req.RepresentationID && representation.MediaType == "image" {
					resourceID = representation.ResourceID
				}
			}
			if resourceID == "" {
				return BadAuthRequest("所选形象不属于这个角色版本，请重新选择")
			}
			copy.ImageResourceID, copy.ImageStatus, copy.Locked = resourceID, model.DramaMediaReady, true
		}
		if req.IncludeVoice {
			binding, err := repo.CharacterVoiceBinding(version.ID)
			if err != nil {
				return BadAuthRequest("这个角色版本尚未绑定可用声音")
			}
			profile, err := repo.VoiceProfileForUser(userID, binding.VoiceProfileID)
			if err != nil || profile.Status != "active" {
				return BadAuthRequest("角色库声音已不可用，请重新选择")
			}
			copy.VoiceProfileID, copy.VoiceSampleResourceID = profile.ID, profile.SampleResourceID
			if current == nil || req.ReplaceText {
				copy.VoiceInstructions = firstNonEmpty(binding.Instructions, copy.VoiceInstructions)
			}
		}
		adopted := copy
		if req.RepresentationID == "" {
			adopted.ImageResourceID = ""
		}
		if !req.IncludeVoice {
			adopted.VoiceProfileID, adopted.VoiceSampleResourceID = "", ""
		}
		if err := validateDramaCharacterLibraryMedia(repo, userID, adopted); err != nil {
			return err
		}
		if current != nil && req.ReplaceText && req.RepresentationID == "" && current.ImageResourceID != "" && (copy.Appearance != current.Appearance || copy.Description != current.Description || copy.ImagePrompt != current.ImagePrompt) {
			copy.ImageStatus = model.DramaMediaStale
		}
		copy.LibraryAssetID, copy.LibraryVersionID = asset.ID, version.ID
		copy.DefinitionJSON, err = dramaCharacterDefinitionJSON(definition)
		if err != nil {
			return err
		}
		if current == nil {
			if copy.ImageResourceID != "" {
				copy.ImageVersion = 1
			}
			if err := repo.CreateDramaCasts([]model.DramaCast{copy}); err != nil {
				return err
			}
		} else {
			if copy.ImageResourceID != current.ImageResourceID {
				if err := repo.PreserveDramaCastImage(*current); err != nil {
					return err
				}
				copy.ImageVersion++
			}
			fields := map[string]any{
				"name": copy.Name, "aliases_json": copy.AliasesJSON, "role": copy.Role,
				"description": copy.Description, "appearance": copy.Appearance, "image_prompt": copy.ImagePrompt,
				"definition_json": copy.DefinitionJSON, "library_asset_id": copy.LibraryAssetID, "library_version_id": copy.LibraryVersionID,
				"image_status": copy.ImageStatus, "image_version": copy.ImageVersion, "locked": copy.Locked,
				"voice_profile_id": copy.VoiceProfileID, "voice_sample_resource_id": copy.VoiceSampleResourceID, "voice_instructions": copy.VoiceInstructions,
			}
			if copy.ImageResourceID != current.ImageResourceID {
				fields["image_resource_id"] = copy.ImageResourceID
			}
			if err := repo.UpdateDramaCastFields(copy.ID, fields); err != nil {
				return err
			}
		}
		if copy.ImageResourceID != "" && (current == nil || copy.ImageResourceID != current.ImageResourceID) {
			if err := repo.CreateDramaTake(&model.DramaTake{ID: newID(), ProjectID: projectID, OwnerID: copy.ID, Kind: "cast", ResourceID: copy.ImageResourceID, Prompt: "从我的角色库导入形象", CreatedAt: now}); err != nil {
				return err
			}
		}
		row, err := repo.DramaCast(projectID, copy.ID)
		if err != nil {
			return err
		}
		if req.EpisodeID != "" {
			if err := repo.MergeDramaEpisodeAssets(projectID, []string{req.EpisodeID}, []string{row.ID}); err != nil {
				return err
			}
		}
		result = *row
		return nil
	})
	return result, dramaLookupError(err)
}

func validateDramaCharacterLibraryMedia(repo *repository.Repository, userID string, cast model.DramaCast) error {
	resourceIDs := []string{}
	for _, id := range []string{cast.ImageResourceID, cast.VoiceSampleResourceID} {
		if id != "" {
			resourceIDs = append(resourceIDs, id)
		}
	}
	if err := repo.LockDramaCastImageReferences(userID, resourceIDs); err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return BadAuthRequest("角色形象或声音样本不存在、未就绪或无权使用")
		}
		return err
	}
	for _, media := range []struct{ id, kind, prefix string }{{cast.ImageResourceID, "image", "image/"}, {cast.VoiceSampleResourceID, "audio", "audio/"}} {
		if media.id == "" {
			continue
		}
		resource, err := repo.ResourceForUser(userID, media.id)
		if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		if err != nil || resource.Kind != media.kind || resource.Status != model.ResourceStatusReady || (media.kind == "image" && !strings.HasPrefix(resource.MimeType, media.prefix)) || (media.kind == "audio" && !isSupportedVoiceSampleMimeType(resource.MimeType)) {
			return BadAuthRequest("角色形象或声音样本不存在、未就绪或无权使用")
		}
	}
	if cast.ImageResourceID != "" && cast.ImageStatus != model.DramaMediaReady {
		return BadAuthRequest("角色当前形象尚未就绪，请先完成或移除失效图片")
	}
	if cast.VoiceProfileID != "" {
		profile, err := repo.VoiceProfileForUser(userID, cast.VoiceProfileID)
		if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		if err != nil || profile.Status != "active" || profile.SampleResourceID != cast.VoiceSampleResourceID {
			return BadAuthRequest("角色声音不可用或样本不一致")
		}
	}
	return nil
}

// 只另存新卡，不改变作品的角色、库来源或已有角色库卡片。
func (s *Service) SaveDramaCharacterLibrary(userID, projectID, castID string, req SaveDramaCharacterLibraryRequest) (CharacterAssetSummary, error) {
	if _, _, err := s.dramaForUser(userID, projectID); err != nil {
		return CharacterAssetSummary{}, err
	}
	for _, revision := range []*int64{req.ExpectedRevision, req.ExpectedCastRevision} {
		if err := requireDramaCharacterSnapshot(revision); err != nil {
			return CharacterAssetSummary{}, err
		}
	}
	release, err := s.lockDramaSchedule(projectID)
	if err != nil {
		return CharacterAssetSummary{}, err
	}
	defer release()
	var result CharacterAssetSummary
	err = s.repo.Transaction(func(repo *repository.Repository) error {
		p, err := repo.DramaProductionForUpdate(projectID)
		if err != nil {
			return err
		}
		if p.Revision != *req.ExpectedRevision {
			return repository.ErrDramaGuideChanged
		}
		cast, err := repo.DramaCast(projectID, castID)
		if err != nil {
			return err
		}
		if err := requireDramaCharacterBase(cast, req.ExpectedCastRevision); err != nil {
			return err
		}
		if err := validateDramaCharacterLibraryMedia(repo, userID, *cast); err != nil {
			return err
		}
		definition, err := dramaCharacterDefinitionForCast(*cast)
		if err != nil {
			return err
		}
		raw, err := dramaCharacterDefinitionJSON(definition)
		if err != nil {
			return err
		}
		name := strings.TrimSpace(req.Name)
		if name == "" || utf8.RuneCountInString(name) > 60 {
			return BadAuthRequest("角色库名称需为 1 到 60 字")
		}
		now := time.Now()
		assetID, versionID := newID(), newID()
		payload, err := characterAssetPayload(assetID, versionID, name, []byte(raw), now, now)
		if err != nil {
			return err
		}
		asset := model.Asset{ID: assetID, UserID: userID, Kind: "entity", Category: model.AssetCategoryCharacter, Status: model.AssetVersionStatusConfirmed, PrimaryVersionID: versionID, Title: name, PayloadJSON: payload, CreatedAt: now, UpdatedAt: now}
		version := model.AssetVersion{ID: versionID, AssetID: assetID, Version: 1, Status: model.AssetVersionStatusConfirmed, DefinitionJSON: raw, CreatedAt: now, UpdatedAt: now}
		representations := []model.AssetRepresentation{}
		if cast.ImageResourceID != "" {
			representations = append(representations, model.AssetRepresentation{ID: newID(), AssetVersionID: versionID, ResourceID: cast.ImageResourceID, MediaType: "image", Role: "primary", MetadataJSON: `{}`, CreatedAt: now})
		}
		var voice *model.CharacterVoiceBinding
		profileID := cast.VoiceProfileID
		if profileID == "" && cast.VoiceSampleResourceID != "" {
			profile, err := repo.VoiceProfileBySampleResource(userID, cast.VoiceSampleResourceID)
			if errors.Is(err, gorm.ErrRecordNotFound) {
				profile = &model.VoiceProfile{ID: newID(), UserID: userID, Name: name + " · 声音", Provider: "user_upload", VoiceKey: "sample:" + cast.VoiceSampleResourceID, SampleResourceID: cast.VoiceSampleResourceID, Status: "active", CompatibleModelsJSON: "[]", CreatedAt: now, UpdatedAt: now}
				err = repo.CreateVoiceProfile(profile)
			}
			if err != nil {
				return err
			}
			profileID = profile.ID
		}
		if profileID != "" {
			voice = &model.CharacterVoiceBinding{ID: newID(), AssetVersionID: versionID, VoiceProfileID: profileID, Instructions: cast.VoiceInstructions, CreatedAt: now, UpdatedAt: now}
		}
		if err := repo.CreateUserCharacter(&asset, &version, representations, voice); err != nil {
			return err
		}
		// 使用同一事务中的仓库读取新卡；不存在跨请求的半成品。
		result, err = (&Service{repo: repo}).characterAssetDetail(userID, &asset)
		return err
	})
	return result, dramaLookupError(dramaGuideError(err))
}

func (s *Service) UpdateDramaCharacterDefinition(userID, projectID, castID string, req UpdateDramaCharacterDefinitionRequest) (model.DramaCast, error) {
	if _, _, err := s.dramaForUser(userID, projectID); err != nil {
		return model.DramaCast{}, err
	}
	for _, revision := range []*int64{req.ExpectedRevision, req.ExpectedCastRevision} {
		if err := requireDramaCharacterSnapshot(revision); err != nil {
			return model.DramaCast{}, err
		}
	}
	if err := validateDramaDefinitionFields(req.Fields); err != nil {
		return model.DramaCast{}, err
	}
	release, err := s.lockDramaSchedule(projectID)
	if err != nil {
		return model.DramaCast{}, err
	}
	defer release()
	var result model.DramaCast
	err = s.withDramaTextEdit(projectID, req.ExpectedRevision, false, func(repo *repository.Repository) error {
		p, err := repo.DramaProduction(projectID)
		if err != nil {
			return err
		}
		if dramaGuideActive(p) {
			if err := requireDramaGuideAssetEdit(p); err != nil {
				return err
			}
		}
		cast, err := repo.DramaCast(projectID, castID)
		if err != nil {
			return err
		}
		if err := requireDramaCharacterBase(cast, req.ExpectedCastRevision); err != nil {
			return err
		}
		if err := requireDramaCharacterIdle(repo, projectID, *cast); err != nil {
			return err
		}
		definition, err := dramaCharacterDefinitionForCast(*cast)
		if err != nil {
			return err
		}
		for key, value := range req.Fields {
			definition[key] = value
		}
		raw, err := dramaCharacterDefinitionJSON(definition)
		if err != nil {
			return err
		}
		fields := map[string]any{"definition_json": raw}
		if role, ok := req.Fields["role"]; ok {
			fields["role"] = role
		}
		if err := repo.UpdateDramaCastFields(castID, fields); err != nil {
			return err
		}
		row, err := repo.DramaCast(projectID, castID)
		if err == nil {
			result = *row
		}
		return err
	})
	return result, dramaLookupError(err)
}
