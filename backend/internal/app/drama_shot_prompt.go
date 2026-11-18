package app

import (
	"fmt"
	"strings"

	"yingce/backend/internal/model"
	"yingce/backend/internal/production"
	"yingce/backend/internal/repository"
)

// A missing marker identifies legacy defaults. An explicit empty marker keeps
// manual drafts (including deliberately cleared text) out of automatic rebuilds.
func (s *Service) enrichDramaShotVideoPrompt(repo *repository.Repository, shot model.DramaShot, p model.DramaProduction, kind string, config DramaShotMediaConfig) (DramaShotMediaConfig, error) {
	if kind != "video" {
		return config, nil
	}
	prompt := strings.TrimSpace(config.Prompt)
	if config.PromptSourceHash != nil {
		if *config.PromptSourceHash == "" || *config.PromptSourceHash != dramaShotMediaDigest(prompt) {
			manual := ""
			config.PromptSourceHash = &manual
			return config, nil
		}
	} else if prompt != "" && prompt != strings.TrimSpace(shot.VideoPrompt) {
		manual := ""
		config.PromptSourceHash = &manual
		return config, nil
	}

	episode, err := repo.DramaEpisode(shot.ProjectID, shot.EpisodeID)
	if err != nil {
		return config, err
	}
	settings, meta := dramaEpisodeStyleSettings(parseDramaSettings(p.SettingsJSON), parseDramaBibleMeta(p.BibleJSON), *episode)
	shots, err := repo.DramaShots(shot.EpisodeID)
	if err != nil {
		return config, err
	}
	rows, err := repo.DramaSegments(shot.EpisodeID)
	if err != nil {
		return config, err
	}
	casts, err := repo.DramaCasts(shot.ProjectID)
	if err != nil {
		return config, err
	}
	castByID := make(map[string]model.DramaCast, len(casts))
	for _, cast := range casts {
		castByID[cast.ID] = cast
	}
	drafts := buildDramaSegmentDrafts(settings, meta, shots, castByID, rows)
	for _, draft := range drafts {
		for shotIndex, current := range draft.shots {
			if current.ID != shot.ID {
				continue
			}
			sourceReferences := dramaShotPromptSourceReferences(draft)
			// Only assets present in this shot become text-only subject context.
			currentDraft := buildDramaSegmentDrafts(settings, meta, []model.DramaShot{shot}, castByID, nil)[0]
			currentReferences := dramaShotPromptSourceReferences(currentDraft)
			byResource := map[string][]production.SegmentReference{}
			for _, candidate := range []dramaSegmentDraft{draft, currentDraft} {
				refs := dramaShotPromptSourceReferences(candidate)
				for index, ref := range candidate.view.Request.References {
					resourceID := ref.ResourceID
					if ref.CastID != "" {
						resourceID = castByID[ref.CastID].ImageResourceID
					}
					if resourceID != "" {
						byResource[resourceID] = append(byResource[resourceID], refs[index])
					}
				}
			}
			actual := []production.SegmentReference{}
			attached := map[string]bool{}
			candidatesFor := func(resourceID string) []production.SegmentReference {
				if cast, ok := castByID[config.ReferenceSubjects[resourceID]]; ok {
					return []production.SegmentReference{dramaShotSubjectReference(cast, castByID)}
				}
				return byResource[resourceID]
			}
			for index, id := range config.ReferenceResourceIDs {
				label := fmt.Sprintf("参考图%d", index+1)
				candidates := candidatesFor(id)
				if len(candidates) == 0 {
					actual = append(actual, production.SegmentReference{Identity: "resource:" + id, Label: label, Kind: "image", Name: "补充图片", Detail: "用户指定的视觉参考，不凭图片新增角色或台词"})
				}
				seenForImage := map[string]bool{}
				for _, reference := range candidates {
					if seenForImage[reference.Identity] {
						continue
					}
					seenForImage[reference.Identity] = true
					reference.Label = label
					actual = append(actual, reference)
					attached[reference.Identity] = true
				}
			}
			for _, frame := range []struct{ id, role string }{{config.FirstFrameResourceID, "首帧"}, {config.LastFrameResourceID, "尾帧"}} {
				for _, reference := range candidatesFor(frame.id) {
					if attached[reference.Identity] {
						continue
					}
					reference.Label = ""
					reference.Detail = "以" + frame.role + "中的主体外观为准；" + reference.Detail
					actual = append(actual, reference)
					attached[reference.Identity] = true
				}
			}
			for _, reference := range currentReferences {
				if !attached[reference.Identity] {
					reference.Label = ""
					actual = append(actual, reference)
				}
			}
			draft.input.References = actual
			draft.input.AspectRatio = firstNonEmpty(config.AspectRatio, settings.AspectRatio)
			written := ""
			for _, row := range rows {
				if row.SegmentIndex == shot.SegmentIndex && dramaPromptReady(row) {
					written = resolveDramaSegmentPromptForReferences(row, draft.view.Request.References, dramaShotWrittenPromptReferences(row, actual, castByID))
					break
				}
			}
			config.Prompt = production.ShotVideoPrompt(production.ShotVideoPromptInput{Segment: draft.input, ShotIndex: shotIndex, ShotNumber: shot.Position + 1, Seconds: config.Seconds, WrittenPrompt: written, WrittenPromptUsesShotReferences: true, SourceReferences: sourceReferences})
			if config.FirstFrameResourceID != "" {
				config.Prompt += "\n【首帧约束】以随请求附带的本镜首帧为起幅，保持其人物、站位、场景与光线，随后只执行本镜动作。"
			}
			if config.LastFrameResourceID != "" {
				config.Prompt += "\n【尾帧约束】在本镜时长内自然衔接至随请求附带的尾帧，不添加额外镜头或台词。"
			}
			hash := dramaShotMediaDigest(strings.TrimSpace(config.Prompt))
			config.PromptSourceHash = &hash
			return config, nil
		}
	}
	return config, BadAuthRequest("镜头已不在本集分镜中，请重新载入")
}

