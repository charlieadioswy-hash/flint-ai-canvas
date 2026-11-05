package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	"yingce/backend/internal/model"
	"yingce/backend/internal/repository"

	"gorm.io/gorm"
)

// Agent 的短剧工具：只在画布关联了当前用户的短剧作品时暴露（Scope.Drama）。
// drama_get_context 只读；drama_adopt_canvas_media 总是审批后才写入，写入只改短剧版本，不改画布。

const (
	cloudAgentDramaListLimit  = 200
	cloudAgentDramaBoundLimit = 100
	// cloudAgentDramaContextNote 随 drama_get_context 结果返回，提醒模型画布上的短剧节点会落后于调度结果。
	cloudAgentDramaContextNote = "状态以本次读取为准；画布上的短剧节点是投影快照，可能落后"
)

type cloudAgentDramaContextArgs struct {
	EpisodeID     string `json:"episodeId"`
	EpisodeNumber int    `json:"episodeNumber"`
	ChapterID     string `json:"chapterId"`
}

type cloudAgentDramaRef struct {
	Kind         string
	ID           string
	EpisodeID    string
	SegmentIndex *int
}

// cloudAgentDramaRefOf 读取节点（或其所在剧情段框）上的短剧绑定，绑定由画布投送时写入 metadata.dramaRef。
func cloudAgentDramaRefOf(node map[string]any, nodes map[string]map[string]any) (cloudAgentDramaRef, bool) {
	for depth := 0; node != nil && depth < 3; depth++ {
		meta, _ := node["metadata"].(map[string]any)
		if raw, ok := meta["dramaRef"].(map[string]any); ok {
			ref := cloudAgentDramaRef{Kind: stringValue(raw["kind"]), ID: stringValue(raw["id"]), EpisodeID: stringValue(raw["episodeId"])}
			if index, ok := raw["segmentIndex"].(float64); ok && index >= 0 {
				value := int(index)
				ref.SegmentIndex = &value
			}
			if ref.Kind != "" && ref.ID != "" {
				return ref, true
			}
		}
		parentID := stringValue(node["parentId"])
		if parentID == "" {
			break
		}
		node = nodes[parentID]
	}
	return cloudAgentDramaRef{}, false
}

func cloudAgentDramaCanvas(repo *repository.Repository, userID, canvasID string) (*model.CanvasProject, map[string]map[string]any, error) {
	canvas, err := repo.CanvasProjectForUser(userID, canvasID)
	if err != nil {
		return nil, nil, err
	}
	if !dramaLinkedCanvas(repo, canvas) {
		return nil, nil, BadAuthRequest("当前画布没有关联短剧作品")
	}
	doc, err := creationDocument(canvas.PayloadJSON)
	if err != nil {
		return nil, nil, err
	}
	nodes, err := creationObjects(doc["nodes"])
	if err != nil {
		return nil, nil, err
	}
	return canvas, nodes, nil
}

