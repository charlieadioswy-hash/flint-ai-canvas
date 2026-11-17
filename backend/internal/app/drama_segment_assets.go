package app

import (
	"strings"

	"yingce/backend/internal/model"
	"yingce/backend/internal/production"
)

// 动态资产独立于段稿：旧稿中的固定设定不再要求重新撰写，剧情中的临时状态仍保留。
func dramaSegmentLatestAssets(draft dramaSegmentDraft, request DramaSegmentRequest, casts map[string]model.DramaCast) []string {
	lines := []string{}
	seen, voices := map[string]bool{}, map[string]bool{}
	addVoice := func(cast model.DramaCast) {
		if cast.Kind != "character" || voices[cast.ID] || !request.GenerateAudio || strings.TrimSpace(cast.VoiceInstructions) == "" {
			return
		}
		voices[cast.ID] = true
		name := cast.Name
		if aliases := decodeStringList(cast.AliasesJSON); len(aliases) > 0 {
			name += "（别名／旧名：" + strings.Join(aliases, "、") + "，均指同一角色）"
		}
		lines = append(lines, name+"；最新固定声线："+cast.VoiceInstructions)
	}
	add := func(id, label string) {
		cast, ok := casts[id]
		if !ok || seen[id] {
			return
		}
		seen[id] = true
		name := cast.Name
		detail := strings.TrimSpace(firstNonEmpty(cast.Appearance, cast.Description))
		base := cast
		if parent, ok := casts[cast.ParentID]; ok {
			base = parent
			detail = strings.TrimSpace(dramaLookAppearance(parent, cast))
			name = parent.Name
			if cast.LookName != "" {
				name += "·" + cast.LookName
			}
		}
		identity := name
		if label != "" {
			identity += "（" + label + "）"
		}
		aliases := append(decodeStringList(base.AliasesJSON), decodeStringList(cast.AliasesJSON)...)
		if len(aliases) > 0 {
			identity += "，别名／旧名：" + strings.Join(uniqueStrings(aliases), "、") + "，均指同一资产"
		}
		if detail != "" {
			lines = append(lines, identity+"；最新外观／空间设定："+detail)
		} else {
			lines = append(lines, identity)
		}
		addVoice(base)
	}
	for _, ref := range request.References {
		add(ref.CastID, ref.Label)
	}
	// 手动参考图只决定附哪些图，不应丢掉其余出场资产的最新文字设定。
	for _, shot := range draft.shots {
		looks := map[string]string{}
		for _, id := range decodeStringList(shot.LookCastIDsJSON) {
			if look, ok := casts[id]; ok && look.ParentID != "" {
				looks[look.ParentID] = id
			}
		}
		for _, id := range dramaShotCastIDs(shot) {
			if lookID := looks[id]; lookID != "" {
				id = lookID
			}
			add(id, "")
		}
	}
	// 对白角色可能只以别名出现在 Speaker，或被单独选作参考音色。
	index := production.NewCastIndex()
	for _, cast := range casts {
		if cast.Kind == "character" && cast.ParentID == "" {
			index.Add(cast.ID, append([]string{cast.Name}, decodeStringList(cast.AliasesJSON)...)...)
		}
	}
	for _, shot := range draft.shots {
		if strings.TrimSpace(shot.Dialogue) != "" && !production.IsNarrator(shot.Speaker) {
			if id, ok := index.Lookup(shot.Speaker); ok {
				addVoice(casts[id])
			}
		}
	}
	for _, ref := range request.AudioReferences {
		if cast, ok := casts[ref.CastID]; ok {
			addVoice(cast)
		}
	}
	if len(lines) == 0 {
		return nil
	}
	rules := "【本次生成使用的最新资产设定】\n下文段稿中的旧固定外观、服装、场景陈设或声线描述与本区冲突时，以本区最新设定为准；已附参考图的外观以图片为准，文字补充细节。剧情、动作、台词、运镜、情绪和剧情明确要求的临时换装、受伤、持物状态保留。"
	if request.GenerateAudio {
		rules += "已附参考音频时，固定音色以对应样本为准；情绪、语速与音量按本段表演要求。"
	} else {
		rules += "本次生成无声视频，不生成对白或音效。"
	}
	return append([]string{rules}, lines...)
}