func dramaShotWrittenPromptReferences(row model.DramaSegment, attached []production.SegmentReference, casts map[string]model.DramaCast) []DramaSegmentReference {
	refs := make([]DramaSegmentReference, 0, len(attached))
	labels := map[string]string{}
	ambiguous := map[string]bool{}
	for _, ref := range attached {
		if label := labels[ref.Identity]; label != "" && ref.Label != "" && ref.Label != label {
			ambiguous[ref.Identity] = true
		}
		if ref.Label != "" {
			labels[ref.Identity] = ref.Label
		}
	}
	for _, ref := range attached {
		entry := DramaSegmentReference{Label: labels[ref.Identity], Name: ref.Name}
		if ambiguous[ref.Identity] {
			entry.Label = ""
		}
		if id, ok := strings.CutPrefix(ref.Identity, "cast:"); ok {
			entry.CastID = id
		} else if id, ok := strings.CutPrefix(ref.Identity, "resource:"); ok {
			entry.ResourceID = id
		} else {
			continue
		}
		refs = append(refs, entry)
	}
	// A manual mention need not be in the segment's selected attachments.
	return append(refs, dramaSegmentPromptSubjects(casts, firstNonEmpty(row.VideoPromptOverride, row.VideoPrompt))...)
}

func dramaShotSubjectReference(cast model.DramaCast, casts map[string]model.DramaCast) production.SegmentReference {
	name, voice := cast.Name, cast.VoiceInstructions
	if cast.ParentID != "" {
		if parent, ok := casts[cast.ParentID]; ok {
			name, voice = parent.Name, parent.VoiceInstructions
		}
		if cast.LookName != "" {
			name += "·" + cast.LookName
		}
	}
	return production.SegmentReference{Identity: "cast:" + cast.ID, Kind: cast.Kind, Name: name, Detail: firstNonEmpty(cast.Appearance, cast.Description), Voice: voice}
}

func dramaShotPromptSourceReferences(draft dramaSegmentDraft) []production.SegmentReference {
	refs := append([]production.SegmentReference{}, draft.input.References...)
	for index := range refs {
		ref := draft.view.Request.References[index]
		if ref.CastID != "" {
			refs[index].Identity = "cast:" + ref.CastID
		} else {
			refs[index].Identity = "resource:" + ref.ResourceID
		}
	}
	return refs
}