func cloudAgentHandleDramaGetContext(repo *repository.Repository, userID string, state *cloudAgentRuntime, call cloudAgentCall, services ...*Service) (any, error) {
	var service *Service
	if len(services) > 0 {
		service = services[0]
	}
	if service == nil {
		return nil, BadAuthRequest("短剧服务不可用")
	}
	var args cloudAgentDramaContextArgs
	if err := decodeCloudAgentJSONObject(call.Function.Arguments, &args); err != nil {
		return nil, cloudAgentJSONArgumentError(err)
	}
	// readAt 取在读库之前：返回的状态不早于这个时间。
	readAt := time.Now()
	projectID := state.Request.DramaProjectID
	nodes := map[string]map[string]any{}
	if projectID == "" {
		canvas, canvasNodes, err := cloudAgentDramaCanvas(repo, userID, state.Request.CanvasID)
		if err != nil {
			return nil, err
		}
		projectID, nodes = canvas.ProjectID, canvasNodes
	}
	summary, err := service.DramaSummary(userID, projectID)
	if err != nil {
		return nil, err
	}
	casts, err := service.DramaCasts(userID, projectID)
	if err != nil {
		return nil, err
	}
	production := summary.Production
	result := map[string]any{
		"source": "drama_db", "readAt": readAt.Format(time.RFC3339), "note": cloudAgentDramaContextNote,
		"drama": map[string]any{
			"id": summary.Project.ID, "name": summary.Project.Name, "status": production.Status, "pauseReason": production.PauseReason,
			"aspectRatio": production.Settings.AspectRatio, "budgetCredits": float64(production.BudgetMicrocredits) / 1e6,
			"spentCredits": float64(production.SpentMicrocredits) / 1e6, "canvasSpentCredits": float64(production.CanvasSpentMicrocredits) / 1e6,
			"heldCredits": float64(production.HeldMicrocredits) / 1e6,
			"revision":    production.Revision, "settings": production.Settings,
		},
	}
	if state.Request.DramaProjectID != "" {
		result["guide"] = map[string]any{
			"step": production.GuideStep, "creativeBrief": production.CreativeBrief, "baseRevision": production.Revision,
			"videoModel": cloudAgentDramaVideoModelContext(service, production.Settings),
		}
		chapters, err := service.DramaChapterOutline(userID, projectID)
		if err != nil {
			return nil, err
		}
		if len(chapters) > cloudAgentDramaListLimit {
			chapters = chapters[:cloudAgentDramaListLimit]
		}
		result["chapters"] = chapters
		if args.ChapterID != "" {
			chapter, err := service.DramaChapter(userID, projectID, args.ChapterID)
			if err != nil {
				return nil, err
			}
			result["chapter"] = map[string]any{"id": chapter.ID, "title": chapter.Title, "text": truncateRunes(chapter.SourceText, 16000), "truncated": len([]rune(chapter.SourceText)) > 16000}
		}
	}
	episodes := make([]map[string]any, 0, min(len(summary.Episodes), cloudAgentDramaListLimit))
	for _, episode := range summary.Episodes {
		if len(episodes) >= cloudAgentDramaListLimit {
			break
		}
		episodes = append(episodes, map[string]any{
			"id": episode.ID, "number": episode.Number, "title": episode.Title, "stage": episode.Stage, "hasFinal": episode.FinalResourceID != "",
			"finalStale": episode.FinalStale, "segments": episode.Stats.Segments, "videoReady": episode.Stats.VideoReady, "failed": episode.Stats.Failed,
			"revision": episode.Revision, "updatedAt": episode.UpdatedAt,
		})
	}
	result["episodes"] = episodes
	castViews := make([]map[string]any, 0, min(len(casts), cloudAgentDramaListLimit))
	for _, cast := range casts {
		if len(castViews) >= cloudAgentDramaListLimit {
			break
		}
		castViews = append(castViews, map[string]any{
			"id": cast.ID, "kind": cast.Kind, "name": cast.Name, "imageStatus": cast.ImageStatus, "hasImage": cast.ImageResourceID != "",
			"locked": cast.Locked, "appearance": truncateRunes(cast.Appearance, 200),
			"description": truncateRunes(cast.Description, 1000), "voiceInstructions": truncateRunes(cast.VoiceInstructions, 500),
		})
	}
	result["casts"] = castViews
	bound := []map[string]any{}
	for id, node := range nodes {
		meta, _ := node["metadata"].(map[string]any)
		raw, ok := meta["dramaRef"].(map[string]any)
		if !ok || len(bound) >= cloudAgentDramaBoundLimit {
			continue
		}
		bound = append(bound, map[string]any{"nodeId": id, "nodeType": stringValue(node["type"]), "title": truncateRunes(stringValue(node["title"]), 80), "kind": stringValue(raw["kind"]), "id": stringValue(raw["id"]), "episodeId": stringValue(raw["episodeId"]), "segmentIndex": raw["segmentIndex"]})
	}
	result["boundNodes"] = bound
	episodeID := strings.TrimSpace(args.EpisodeID)
	if episodeID == "" && args.EpisodeNumber > 0 {
		for _, episode := range summary.Episodes {
			if episode.Number == args.EpisodeNumber {
				episodeID = episode.ID
				break
			}
		}
		if episodeID == "" {
			return nil, &cloudAgentArgumentError{BadAuthRequest(fmt.Sprintf("没有第 %d 集；请用{}或episodeNumber:0读取总览，只使用分集目录中真实存在的集号", args.EpisodeNumber))}
		}
	}
	if episodeID != "" {
		detail, err := service.DramaEpisodeDetail(userID, projectID, episodeID)
		if err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return nil, &cloudAgentArgumentError{BadAuthRequest("这一集不存在；请省略episodeId，用{}读取总览，只使用分集目录中真实存在的集ID")}
			}
			return nil, err
		}
		segments := make([]map[string]any, 0, len(detail.Segments))
		for _, segment := range detail.Segments {
			references := make([]string, 0, len(segment.Request.References))
			for _, reference := range segment.Request.References {
				references = append(references, reference.Label+"："+reference.Name)
			}
			segments = append(segments, map[string]any{
				"index": segment.Index, "id": segment.ID, "title": segment.Title, "durationSeconds": float64(segment.DurationMs) / 1000,
				"videoStatus": segment.VideoStatus, "hasVideo": segment.VideoResourceID != "", "promptStatus": segment.PromptStatus,
				"references": references, "prompt": truncateRunes(segment.VideoPrompt, 300),
				"revision": segment.Revision, "updatedAt": segment.UpdatedAt,
			})
		}
		result["episode"] = map[string]any{
			"id": detail.Episode.ID, "number": detail.Episode.Number, "title": detail.Episode.Title, "stage": detail.Episode.Stage,
			"revision": detail.Episode.Revision, "updatedAt": detail.Episode.UpdatedAt.Format(time.RFC3339), "segments": segments,
		}
		result["shots"] = detail.Shots
	}
	return result, nil
}

