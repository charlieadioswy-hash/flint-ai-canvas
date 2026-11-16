package app

import (
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"yingce/backend/internal/model"
	"yingce/backend/internal/production"
)

func dramaSceneSourceScenes(before []model.DramaShot) (map[string]model.DramaShot, error) {
	if len(before) == 0 {
		return nil, BadAuthRequest("本段至少保留1镜")
	}
	scenes := map[string]model.DramaShot{}
	for _, shot := range before {
		if shot.SegmentIndex != before[0].SegmentIndex {
			return nil, BadAuthRequest("只能替换同一完整段的镜头")
		}
		key := strings.TrimSpace(shot.Scene)
		if previous, ok := scenes[key]; ok && previous.SceneCastID != shot.SceneCastID {
			return nil, BadAuthRequest("本段同名场景的资产引用不一致，请先修复分镜")
		}
		scenes[key] = shot
	}
	return scenes, nil
}

func (s *Service) buildDramaSceneReplacement(settings DramaSettings, all, before []model.DramaShot, scripted []production.ScriptShot, casts []model.DramaCast, segments []model.DramaSegment) ([]model.DramaShot, []model.DramaSegment, error) {
	scenes, err := dramaSceneSourceScenes(before)
	if err != nil {
		return nil, nil, err
	}
	if len(scripted) == 0 {
		return nil, nil, BadAuthRequest("本段至少保留1镜")
	}
	castIndex, propIndex := dramaKindIndex(casts, "character"), dramaKindIndex(casts, "prop")
	lookup := func(index *production.CastIndex, name string) (string, error) {
		if strings.TrimSpace(name) == "" || production.IsNarrator(name) {
			return "", nil
		}
		id, ok := index.Lookup(name)
		if !ok {
			return "", BadAuthRequest("重拆结果引用了未确认资产：" + name)
		}
		return id, nil
	}
	looks := map[string][]model.DramaCast{}
	for _, cast := range casts {
		if cast.ParentID != "" {
			looks[cast.ParentID] = append(looks[cast.ParentID], cast)
		}
	}
	now := time.Now()
	after := make([]model.DramaShot, 0, len(scripted))
	for i, item := range scripted {
		scene, ok := scenes[strings.TrimSpace(item.Scene)]
		if !ok {
			return nil, nil, BadAuthRequest("重拆只能使用本段已有场景，请在资产与分镜中明确修改场景")
		}
		for _, field := range []struct {
			value string
			limit int
		}{{item.Speaker, 60}, {item.Dialogue, dramaMaxDialogueRunes}, {item.Action, 1000}, {item.ImagePrompt, 2000}, {item.VideoPrompt, 2000}, {item.SourceQuote, 300}, {item.Camera, 60}, {item.ShotSize, 30}} {
			if utf8.RuneCountInString(field.value) > field.limit {
				return nil, nil, BadAuthRequest("重拆结果单镜内容过长，请重新生成")
			}
		}
		if item.DurationSeconds < 1 || item.DurationSeconds > production.MaxStoryboardShotSeconds {
			return nil, nil, BadAuthRequest("重拆镜头时长需为1到60秒")
		}
		castIDs, lookIDs, propIDs := []string{}, []string{}, []string{}
		for _, name := range append(append([]string{}, item.Characters...), item.Speaker) {
			id, err := lookup(castIndex, name)
			if err != nil {
				return nil, nil, err
			}
			if id == "" || containsString(castIDs, id) {
				continue
			}
			castIDs = append(castIDs, id)
			chosen := item.Looks[strings.TrimSpace(name)]
			if chosen != "" && !production.IsBaseLookName(chosen) {
				found := ""
				for _, look := range looks[id] {
					if production.NormalizeName(look.LookName) == production.NormalizeName(chosen) {
						found = look.ID
					}
				}
				if found == "" {
					return nil, nil, BadAuthRequest("重拆结果引用了未确认造型：" + chosen)
				}
				lookIDs = append(lookIDs, found)
			}
		}
		for _, name := range item.Props {
			id, err := lookup(propIndex, name)
			if err != nil {
				return nil, nil, err
			}
			if id != "" && !containsString(propIDs, id) {
				propIDs = append(propIDs, id)
			}
		}
		shot := model.DramaShot{ID: newID(), ProjectID: before[0].ProjectID, EpisodeID: before[0].EpisodeID, CreatedAt: now}
		if i < len(before) {
			shot.ID, shot.CreatedAt = before[i].ID, before[i].CreatedAt
		}
		shot.Position, shot.SegmentIndex, shot.SegmentTitle, shot.UpdatedAt = before[0].Position+i, before[0].SegmentIndex, before[0].SegmentTitle, now
		shot.Scene, shot.SceneCastID = scene.Scene, scene.SceneCastID
		shot.CastIDsJSON, shot.LookCastIDsJSON, shot.PropIDsJSON = encodeStringList(castIDs), encodeStringList(lookIDs), encodeStringList(propIDs)
		shot.Speaker, shot.Dialogue, shot.Action, shot.ShotSize, shot.Camera = item.Speaker, item.Dialogue, item.Action, item.ShotSize, item.Camera
		shot.DurationMs, shot.Transition = settings.Storyboard.ImportedShotMs(item.DurationSeconds, item.Dialogue), production.NormalizeTransition(item.Transition)
		shot.ImagePrompt, shot.VideoPrompt, shot.SourceQuote = item.ImagePrompt, item.VideoPrompt, item.SourceQuote
		after = append(after, shot)
	}
	if dramaSceneDialogue(before) != dramaSceneDialogue(after) {
		return nil, nil, BadAuthRequest("重拆结果改写、增减了台词或说话人，已保留原分镜，请重新生成")
	}
	profile, err := s.dramaVideoProfile(settings.Models.Video)
	if err != nil {
		return nil, nil, err
	}
	limit := settings.Storyboard.SegmentLimits(profile.Durations).MaxMs
	totals, selected := map[int]int64{}, map[string]bool{}
	for _, shot := range before {
		selected[shot.ID] = true
	}
	for _, shot := range all {
		if !selected[shot.ID] {
			totals[shot.SegmentIndex] += shot.DurationMs
		}
	}
	for _, shot := range after {
		totals[shot.SegmentIndex] += shot.DurationMs
	}
	index := before[0].SegmentIndex
	if limit > 0 && totals[index] > limit {
		return nil, nil, BadAuthRequest(fmt.Sprintf("重拆后第%d段超过视频模型单段上限，请减少时长或调整镜头数", index+1))
	}
	for _, segment := range segments {
		if segment.SegmentIndex == index {
			return after, []model.DramaSegment{segment}, nil
		}
	}
	return nil, nil, BadAuthRequest("原段缺失，请先修复本集分镜")
}
