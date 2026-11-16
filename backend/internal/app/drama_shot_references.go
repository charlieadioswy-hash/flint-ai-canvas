package app

import (
	"fmt"
	"regexp"
	"strings"

	"yingce/backend/internal/model"
	"yingce/backend/internal/production"
	"yingce/backend/internal/repository"
)

var dramaShotImageToken = regexp.MustCompile(`@\[shot-image:([^\]\r\n]+)\]`)

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