type cloudAgentDramaVideoModel struct {
	Choice                 DramaModelChoice `json:"choice"`
	VideoRatios            []string         `json:"videoRatios"`
	VideoResolutions       []string         `json:"videoResolutions"`
	DefaultVideoResolution string           `json:"defaultVideoResolution"`
	Issue                  string           `json:"issue,omitempty"`
}

func cloudAgentDramaVideoModelContext(service *Service, settings DramaSettings) cloudAgentDramaVideoModel {
	result := cloudAgentDramaVideoModel{Choice: settings.Models.Video, VideoRatios: []string{}, VideoResolutions: []string{}}
	if result.Choice.Empty() {
		result.Issue = "尚未选择视频模型，请先在制作方案中选择"
		return result
	}
	profile, err := service.dramaVideoProfile(result.Choice)
	if err != nil {
		result.Issue = "所选视频模型暂不可用：" + err.Error()
		return result
	}
	result.VideoRatios = profile.ratios()
	result.VideoResolutions, result.DefaultVideoResolution = dramaVideoResolutionsFor(profile.video)
	if len(result.VideoRatios) == 0 {
		result.Issue = "所选视频模型没有可用于短剧的画幅，请先调整视频模型"
	}
	return result
}

type cloudAgentDramaProposal struct {
	Kind         string         `json:"kind"`
	TargetID     string         `json:"targetId,omitempty"`
	BaseRevision int64          `json:"baseRevision"`
	Changes      map[string]any `json:"changes"`
}

