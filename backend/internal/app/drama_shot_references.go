package app

import (
	"errors"
	"fmt"
	"maps"
	"regexp"
	"slices"
	"strings"

	"gorm.io/gorm"
	"yingce/backend/internal/model"
	"yingce/backend/internal/production"
	"yingce/backend/internal/repository"
)

var dramaShotImageToken = regexp.MustCompile(`@\[shot-image:([^\]\r\n]+)\]`)

// Only subject references in reference-to-video follow the adopted asset.
// Keep the original config editable if a binding cannot be resolved.
func resolveDramaShotReferenceImages(repo *repository.Repository, userID, projectID, kind string, config DramaShotMediaConfig) (DramaShotMediaConfig, string, error) {
	if kind != "video" || config.Operation != "reference_to_video" || len(config.ReferenceSubjects) == 0 {
		return config, "", nil
	}
	remapped, origins := map[string]string{}, map[string]string{}
	for _, resourceID := range config.ReferenceResourceIDs {
		id := strings.TrimSpace(resourceID)
		if id == "" {
			continue
		}
		current := id
		if castID := strings.TrimSpace(config.ReferenceSubjects[id]); castID != "" {
			cast, err := repo.DramaCast(projectID, castID)
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return config, "参考图片关联的主体不存在或不属于当前作品", nil
			}
			if err != nil {
				return config, "", err
			}
			current = cast.ImageResourceID
			missing := fmt.Sprintf("主体「%s」当前没有可用的采用图，请先在资产中采用图片或移除此引用", firstNonEmpty(cast.LookName, cast.Name, "未命名主体"))
			if current == "" {
				return config, missing, nil
			}
			resource, err := repo.ResourceForUser(userID, current)
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return config, missing, nil
			}
			if err != nil {
				return config, "", err
			}
			if resource.Status != model.ResourceStatusReady || resource.Kind != "image" || !strings.HasPrefix(resource.MimeType, "image/") {
				return config, missing, nil
			}
			if id != current {
				remapped[id] = current
			}
		}
		if previous, ok := origins[current]; ok && previous != id {
			return config, "多张参考图当前指向同一张主体图片，请移除重复引用后再生成", nil
		}
		origins[current] = id
	}
	if len(remapped) == 0 {
		return config, "", nil
	}

	config.ReferenceResourceIDs = slices.Clone(config.ReferenceResourceIDs)
	names, subjects := maps.Clone(config.ReferenceNames), maps.Clone(config.ReferenceSubjects)
	for oldID := range remapped {
		delete(names, oldID)
		delete(subjects, oldID)
	}
	for index, resourceID := range config.ReferenceResourceIDs {
		id := strings.TrimSpace(resourceID)
		if current := remapped[id]; current != "" {
			config.ReferenceResourceIDs[index] = current
			subjects[current] = config.ReferenceSubjects[id]
		}
	}
	config.ReferenceNames, config.ReferenceSubjects = names, subjects
	before := strings.TrimSpace(config.Prompt)
	config.Prompt = dramaShotImageToken.ReplaceAllStringFunc(config.Prompt, func(token string) string {
		if current := remapped[dramaShotImageToken.FindStringSubmatch(token)[1]]; current != "" {
			return "@[shot-image:" + current + "]"
		}
		return token
	})
	if config.PromptSourceHash != nil && *config.PromptSourceHash == dramaShotMediaDigest(before) {
		hash := dramaShotMediaDigest(strings.TrimSpace(config.Prompt))
		config.PromptSourceHash = &hash
	}
	return config, "", nil
}

func lockDramaShotReferenceSubjects(repo *repository.Repository, projectID, kind string, config DramaShotMediaConfig) error {
	if kind != "video" || config.Operation != "reference_to_video" {
		return nil
	}
	castIDs := []string{}
	for _, resourceID := range config.ReferenceResourceIDs {
		if castID := strings.TrimSpace(config.ReferenceSubjects[strings.TrimSpace(resourceID)]); castID != "" {
			castIDs = append(castIDs, castID)
		}
	}
	slices.Sort(castIDs)
	for _, castID := range slices.Compact(castIDs) {
		if _, err := repo.DramaCastForUpdate(projectID, castID); err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return BadAuthRequest("参考图片关联的主体已移除，请重新选择")
			}
			return err
		}
	}
	return nil
}

// Drafts keep resource identity; the provider receives only this request's image order.
func compileDramaShotReferencePrompt(config DramaShotMediaConfig) (string, error) {
	labels := make(map[string]string, len(config.ReferenceResourceIDs))
	for index, id := range config.ReferenceResourceIDs {
		labels[id] = fmt.Sprintf("参考图%d", index+1)
	}
	missing := false
	prompt := dramaShotImageToken.ReplaceAllStringFunc(config.Prompt, func(token string) string {
		id := dramaShotImageToken.FindStringSubmatch(token)[1]
		if label := labels[id]; label != "" {
			return label
		}
		missing = true
		return token
	})
	if missing {
		return "", BadAuthRequest("提示词引用的参考图片已被移除，请重新选择引用")
	}
	if unknown := production.UnknownReferenceTokens(prompt, len(config.ReferenceResourceIDs)); len(unknown) > 0 {
		return "", BadAuthRequest("提示词引用了未附带的图片：" + strings.Join(unknown, "、"))
	}
	return prompt, nil
}

func dramaShotReferenceSubjectInstructions(repo *repository.Repository, projectID string, config DramaShotMediaConfig) (string, error) {
	if len(dramaShotMediaReferenceIDs(config)) == 0 {
		return "", nil
	}
	casts, err := repo.DramaCasts(projectID)
	if err != nil {
		return "", err
	}
	byID := make(map[string]model.DramaCast, len(casts))
	byResource := map[string][]model.DramaCast{}
	for _, cast := range casts {
		byID[cast.ID] = cast
		if cast.ImageResourceID != "" {
			byResource[cast.ImageResourceID] = append(byResource[cast.ImageResourceID], cast)
		}
	}
	lines := []string{}
	appendSubject := func(id, label string) {
		subjects := byResource[id]
		if explicit, ok := byID[config.ReferenceSubjects[id]]; ok {
			subjects = []model.DramaCast{explicit}
		}
		for _, subject := range subjects {
			reference := dramaShotSubjectReference(subject, byID)
			line := label + "对应" + reference.Name
			if reference.Detail != "" {
				line += "：" + reference.Detail
			}
			lines = append(lines, line)
		}
	}
	for index, id := range config.ReferenceResourceIDs {
		appendSubject(id, fmt.Sprintf("参考图%d", index+1))
	}
	for _, frame := range []struct{ id, label string }{{config.FirstFrameResourceID, "首帧"}, {config.LastFrameResourceID, "尾帧"}} {
		if frame.id != "" {
			appendSubject(frame.id, frame.label)
		}
	}
	if len(lines) == 0 {
		return "", nil
	}
	return "【本次图片与主体对应】\n" + strings.Join(lines, "\n"), nil
}
