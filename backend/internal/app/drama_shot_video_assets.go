package app

import (
	"errors"
	"fmt"
	"strings"

	"gorm.io/gorm"
	"yingce/backend/internal/model"
	"yingce/backend/internal/production"
	"yingce/backend/internal/repository"
)

// 单镜正文可手工编写；发送时独立读取资产，避免保存的正文固化外观与声线。
func (s *Service) dramaShotVideoAssetInstructions(repo *repository.Repository, userID string, shot model.DramaShot, config DramaShotMediaConfig) (string, []any, error) {
	casts, err := repo.DramaCasts(shot.ProjectID)
	if err != nil {
		return "", nil, err
	}
	byID := make(map[string]model.DramaCast, len(casts))
	byResource := map[string][]string{}
	for _, cast := range casts {
		byID[cast.ID] = cast
		if cast.ImageResourceID != "" {
			byResource[cast.ImageResourceID] = append(byResource[cast.ImageResourceID], cast.ID)
		}
	}
	ids := []string{}
	seen := map[string]bool{}
	include := func(id string) {
		if _, ok := byID[id]; ok && !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	for _, draft := range buildDramaSegmentDrafts(DramaSettings{}, dramaBibleMeta{}, []model.DramaShot{shot}, byID, nil) {
		for _, reference := range draft.view.Request.References {
			include(reference.CastID)
		}
	}
	// 画外说话人也要带声线；同一角色已有造型时沿用造型的身份与本体声线。
	index := production.NewCastIndex()
	for _, cast := range casts {
		if cast.Kind == "character" && cast.ParentID == "" {
			index.Add(cast.ID, append([]string{cast.Name}, decodeStringList(cast.AliasesJSON)...)...)
		}
	}
	speakerID := ""
	if strings.TrimSpace(shot.Dialogue) != "" && !production.IsNarrator(shot.Speaker) {
		speakerID, _ = index.Lookup(shot.Speaker)
		found := false
		for _, id := range ids {
			if id == speakerID || byID[id].ParentID == speakerID {
				found = true
			}
		}
		if !found {
			include(speakerID)
		}
	}
	labels := map[string][]string{}
	bind := func(resourceID, label string) {
		if resourceID == "" {
			return
		}
		subjectIDs := byResource[resourceID]
		if explicit, ok := byID[config.ReferenceSubjects[resourceID]]; ok {
			subjectIDs = []string{explicit.ID}
		}
		for _, id := range subjectIDs {
			include(id)
			labels[id] = append(labels[id], label)
		}
	}
	for i, resourceID := range config.ReferenceResourceIDs {
		bind(resourceID, fmt.Sprintf("参考图%d", i+1))
	}
	bind(config.FirstFrameResourceID, "首帧")
	bind(config.LastFrameResourceID, "尾帧")
	if len(ids) == 0 {
		return "", nil, nil
	}
	profile, profileErr := s.dramaVideoProfile(config.Model)
	// 段模型的时长与开场模式限制不适用于单镜，只读取已解析出的能力。
	if profileErr != nil && profile.video == nil {
		return "", nil, profileErr
	}
	generateAudio := config.GenerateAudio && profile.GenerateAudio
	audios := []any{}
	audioLabel := ""
	if generateAudio && config.Operation == "reference_to_video" && len(config.ReferenceResourceIDs) > 0 && profile.MaxAudios > 0 && speakerID != "" {
		cast := byID[speakerID]
		if cast.VoiceSampleResourceID != "" {
			resource, resourceErr := repo.ResourceForUser(userID, cast.VoiceSampleResourceID)
			if resourceErr != nil && !errors.Is(resourceErr, gorm.ErrRecordNotFound) {
				return "", nil, resourceErr
			}
			if resourceErr == nil && resource.Kind == "audio" && resource.Status == model.ResourceStatusReady && (profile.MaxAudioSeconds <= 0 || resource.DurationMs <= int64(profile.MaxAudioSeconds)*1000) {
				audioLabel = "参考音频1"
				audios = append(audios, map[string]any{"id": audioLabel, "name": audioLabel, "type": resource.MimeType, "mimeType": resource.MimeType, "storageKey": "resource:" + resource.ID, "bytes": resource.Size, "durationMs": resource.DurationMs})
			}
		}
	}
	lines := []string{"【本次最新资产设定】", "以下设定在生成时读取，覆盖正文中冲突的固定外观与声线；剧情、动作、台词与运镜仍按正文。实际附带的图片优先约束对应资产的外观与空间，文字补充其余细节。"}
	for _, id := range ids {
		cast := byID[id]
		reference := dramaShotSubjectReference(cast, byID)
		line := reference.Name
		if len(labels[id]) > 0 {
			line = strings.Join(labels[id], "、") + "对应" + reference.Name + "，外观与空间以所附图片为准"
		}
		if reference.Detail != "" {
			line += "；最新外观设定：" + reference.Detail
		}
		lines = append(lines, line+"。")
		if cast.Kind == "character" && reference.Voice != "" {
			lines = append(lines, reference.Name+"的最新固定声线："+reference.Voice+"。")
		}
	}
	if !generateAudio {
		lines = append(lines, "本次不生成声音，不生成对白音轨与音效；上面的声线只记录资产设定，不要求本次发声。")
	} else if audioLabel != "" {
		lines = append(lines, audioLabel+"对应"+byID[speakerID].Name+"的声音；该角色音色以随请求附带的声音样本为准，正文只控制本镜情绪、语速、停顿与表演，不新增台词。")
	} else {
		lines = append(lines, "本次未附带声音样本，角色音色按最新固定声线文字设定，情绪、语速与停顿按本镜正文；不新增台词。")
	}
	return strings.Join(lines, "\n"), audios, nil
}