// 建议沿用持久工具事件回放；这里只读取并校验，不写短剧，也不提交生成任务。
func cloudAgentHandleDramaProposeChanges(repo *repository.Repository, userID string, state *cloudAgentRuntime, call cloudAgentCall, services ...*Service) (any, error) {
	if len(services) == 0 || services[0] == nil || state.Request.DramaProjectID == "" {
		return nil, BadAuthRequest("建议工具仅用于已绑定项目的短剧引导")
	}
	var args cloudAgentDramaProposal
	if err := decodeCloudAgentJSONObject(call.Function.Arguments, &args); err != nil {
		return nil, cloudAgentJSONArgumentError(err)
	}
	allowed := map[string][]string{
		"setup":          {"aspectRatio", "styleName", "stylePrompt", "language", "episodeSeconds", "videoResolution"},
		"source":         {"chapters", "sourceFormat"},
		"cast":           {"name", "aliases", "appearance", "description", "voiceInstructions"},
		"cast_create":    {"kind", "name", "aliases", "appearance", "description", "voiceInstructions"},
		"cast_delete":    {"reason"},
		"shot":           {"speaker", "dialogue", "action", "shotSize", "camera", "imagePrompt", "videoPrompt", "transition", "durationSeconds"},
		"segment_prompt": {"videoPromptOverride"},
	}
	keys, ok := allowed[args.Kind]
	if !ok || len(args.Changes) == 0 || args.BaseRevision <= 0 {
		return nil, &cloudAgentArgumentError{BadAuthRequest("需要有效建议类型、修改内容和当前制作版本")}
	}
	for key, value := range args.Changes {
		found := false
		for _, allowedKey := range keys {
			found = found || key == allowedKey
		}
		if !found || value == nil {
			return nil, &cloudAgentArgumentError{BadAuthRequest("建议包含不允许修改的字段：" + key)}
		}
		if key == "episodeSeconds" || key == "durationSeconds" {
			if number, ok := value.(float64); !ok || number <= 0 || number > 3600 {
				return nil, &cloudAgentArgumentError{BadAuthRequest("建议时长无效")}
			} else if key == "episodeSeconds" && math.Trunc(number) != number {
				return nil, &cloudAgentArgumentError{BadAuthRequest("每集时长 episodeSeconds 需要整数秒")}
			}
		} else if key == "aliases" {
			values, ok := value.([]any)
			if !ok || len(values) > 20 {
				return nil, &cloudAgentArgumentError{BadAuthRequest("建议别名无效")}
			}
			for _, alias := range values {
				if text, ok := alias.(string); !ok || len([]rune(text)) > 120 {
					return nil, &cloudAgentArgumentError{BadAuthRequest("建议别名无效")}
				}
			}
		} else if key != "chapters" {
			if text, ok := value.(string); !ok || len([]rune(text)) > 16000 {
				return nil, &cloudAgentArgumentError{BadAuthRequest("建议文字无效")}
			}
		}
	}
	if args.Kind == "source" {
		encoded, _ := json.Marshal(args.Changes)
		var source struct {
			Chapters []struct {
				Title string `json:"title"`
				Text  string `json:"text"`
			} `json:"chapters"`
			SourceFormat string `json:"sourceFormat"`
		}
		if err := decodeCloudAgentJSONObject(string(encoded), &source); err != nil || len(source.Chapters) == 0 || len(source.Chapters) > 20 || len(encoded) > 64000 {
			return nil, &cloudAgentArgumentError{BadAuthRequest("正文建议需要 1–20 个章节，合计不超过 64KB")}
		}
		for _, chapter := range source.Chapters {
			if strings.TrimSpace(chapter.Title) == "" || strings.TrimSpace(chapter.Text) == "" {
				return nil, &cloudAgentArgumentError{BadAuthRequest("章节标题与正文不能为空")}
			}
		}
	}
	service := services[0]
	_, production, err := service.dramaForUser(userID, state.Request.DramaProjectID)
	if err != nil {
		return nil, err
	}
	if production.Revision != args.BaseRevision {
		return nil, &cloudAgentArgumentError{creationConflict("短剧内容已变化，请重新读取上下文后提出建议")}
	}
	if args.Kind == "setup" {
		if production.GuideStep != model.DramaGuideConfiguring {
			return nil, &cloudAgentArgumentError{BadAuthRequest("制作方案建议仅限配置确认前，请重新读取短剧上下文")}
		}
		settings := parseDramaSettings(production.SettingsJSON)
		encoded, err := json.Marshal(args.Changes)
		if err != nil {
			return nil, &cloudAgentArgumentError{BadAuthRequest("制作方案建议格式无效")}
		}
		if err := json.Unmarshal(encoded, &settings); err != nil {
			return nil, &cloudAgentArgumentError{BadAuthRequest("制作方案建议格式无效")}
		}
		normalized, err := service.validateDramaGuideSettings(userID, settings)
		if err != nil {
			video := cloudAgentDramaVideoModelContext(service, settings)
			return nil, &cloudAgentArgumentError{BadAuthRequest(fmt.Sprintf("%s。请重新读取 drama_get_context，videoResolution 必须取 guide.videoModel.videoResolutions 中的真实值（当前可选：%s），或传空字符串使用模型默认；画幅单独填写 aspectRatio。不要自行使用宽×高像素值，除非模型可选值明确包含它", err.Error(), strings.Join(video.VideoResolutions, "、")))}
		}
		values := map[string]any{
			"aspectRatio": normalized.AspectRatio, "styleName": normalized.StyleName, "stylePrompt": normalized.StylePrompt,
			"language": normalized.Language, "episodeSeconds": float64(normalized.EpisodeSeconds), "videoResolution": normalized.VideoResolution,
		}
		for key := range args.Changes {
			args.Changes[key] = values[key]
		}
	}
	if args.Kind == "cast_create" || args.Kind == "cast_delete" {
		if production.GuideStep != model.DramaGuideAssets && production.GuideStep != model.DramaGuideStory {
			return nil, &cloudAgentArgumentError{BadAuthRequest("请在角色与场景或剧本与分镜阶段调整资产")}
		}
		if args.Kind == "cast_create" {
			kind, _ := args.Changes["kind"].(string)
			name, _ := args.Changes["name"].(string)
			name = strings.TrimSpace(name)
			if (kind != "character" && kind != "scene" && kind != "prop") || name == "" || len([]rune(name)) > 60 {
				return nil, &cloudAgentArgumentError{BadAuthRequest("新增资产需要有效类型 character/scene/prop 和 1–60 字名称")}
			}
			args.Changes["name"] = name
		} else if reason, _ := args.Changes["reason"].(string); strings.TrimSpace(reason) == "" || len([]rune(reason)) > 1000 {
			return nil, &cloudAgentArgumentError{BadAuthRequest("删除资产需要 1–1000 字的删除原因，供用户确认")}
		}
	}
	if args.Kind == "setup" || args.Kind == "source" || args.Kind == "cast_create" {
		if args.TargetID != "" {
			return nil, &cloudAgentArgumentError{BadAuthRequest("配置、正文与新增资产建议不需要 targetId")}
		}
	} else {
		if err := validateCloudAgentID(args.TargetID, "建议目标 ID", 80); err != nil {
			return nil, &cloudAgentArgumentError{err}
		}
		var lookupErr error
		switch args.Kind {
		case "cast", "cast_delete":
			_, lookupErr = repo.DramaCast(production.ProjectID, args.TargetID)
		case "shot":
			_, lookupErr = repo.DramaShot(production.ProjectID, args.TargetID)
		case "segment_prompt":
			_, lookupErr = repo.DramaSegment(production.ProjectID, args.TargetID)
		}
		if errors.Is(lookupErr, gorm.ErrRecordNotFound) {
			return nil, &cloudAgentArgumentError{BadAuthRequest("建议目标不属于当前短剧，请重新读取上下文")}
		}
		if lookupErr != nil {
			return nil, lookupErr
		}
	}
	return args, nil
}

type cloudAgentDramaAdoptArgs struct {
	NodeID          string `json:"nodeId"`
	CastID          string `json:"castId"`
	EpisodeID       string `json:"episodeId"`
	SegmentIndex    *int   `json:"segmentIndex"`
	RestyleSegments bool   `json:"restyleSegments"`
	Cascade         bool   `json:"cascade"`
}

type cloudAgentDramaAdoptPlan struct {
	Args         cloudAgentDramaAdoptArgs
	DramaID      string
	ResourceID   string
	TaskID       string
	CastID       string
	EpisodeID    string
	SegmentIndex int
	Preview      cloudAgentApprovalPreview
}

// prepareCloudAgentDramaAdopt 解析并校验采用请求；审批预览与执行共用，执行时重新校验，不信任预览。
func prepareCloudAgentDramaAdopt(repo *repository.Repository, userID, canvasID string, call cloudAgentCall) (*cloudAgentDramaAdoptPlan, error) {
	var args cloudAgentDramaAdoptArgs
	if err := decodeCloudAgentJSONObject(call.Function.Arguments, &args); err != nil {
		return nil, &cloudAgentArgumentError{BadAuthRequest("采用参数无效：仅允许 nodeId、castId、episodeId、segmentIndex、restyleSegments、cascade")}
	}
	if err := validateCloudAgentID(args.NodeID, "节点ID", 80); err != nil {
		return nil, &cloudAgentArgumentError{err}
	}
	canvas, nodes, err := cloudAgentDramaCanvas(repo, userID, canvasID)
	if err != nil {
		return nil, err
	}
	node := nodes[args.NodeID]
	if node == nil {
		return nil, &cloudAgentArgumentError{BadAuthRequest("节点不在当前画布，请先读取画布")}
	}
	nodeType := stringValue(node["type"])
	if nodeType != "image" && nodeType != "video" {
		return nil, &cloudAgentArgumentError{BadAuthRequest("只能采用图片或视频节点")}
	}
	meta, _ := node["metadata"].(map[string]any)
	key := stringValue(meta["storageKey"])
	if !strings.HasPrefix(key, "resource:") {
		return nil, &cloudAgentArgumentError{BadAuthRequest("节点媒体尚未保存到账号资源库，等生成或上传完成后再采用")}
	}
	resource, err := repo.ResourceForUser(userID, strings.TrimPrefix(key, "resource:"))
	if err != nil || resource == nil || resource.Status != model.ResourceStatusReady || !strings.HasPrefix(resource.MimeType, nodeType+"/") {
		return nil, &cloudAgentArgumentError{BadAuthRequest("节点媒体不存在、未就绪或类型不匹配")}
	}
	drama, err := repo.ProjectForUser(userID, canvas.ProjectID)
	if err != nil {
		return nil, err
	}
	plan := &cloudAgentDramaAdoptPlan{Args: args, DramaID: drama.ID, ResourceID: resource.ID, TaskID: stringValue(meta["taskId"])}
	ref, hasRef := cloudAgentDramaRefOf(node, nodes)
	nodeTitle := cloudAgentApprovalNodeTitle(node, map[string]string{"image": "图片", "video": "视频"}[nodeType])
	item := cloudAgentApprovalPreviewItem{Operation: "adopt_drama_media", NodeID: args.NodeID, NodeTitle: nodeTitle, NodeType: nodeType, NodeTypeLabel: map[string]string{"image": "图片", "video": "视频"}[nodeType]}
	if nodeType == "image" {
		plan.CastID = strings.TrimSpace(args.CastID)
		if plan.CastID == "" && hasRef && ref.Kind == "cast" {
			plan.CastID = ref.ID
		}
		if plan.CastID == "" {
			return nil, &cloudAgentArgumentError{BadAuthRequest("请提供 castId：先用 drama_get_context 读取设定")}
		}
		cast, err := repo.DramaCast(drama.ID, plan.CastID)
		if err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return nil, &cloudAgentArgumentError{BadAuthRequest("设定不存在：请用 drama_get_context 返回的 castId")}
			}
			return nil, err
		}
		item.TargetNodeTitle = cast.Name
		item.Summary = fmt.Sprintf("把图片《%s》设为设定「%s」的参考图并锁定", nodeTitle, cast.Name)
		item.Details = []string{"旧参考图保留在版本记录中"}
		if args.RestyleSegments {
			item.Details = append(item.Details, "引用该设定、已生成的剧情段视频会标记过期，需要重新生成")
		}
	} else {
		plan.EpisodeID = strings.TrimSpace(args.EpisodeID)
		index := args.SegmentIndex
		if plan.EpisodeID == "" && hasRef && ref.Kind == "segment" {
			plan.EpisodeID, index = ref.EpisodeID, ref.SegmentIndex
		}
		if plan.EpisodeID == "" || index == nil {
			return nil, &cloudAgentArgumentError{BadAuthRequest("请提供 episodeId 和 segmentIndex：先用 drama_get_context 读取剧情段")}
		}
		plan.SegmentIndex = *index
		episode, err := repo.DramaEpisode(drama.ID, plan.EpisodeID)
		if err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return nil, &cloudAgentArgumentError{BadAuthRequest("这一集不存在：请用 drama_get_context 返回的 episodeId")}
			}
			return nil, err
		}
		segments, err := repo.DramaSegments(episode.ID)
		if err != nil {
			return nil, err
		}
		found, later := false, 0
		for _, segment := range segments {
			if segment.SegmentIndex == plan.SegmentIndex {
				found = true
			} else if segment.SegmentIndex > plan.SegmentIndex && segment.VideoResourceID != "" {
				later++
			}
		}
		if !found {
			return nil, &cloudAgentArgumentError{BadAuthRequest("剧情段不存在：请用 drama_get_context 返回的 index")}
		}
		item.TargetNodeTitle = fmt.Sprintf("第 %d 集第 %d 段", episode.Number, plan.SegmentIndex+1)
		item.Summary = fmt.Sprintf("把视频《%s》设为第 %d 集第 %d 段的当前视频", nodeTitle, episode.Number, plan.SegmentIndex+1)
		item.Details = []string{"旧视频保留在版本记录中；已有成片会重新合成"}
		parallel := false
		if productionRow, err := repo.DramaProduction(drama.ID); err == nil {
			parallel = parseDramaSettings(productionRow.SettingsJSON).parallelVideo()
		}
		if args.Cascade && later > 0 && !parallel {
			item.Details = append(item.Details, fmt.Sprintf("后续 %d 段已生成的视频会重新排队生成以保证衔接，按实际用量计费", later))
		} else {
			item.Details = append(item.Details, "只换本段，后续段保持不变")
		}
	}
	plan.Preview = cloudAgentApprovalPreview{
		Kind: "canvas_mutation", Title: "确认采用到短剧",
		Description: fmt.Sprintf("Agent 准备把画布上的%s采用到短剧《%s》。只改短剧版本，不修改画布；批准后才会执行。", item.NodeTypeLabel, truncateRunes(drama.Name, 60)),
		Items:       []cloudAgentApprovalPreviewItem{item},
	}
	return plan, nil
}

func cloudAgentPreviewDramaAdopt(repo *repository.Repository, userID, canvasID string, call cloudAgentCall) (cloudAgentApprovalPreview, error) {
	plan, err := prepareCloudAgentDramaAdopt(repo, userID, canvasID, call)
	if err != nil {
		return cloudAgentApprovalPreview{}, err
	}
	return plan.Preview, nil
}

// applyCloudAgentDramaAdopt 在 Agent 检查点事务内写入短剧版本。段视频的尾帧抽取是存储 IO，
// 不能放在事务里，交给短剧调度循环补做；不写画布，因此不登记画布撤销记录。
func applyCloudAgentDramaAdopt(repo *repository.Repository, userID, canvasID string, call cloudAgentCall, _ RuntimePolicySetting, _ ...cloudAgentMutationRecorder) (any, error) {
	plan, err := prepareCloudAgentDramaAdopt(repo, userID, canvasID, call)
	if err != nil {
		return nil, err
	}
	service := &Service{repo: repo}
	var outcome map[string]any
	if plan.CastID != "" {
		outcome, err = service.SetDramaCastImage(userID, plan.DramaID, plan.CastID, SetDramaCastImageRequest{ResourceID: plan.ResourceID, RestyleSegments: plan.Args.RestyleSegments, Source: "canvas", TaskID: plan.TaskID})
	} else {
		outcome, err = service.adoptDramaSegmentVideoDeferred(userID, plan.DramaID, plan.EpisodeID, plan.SegmentIndex, AdoptDramaSegmentVideoRequest{ResourceID: plan.ResourceID, TaskID: plan.TaskID, Cascade: plan.Args.Cascade})
	}
	if err != nil {
		return nil, err
	}
	applied := plan.Preview
	applied.Status, applied.Title = "applied", "已采用到短剧"
	applied.Description = strings.TrimSuffix(plan.Preview.Items[0].Summary, "。") + "。"
	receipt := map[string]any{"dramaProjectId": plan.DramaID, "nodeId": plan.Args.NodeID, "summary": applied.Description, "preview": applied}
	for _, key := range []string{"affectedSegments", "requeued", "paused", "unchanged"} {
		if value, ok := outcome[key]; ok {
			receipt[key] = value
		}
	}
	if plan.CastID != "" {
		receipt["castId"] = plan.CastID
	} else {
		receipt["episodeId"], receipt["segmentIndex"] = plan.EpisodeID, plan.SegmentIndex
		receipt["note"] = "尾帧与成片合成由短剧调度在制作运行时完成；制作暂停时请提醒用户继续制作"
	}
	return receipt, nil
}
