package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"gorm.io/gorm"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
	"unicode/utf8"

	"yingce/backend/internal/model"
	"yingce/backend/internal/production"
	"yingce/backend/internal/protocol"
)

const dramaTailReferenceHeader = "以上一段尾帧作为本段的开场参考。"
const dramaTailReferenceLabel = "参考图0"

type dramaRevisionPayload struct {
	Revision      int64 `json:"revision"`
	VideoRevision int64 `json:"videoRevision,omitempty"`
	Seconds       int   `json:"seconds,omitempty"`
	// MaxChars 是段提示词正文的字符上限：视频模型提示词上限减去撰写时的参考图说明；0 表示不限。
	MaxChars int `json:"maxChars,omitempty"`
	// Condensed 是本次撰写已做的自动精简次数。
	Condensed int `json:"condensed,omitempty"`
	// PromptReferences records the numbering sent to the text writer, including any subsequent condensation.
	PromptReferences []dramaSegmentPromptLabel `json:"promptReferences,omitempty"`
}

func encodeDramaRevision(revision int64) string {
	b, _ := json.Marshal(dramaRevisionPayload{Revision: revision})
	return string(b)
}

func dramaPromptReady(segment model.DramaSegment) bool {
	if segment.PromptStatus == model.DramaPromptConflict || segment.PromptStatus == model.DramaPromptReview {
		return false
	}
	return (strings.TrimSpace(segment.VideoPromptOverride) != "" && (segment.PromptStatus == model.DramaMediaReady || segment.PromptStatus == model.DramaMediaStale || segment.PromptStatus == model.DramaMediaQueued)) || (segment.PromptStatus == model.DramaMediaReady && strings.TrimSpace(segment.VideoPrompt) != "")
}

func dramaSegmentVideoDone(segment model.DramaSegment) bool {
	return segment.VideoStatus == model.DramaMediaReady && segment.VideoResourceID != "" && segment.TailFrameResourceID != ""
}

// dramaVideoWaitReason 说明第 index 段视频为何还不能提交；空串表示调度会提交它。调度与详情页共用。
func dramaVideoWaitReason(settings DramaSettings, p *model.DramaProduction, e *model.DramaEpisode, segments []model.DramaSegment, index int, shots []model.DramaShot, lookup func(string) (model.DramaCast, bool), extractPending bool) string {
	if dramaGuideActive(p) {
		if p.GuideStep != model.DramaGuideStory || !p.MediaRequestsOnly || !e.VideoRequestsOnly || !mediaBusyStatus(segments[index].VideoStatus) {
			return "请先完成文字创作引导或确认本段生成"
		}
		if reason := dramaWorkflowTextReason(p, e, segments, shots); reason != "" {
			return reason
		}
	}
	if wait := dramaProductionWait(p); wait != "" {
		return wait
	}
	switch {
	case e.Stage == model.DramaEpisodeDraft || e.Stage == model.DramaEpisodeQueued || e.Stage == model.DramaEpisodeScript:
		return "等待本集剧本完成"
	case dramaMediaHeld(settings, p, e) && segments[index].VideoStatus != model.DramaMediaQueued:
		return "本集尚未放行生图"
	case settings.ReviewMode == DramaReviewSample && !p.SampleApproved && e.Number != 1:
		return "等待确认第 1 集样片"
	}
	if index > 0 && !settings.parallelVideo() && !dramaSegmentVideoDone(segments[index-1]) {
		return "等待上一段视频生成（需要它的最后一帧）"
	}
	if !dramaPromptReady(segments[index]) {
		return "等待本段视频提示词撰写完成"
	}
	if extractPending {
		return "等待补全后出现角色、道具或场景的外貌"
	}
	// 未生成的参考图在自动生图或已放行、且已有外貌依据时会被调度排队，同样要等。
	// 没有外貌的后出现设定不会自动生图，不能一直卡住出片。
	requested := (settings.MediaMode != DramaMediaManual && !p.MediaRequestsOnly) || p.AssetsReleased
	if names := dramaReferencesInProgress(segments[index].SegmentIndex, shots, lookup, requested); len(names) > 0 {
		return "等待参考图生成：" + strings.Join(names, "、")
	}
	return ""
}

// dramaReferencesInProgress 返回本段引用、仍在生成的参考图名称。等它们能提升角色一致性；
// 失败、锁定或从未请求的参考图不再等待，提交时改用文字设定（见 prepareDramaSegment）。
// 造型行与本体一样参与等待；草稿/空状态在已放行自动排队时也算“进行中”，避免出片只带文字外观。
func dramaReferencesInProgress(segmentIndex int, shots []model.DramaShot, lookup func(string) (model.DramaCast, bool), unrequestedQueued bool) []string {
	names := []string{}
	seen := map[string]bool{}
	for _, shot := range shots {
		if shot.SegmentIndex != segmentIndex {
			continue
		}
		for _, id := range dramaShotCastIDs(shot) {
			cast, ok := lookup(id)
			if !ok || seen[id] || cast.Locked {
				continue
			}
			seen[id] = true
			hasBrief := dramaCastHasImageDefinition(cast)
			pending := hasBrief && (cast.ImageStatus == model.DramaMediaQueued || cast.ImageStatus == model.DramaMediaRunning ||
				((cast.ImageStatus == "" || cast.ImageStatus == model.DramaMediaDraft) && unrequestedQueued))
			if !pending {
				continue
			}
			name := cast.Name
			if cast.ParentID != "" && strings.TrimSpace(cast.LookName) != "" {
				name = cast.Name + "·" + cast.LookName
			}
			names = append(names, name)
		}
	}
	return names
}

func segmentVideoChoice(segment model.DramaSegment, fallback DramaModelChoice) DramaModelChoice {
	var choice DramaModelChoice
	if json.Unmarshal([]byte(segment.VideoModelJSON), &choice) == nil && !choice.Empty() {
		return choice
	}
	return fallback
}

// prepareDramaSegment is shared by the request preview and provider submission.
// Logical reference numbering stays stable for editing; the provider compiles it against the actual payload.
// 返回值依次是请求预演、随请求发送的参考图与参考音频（任务输入的媒体项）。
func (s *Service) prepareDramaSegment(settings DramaSettings, draft dramaSegmentDraft, segment model.DramaSegment, previous *model.DramaSegment, casts map[string]model.DramaCast) (DramaSegmentRequest, []any, []any, error) {
	if settings.parallelVideo() {
		// 并行出片：每段只按参考图独立生成，不带上一段尾帧，也就不依赖上一段完成。
		previous = nil
	}
	choice := segmentVideoChoice(segment, settings.Models.Video)
	profile, err := s.dramaVideoProfile(choice)
	if err != nil {
		// 视频模型不可用时详情页仍展示本段并给出 Warning；数组字段必须是 []，null 会让制作台渲染参考图时崩溃。
		return DramaSegmentRequest{AspectRatio: settings.AspectRatio, References: []DramaSegmentReference{}, AudioReferences: []DramaSegmentAudioReference{}}, nil, nil, err
	}
	screen := profile.screen(settings.AspectRatio, profile.effectiveResolution(settings.VideoResolution))
	request := DramaSegmentRequest{Seconds: production.SnapVideoSeconds(draft.view.DurationMs, profile.Durations), MaxVideoSeconds: profile.maxSeconds(), AspectRatio: settings.AspectRatio, Size: screen.Size, Resolution: screen.Resolution, PromptMaxChars: profile.PromptMaxChars, GenerateAudio: profile.GenerateAudio, References: []DramaSegmentReference{}, AudioReferences: []DramaSegmentAudioReference{}, ModelMaxAudios: profile.MaxAudios}
	if draft.view.DurationMs > int64(request.MaxVideoSeconds)*1000 {
		return request, nil, nil, errors.New("剧情段超过所选视频模型的时长上限，请调整分镜时长或重新改编")
	}
	// The logical model's selected duration is checked against the serving route
	// at admission. The default route may serve a different duration.
	if choice.LogicalModelID == "" && profile.video != nil {
		if err := dramaSegmentDurationError(segment.SegmentIndex, request.Seconds, profile.video.Duration); err != nil {
			return request, nil, nil, err
		}
	}
	refs := []any{}
	header := []string{}
	direction := dramaVisualDirection(settings, "", "")
	tailMode := profile.tailFrameMode()
	if previous != nil {
		if issue := profile.continuityIssue(settings); issue != "" {
			request.Warning = issue
			return request, nil, nil, errors.New(issue)
		}
		canSendReferenceImages := tailMode == protocol.DramaTailFrameReference && profile.video.maxImagesFor("reference_to_video") > 1 &&
			slices.ContainsFunc(draft.view.Request.References, func(ref DramaSegmentReference) bool {
				cast := casts[ref.CastID]
				return ref.CastID == "" || cast.ImageStatus == model.DramaMediaReady && cast.ImageResourceID != ""
			})
		request.Operation = profile.tailFrameOperation(canSendReferenceImages)
		request.TailFrameAsReference = request.Operation == "reference_to_video" && tailMode == protocol.DramaTailFrameReference
		role := "first_frame"
		if request.TailFrameAsReference {
			role = "reference_image"
			header = append(header, dramaTailReferenceHeader)
		} else {
			header = append(header, "首帧图为上一段视频的最后一帧。")
		}
		request.FirstFramePending = previous.VideoStatus != model.DramaMediaReady || previous.TailFrameResourceID == ""
		if !request.FirstFramePending {
			request.FirstFrameResourceID = previous.TailFrameResourceID
			ref, err := s.dramaResourceReference(previous.TailFrameResourceID, "first-frame", role)
			if err != nil {
				return request, nil, nil, err
			}
			refs = append(refs, ref)
		}
	} else if profile.supports("reference_to_video") {
		request.Operation = "reference_to_video"
	} else {
		request.Operation = "text_to_video"
	}
	if !profile.supports(request.Operation) {
		return request, nil, nil, fmt.Errorf("所选模型不支持本段所需的 %s", request.Operation)
	}
	request.ModelMaxImages = profile.video.maxImagesFor(request.Operation)
	tailOnly := previous != nil && request.Operation == "image_to_video" &&
		(tailMode == protocol.DramaTailFrameReference || tailMode == protocol.DramaTailFrameOmni)
	if tailOnly {
		request.ModelMaxImages = min(request.ModelMaxImages, 1)
	}
	capacity := request.ModelMaxImages
	if previous != nil {
		capacity--
	}
	if request.Operation == "text_to_video" {
		capacity = 0
	}
	// 自动取参考图时按“每段最多参考图”收紧，人物排在最前，优先保证角色一致；手动指定的段只受模型上限约束。
	settingLimited := draft.view.ReferenceMode != "custom" && settings.ReferenceLimit > 0 && settings.ReferenceLimit < capacity
	if settingLimited {
		capacity = settings.ReferenceLimit
	}
	request.ReferenceCapacity = max(capacity, 0)
	if request.Operation == "text_to_video" && len(draft.view.Request.References) > 0 {
		request.Warning = "所选视频模型不支持参考图生视频，本段按文生视频生成，人物、道具与场景只按文字设定"
	}
	// 没随请求发送的参考图按原因分开列出：未就绪的点名，超出上限的说明是哪种上限。
	var missing, overflow []string
	providerRefs := make([]DramaSegmentReference, 0, len(draft.view.Request.References))
	sentLabels := make(map[string]bool, len(draft.view.Request.References))
	for _, reference := range draft.view.Request.References {
		if reference.CastID == "" {
			resource, err := s.repo.Resource(reference.ResourceID)
			if err != nil {
				return request, nil, nil, err
			}
			if resource.Kind != "image" || resource.Status != model.ResourceStatusReady {
				return request, nil, nil, errors.New("自定义参考图片已不可用，请移除后重新添加")
			}
			reference.Sent = capacity > 0
			providerRef := reference
			providerRef.Label = ""
			if reference.Sent {
				providerRef.Label = reference.Label
				sentLabels[reference.Label] = true
				ref, err := s.dramaResourceReference(reference.ResourceID, providerRef.Label, "")
				if err != nil {
					return request, nil, nil, err
				}
				ref["id"] = dramaReferenceMediaID(reference)
				refs = append(refs, ref)
				capacity--
				header = append(header, providerRef.Label+"："+reference.Name)
			} else {
				header = append(header, "资产“"+reference.Name+"”未附图")
				if settingLimited {
					request.ReferenceLimited = true
				} else {
					overflow = append(overflow, reference.Label+" "+reference.Name)
				}
			}
			providerRefs = append(providerRefs, providerRef)
			request.References = append(request.References, reference)
			continue
		}
		cast, exists := casts[reference.CastID]
		if !exists {
			return request, nil, nil, errors.New("剧情段引用的设定不存在")
		}
		reference.ResourceID = cast.ImageResourceID
		reference.Sent = capacity > 0 && cast.ImageStatus == model.DramaMediaReady && cast.ImageResourceID != ""
		providerRef := reference
		providerRef.Label = ""
		if reference.Sent {
			providerRef.Label = reference.Label
			sentLabels[reference.Label] = true
			ref, err := s.dramaResourceReference(cast.ImageResourceID, providerRef.Label, "")
			if err != nil {
				return request, nil, nil, err
			}
			ref["id"] = dramaReferenceMediaID(reference)
			refs = append(refs, ref)
			capacity--
			line := providerRef.Label + "：" + reference.Name
			if cast.Locked {
				// 用户锁定（含上传）的形象是硬约束，文字设定与图片冲突时以图片为准。
				line += "（已锁定形象：" + map[string]string{"character": "五官、发型、服装", "prop": "外形、材质、颜色", "scene": "空间布局、陈设、光线"}[cast.Kind] + "必须与此图一致，文字描述与图片不符时以图片为准）"
			}
			header = append(header, line)
		} else {
			header = append(header, reference.Name+"未附图，请依据下方最新文字设定")
			ready := cast.ImageStatus == model.DramaMediaReady && cast.ImageResourceID != ""
			switch {
			case !ready:
				missing = append(missing, reference.Label+" "+reference.Name+"（"+dramaCastImageState(cast)+"）")
			case settingLimited:
				request.ReferenceLimited = true
			default:
				overflow = append(overflow, reference.Label+" "+reference.Name)
			}
		}
		providerRefs = append(providerRefs, providerRef)
		request.References = append(request.References, reference)
	}
	if slices.ContainsFunc(request.References, func(ref DramaSegmentReference) bool { return ref.Sent }) {
		if err := profile.video.referenceContract.CheckNumbering(profile.video.providerID, profile.video.providerModel); err != nil {
			request.ReferenceCapacity = 0
			for index := range request.References {
				request.References[index].Sent = false
			}
			request.Warning = err.Error()
			return request, nil, nil, err
		}
	}
	audios, err := s.dramaSegmentAudioReferences(&request, profile, draft.shots, casts, len(refs) > 0, segment.AudioCastIDsJSON)
	if err != nil {
		return request, nil, nil, err
	}
	rawPrompt := firstNonEmpty(segment.VideoPromptOverride, segment.VideoPrompt)
	authored := dramaSegmentAuthoredLabels(segment, rawPrompt, dramaSegmentPromptLabels(draft.view.Request.References), strings.TrimSpace(segment.VideoPromptOverride) != "")
	editorPrompt := dramaSegmentEditorPrompt(rawPrompt, authored)
	providerContext := request
	providerContext.References = append(providerRefs, dramaSegmentPromptSubjects(casts, editorPrompt)...)
	header = append(header, dramaSegmentLatestAssets(draft, providerContext, casts)...)
	for _, reference := range request.AudioReferences {
		if reference.Sent {
			header = append(header, reference.Label+"："+reference.Name+"的声音（固定音色以此为准；情绪、语速与音量按本段表演要求）")
		}
	}
	if request.Warning == "" {
		notes := []string{}
		if len(missing) > 0 {
			notes = append(notes, "参考图未就绪，本段按文字设定生成："+strings.Join(missing, "、")+"；重新生成参考图后再生成本段，形象更一致")
		}
		if request.ReferenceLimited {
			notes = append(notes, fmt.Sprintf("本段引用 %d 个设定，按每段最多 %d 张参考图发送，其余按文字设定；可在生成依据里手动调整", len(draft.view.Request.References), settings.ReferenceLimit))
		}
		if len(overflow) > 0 {
			notes = append(notes, fmt.Sprintf("超出视频模型参考图上限（%d 张，含首帧），按文字设定生成：%s", request.ModelMaxImages, strings.Join(overflow, "、")))
		}
		request.Warning = strings.Join(notes, "；")
	}
	request.Header = strings.Join(header, "\n")
	resolvedPrompt := resolveDramaSegmentPromptForReferences(segment, draft.view.Request.References, providerContext.References)
	if direction != "" {
		resolvedPrompt = stripDramaVisualDirection(resolvedPrompt)
		request.Header = stripDramaVisualDirection(request.Header)
		reserved := max(dramaMinPromptBudget, utf8.RuneCountInString(resolvedPrompt)) + 2
		if request.Header != "" {
			reserved += utf8.RuneCountInString(request.Header) + 2
		}
		style := dramaVideoVisualDirection(direction, request.PromptMaxChars, reserved)
		request.Header = withDramaVisualDirection(request.Header, style)
	}
	if rawPrompt != "" {
		request.ResolvedPrompt = &resolvedPrompt
	}
	// 正文里的“参考图N”必须对应本段的参考图；换参考图后手写的提示词可能还留着旧编号。
	unknown := production.UnknownReferenceTokens(editorPrompt, len(authored))
	for _, label := range dramaPromptReferenceLabels(resolvedPrompt) {
		if !sentLabels[label] {
			unknown = append(unknown, label)
		}
	}
	if len(unknown) > 0 {
		request.UnknownReferences = uniqueStrings(unknown)
		request.Warning = fmt.Sprintf("提示词里的 %s 不是本段的参考图（本次发送 %d 张），生成前请改成正确的编号", strings.Join(request.UnknownReferences, "、"), len(sentLabels))
	}
	usedLabels := make(map[string]bool)
	for _, label := range dramaPromptReferenceLabels(rawPrompt) {
		usedLabels[label] = true
	}
	usedAssets := make(map[string]bool)
	for _, label := range authored {
		if usedLabels[label.Label] {
			usedAssets[label.Identity] = true
		}
	}
	unsent := []string{}
	for _, reference := range request.References {
		if !reference.Sent && usedAssets[dramaSegmentReferenceIdentity(reference)] {
			unsent = append(unsent, reference.Label+"（"+reference.Name+"）")
		}
	}
	if len(unsent) > 0 {
		request.Warning = "提示词引用的 " + strings.Join(unsent, "、") + " 未附图，无法对应模型图片；请补齐图片、调整参考图上限或修改正文中的引用后再生成"
		if tailOnly {
			request.Warning = "所选模型在尾帧续接时只能使用上一段尾帧，正文仍引用 " + strings.Join(unsent, "、") + "。请调整引用、改用并行出片或换用支持混合参考的模型"
		}
		return request, refs, audios, errors.New(request.Warning)
	}
	// 给不出作品画幅时不提交：上游会按自己的默认画幅（多为横屏）出片，花了钱也用不上。
	if screen.Issue != "" {
		return request, refs, audios, errors.New(screen.Issue)
	}
	// 强制参考图的模型（如只做参考图生视频）：本段发不出这么多张时准入必然拒收，预演先说明，不提交。
	sent := len(refs)
	if request.FirstFramePending {
		sent++ // 上一段尾帧就绪后作为首帧发送
	}
	if sent < profile.MinImages {
		return request, refs, audios, fmt.Errorf("所选视频模型至少需要 %d 张参考图，本段只能发送 %d 张；请为本段补充已生成参考图的设定，或换用不强制参考图的视频模型", profile.MinImages, sent)
	}
	return request, refs, audios, nil
}

// 选择与模型发送能力无关；请求预演失败时仍须展示完整选择，不能把未发送误作未选中。
func dramaSegmentAudioSelection(shots []model.DramaShot, casts map[string]model.DramaCast, audioIDsJSON string) ([]model.DramaCast, error) {
	speakers := dramaSegmentVoicedSpeakers(shots, casts)
	if strings.TrimSpace(audioIDsJSON) != "" {
		speakers = []model.DramaCast{}
		for _, id := range decodeStringList(audioIDsJSON) {
			cast, ok := casts[id]
			if !ok || cast.Kind != "character" || cast.ParentID != "" {
				return nil, errors.New("参考音色角色已不存在，请重新选择")
			}
			speakers = append(speakers, cast)
		}
	}
	return speakers, nil
}

// dramaSegmentAudioReferences 按对白或段级指定选择角色声音（造型归到所属角色），
// 能发送的写成“参考音频N”并返回任务输入的媒体项。只在参考图生视频时发送：上游要求参考音频与至少一张参考图同时提供，
// 以上一段尾帧作首帧的段不混用参考素材。没能发送的写明原因，该角色的对白按声线描述生成。
func (s *Service) dramaSegmentAudioReferences(request *DramaSegmentRequest, profile dramaVideoProfile, shots []model.DramaShot, casts map[string]model.DramaCast, hasImages bool, audioIDsJSON string) ([]any, error) {
	speakers, err := dramaSegmentAudioSelection(shots, casts, audioIDsJSON)
	if err != nil {
		return nil, err
	}
	media := []any{}
	for _, cast := range speakers {
		reference := DramaSegmentAudioReference{CastID: cast.ID, Name: cast.Name, ResourceID: cast.VoiceSampleResourceID}
		switch {
		case cast.VoiceSampleResourceID == "":
			reference.Note = "角色尚未绑定声音样本"
		case profile.video != nil && !request.GenerateAudio:
			reference.Note = "本次生成无声视频，不发送声音样本"
		case profile.MaxAudios <= 0:
			reference.Note = "所选视频模型不支持参考音频，按声线描述生成"
		case request.Operation == "image_to_video":
			reference.Note = "本段以上一段尾帧作首帧，不能同时附带参考音频；并行出片时每段都会带上角色声音"
		case request.Operation != "reference_to_video":
			reference.Note = "本段按文生视频生成，不能附带参考音频"
		case !hasImages:
			reference.Note = "本段没有可发送的参考图，参考音频需要与参考图一起发送"
		case len(media) >= profile.MaxAudios:
			reference.Note = fmt.Sprintf("超出视频模型参考音频上限（%d 段）", profile.MaxAudios)
		default:
			resource, err := s.repo.Resource(cast.VoiceSampleResourceID)
			if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
				return nil, err
			}
			switch {
			case resource == nil || resource.Status != model.ResourceStatusReady || resource.Kind != "audio":
				reference.Note = "声音样本已不可用，请重新指定"
			case profile.MaxAudioSeconds > 0 && resource.DurationMs > int64(profile.MaxAudioSeconds)*1000:
				reference.Note = fmt.Sprintf("声音样本 %d 秒，超过视频模型上限 %d 秒，请换一段更短的样本", (resource.DurationMs+999)/1000, profile.MaxAudioSeconds)
			default:
				reference.Sent = true
				reference.Label = fmt.Sprintf("参考音频%d", len(media)+1)
				media = append(media, map[string]any{"id": reference.Label, "name": reference.Label, "type": resource.MimeType, "mimeType": resource.MimeType, "storageKey": "resource:" + resource.ID, "bytes": resource.Size, "durationMs": resource.DurationMs})
			}
		}
		request.AudioReferences = append(request.AudioReferences, reference)
	}
	return media, nil
}

// dramaSegmentVoicedSpeakers 是本段有台词、且指定了声音样本的角色（只取角色本体，造型沿用本体的声音），按开口顺序去重。
func dramaSegmentVoicedSpeakers(shots []model.DramaShot, casts map[string]model.DramaCast) []model.DramaCast {
	index := production.NewCastIndex()
	for _, cast := range casts {
		if cast.Kind == "character" && cast.ParentID == "" {
			index.Add(cast.ID, append([]string{cast.Name}, decodeStringList(cast.AliasesJSON)...)...)
		}
	}
	result := []model.DramaCast{}
	seen := map[string]bool{}
	for _, shot := range shots {
		if strings.TrimSpace(shot.Dialogue) == "" || production.IsNarrator(shot.Speaker) {
			continue
		}
		id, ok := index.Lookup(shot.Speaker)
		if !ok || seen[id] {
			continue
		}
		seen[id] = true
		if cast := casts[id]; cast.VoiceSampleResourceID != "" {
			result = append(result, cast)
		}
	}
	return result
}

// dramaSegmentDurationError 用任务准入同一份时长合同核对取整后的秒数：不被接受时点名段号、秒数与可选范围，
// 而不是提交后才收到泛化的拒绝。segmentIndex 从 0 开始。
func dramaSegmentDurationError(segmentIndex int, seconds int, duration VideoDurationConfig) error {
	if videoDurationAllowed(duration, seconds) {
		return nil
	}
	return fmt.Errorf("第 %d 段需要 %d 秒，所选模型只支持 %s；请调整分镜时长或换用其他视频模型", segmentIndex+1, seconds, videoDurationSupportLabel(duration))
}

// dramaCastImageState 是没能随请求发送的参考图当前状态，写进段视频的限制说明。
func dramaCastImageState(cast model.DramaCast) string {
	switch cast.ImageStatus {
	case model.DramaMediaFailed:
		return "生成失败"
	case model.DramaMediaQueued, model.DramaMediaRunning:
		return "生成中"
	}
	return "未生成"
}

func (s *Service) dramaResourceReference(id, name, role string) (map[string]any, error) {
	// The caller has already verified the project owner; check resource ownership at submission too.
	resource, err := s.repo.Resource(id)
	if err != nil {
		return nil, err
	}
	if resource.Status != model.ResourceStatusReady || !strings.HasPrefix(resource.MimeType, "image/") {
		return nil, errors.New("参考图片不可用")
	}
	ref := map[string]any{"id": name, "name": name, "type": resource.MimeType, "mimeType": resource.MimeType, "storageKey": "resource:" + id, "bytes": resource.Size, "width": resource.Width, "height": resource.Height}
	if role != "" {
		ref["role"] = role
	}
	return ref, nil
}

func (request DramaSegmentRequest) bindVideoReferences(metadata map[string]any) string {
	bindings := dramaReferenceBindings(request.References)
	header := request.Header
	if request.TailFrameAsReference {
		bindings = append(bindings, dramaReferenceBinding{Label: dramaTailReferenceLabel, MediaID: "first-frame"})
		header = strings.Replace(header, dramaTailReferenceHeader, "以"+dramaTailReferenceLabel+"作为本段的开场参考。", 1)
	} else if request.FirstFrameResourceID != "" {
		metadata["videoStartFrameNodeId"] = "first-frame"
	}
	metadata[dramaReferenceBindingsKey] = bindings
	return header
}

func (r *dramaRun) submitSegmentVideo(job *model.DramaJob) (*model.Task, bool, error) {
	segment, err := r.s.repo.DramaSegment(r.project.ID, job.ShotID)
	if err != nil {
		return nil, false, err
	}
	initialPayload, _ := json.Marshal(dramaRevisionPayload{Revision: segment.Revision, VideoRevision: segment.VideoRevision})
	job.PayloadJSON = string(initialPayload)
	if segment.VideoStatus != "" && segment.VideoStatus != model.DramaMediaQueued {
		return nil, true, nil
	}
	episode, err := r.s.repo.DramaEpisode(r.project.ID, segment.EpisodeID)
	if err != nil {
		return nil, false, err
	}
	settings, meta := dramaEpisodeStyleSettings(r.settings, r.meta, *episode)
	explicit := segment.VideoStatus == model.DramaMediaQueued && (episode.Stage == model.DramaEpisodePrompts || episode.Stage == model.DramaEpisodeReview)
	if (episode.Stage != model.DramaEpisodeVideo && !explicit) || (r.mediaHeld(episode) && segment.VideoStatus != model.DramaMediaQueued) || r.sampleBlocked(episode) {
		return nil, true, nil
	}
	if !dramaPromptReady(*segment) {
		return nil, false, errors.New("请先完成并确认本段视频提示词")
	}
	shots, err := r.s.repo.DramaShots(episode.ID)
	if err != nil {
		return nil, false, err
	}
	rows, err := r.s.repo.DramaSegments(episode.ID)
	if err != nil {
		return nil, false, err
	}
	casts := map[string]model.DramaCast{}
	latestCasts, err := r.s.repo.DramaCasts(r.project.ID)
	if err != nil {
		return nil, false, err
	}
	for _, cast := range latestCasts {
		casts[cast.ID] = cast
	}
	var previous *model.DramaSegment
	for i := range rows {
		if rows[i].ID == segment.ID && i > 0 && !settings.parallelVideo() {
			previous = &rows[i-1]
		}
	}
	for _, draft := range buildDramaSegmentDrafts(settings, meta, shots, casts, rows) {
		if draft.view.Index != segment.SegmentIndex {
			continue
		}
		request, refs, audios, err := r.s.prepareDramaSegment(settings, draft, *segment, previous, casts)
		if err != nil {
			return nil, false, err
		}
		if segment.PromptSeconds > 0 && segment.PromptSeconds != request.Seconds {
			return nil, false, errors.New("所选模型时长档位与提示词不同，请先用该模型重新撰写提示词")
		}
		if len(request.UnknownReferences) > 0 {
			return nil, false, errors.New(request.Warning)
		}
		if request.FirstFramePending {
			return nil, true, nil
		}
		for _, ref := range append(append([]any{}, refs...), audios...) {
			m := ref.(map[string]any)
			id := strings.TrimPrefix(m["storageKey"].(string), "resource:")
			if _, err := r.s.repo.ResourceForUser(r.project.UserID, id); err != nil {
				return nil, false, err
			}
		}
		metadata := r.metadata(job)
		metadata["videoEditOperation"] = request.Operation
		header := request.bindVideoReferences(metadata)
		// 画面参数与声音开关取自预演：比例或分辨率标签按模型能力合同换算，不出声的模型显式关闭声音。
		config := map[string]any{"videoSeconds": itoa(request.Seconds), "videoGenerateAudio": strconv.FormatBool(request.GenerateAudio)}
		dramaVideoScreen{Size: request.Size, Resolution: request.Resolution}.apply(config)
		prompt := strings.TrimSpace(header + "\n\n" + dramaSegmentRequestPrompt(*segment, request))
		if chars := utf8.RuneCountInString(prompt); request.PromptMaxChars > 0 && chars > request.PromptMaxChars {
			return nil, false, fmt.Errorf("段提示词、画风与素材说明共 %d 个字符，超过所选视频模型上限 %d 个字符；请精简画风、资产描述或提示词，或换用上限更大的模型。原段稿已保留，不会自动重写", chars, request.PromptMaxChars)
		}
		payload, _ := json.Marshal(dramaRevisionPayload{Revision: segment.Revision, VideoRevision: segment.VideoRevision, Seconds: request.Seconds})
		job.PayloadJSON = string(payload)
		input := map[string]any{"config": config, "referenceImages": refs, "metadata": metadata}
		if len(audios) > 0 {
			input["referenceAudios"] = audios
		}
		task, err := r.createTaskWith(job, segmentVideoChoice(*segment, settings.Models.Video), "video", request.Operation, prompt, input)
		return task, false, err
	}
	return nil, false, errors.New("剧情段没有对应分镜")
}

func (r *dramaRun) applySegmentVideo(job *model.DramaJob, task *model.Task) error {
	resourceID := dramaTaskResource(task)
	if resourceID == "" {
		return errors.New("视频任务未返回资源")
	}
	var payload dramaRevisionPayload
	if err := json.Unmarshal([]byte(job.PayloadJSON), &payload); err != nil {
		return err
	}
	// 入库秒数与成片拼接优先跟资源实测时长对齐（与画布采用路径一致）；探测不到时回退请求秒数。
	durationMs := int64(payload.Seconds) * 1000
	seconds := payload.Seconds
	if resource, resErr := r.s.repo.ResourceForUser(r.project.UserID, resourceID); resErr == nil && resource != nil && resource.DurationMs > 0 {
		durationMs = resource.DurationMs
		if calibrated := int((resource.DurationMs + 999) / 1000); calibrated > 0 {
			seconds = calibrated
		}
	}
	segment, err := r.s.repo.DramaSegment(r.project.ID, job.ShotID)
	if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
		return err
	}
	current := err == nil && segment.Revision == payload.Revision && segment.VideoRevision == payload.VideoRevision
	// 抽尾帧在后台进行，本函数每轮都会重入：段视频已是这条结果时说明版本记录与入库已经做过。
	if !current || segment.VideoResourceID != resourceID {
		if err := r.s.repo.CreateDramaTake(&model.DramaTake{ID: newID(), ProjectID: r.project.ID, OwnerID: job.ShotID, Kind: "video", ResourceID: resourceID, TaskID: task.ID, Prompt: task.Prompt, DurationMs: durationMs, CreatedAt: time.Now()}); err != nil {
			return err
		}
	}
	if !current {
		return nil
	}
	if segment.VideoResourceID != resourceID {
		// Persist the paid output before local post-processing. Retrying only reopens this task's result.
		// 换成新视频时清掉旧尾帧，旧尾帧不能当作新视频的最后一帧。
		if applied, err := r.s.repo.UpdateDramaSegmentVideoRevision(segment.ID, payload.Revision, payload.VideoRevision, map[string]any{"video_resource_id": resourceID, "video_seconds": seconds, "tail_frame_resource_id": ""}); err != nil {
			return err
		} else if !applied {
			return nil
		}
		segment.VideoResourceID, segment.TailFrameResourceID = resourceID, ""
	}
	if segment.TailFrameResourceID == "" {
		if err := r.s.takeDramaTailFailure(resourceID); err != nil {
			return err
		}
		s, userID, segmentID, revision, videoRevision := r.s, r.project.UserID, segment.ID, payload.Revision, payload.VideoRevision
		s.startDramaTail(resourceID, func() error {
			tail, err := s.extractDramaTailFrame(userID, resourceID)
			if err != nil {
				return err
			}
			_, err = s.repo.SetDramaSegmentTail(segmentID, revision, videoRevision, resourceID, tail)
			return err
		})
		// 后台执行器可能已同步跑完（测试），或上一轮已抽好：重读一次，抽完就在本轮收尾。
		if segment, err = r.s.repo.DramaSegment(r.project.ID, job.ShotID); errors.Is(err, gorm.ErrRecordNotFound) {
			return nil
		} else if err != nil {
			return err
		}
		if segment.Revision != payload.Revision || segment.VideoRevision != payload.VideoRevision || segment.VideoResourceID != resourceID {
			return nil
		}
		if segment.TailFrameResourceID == "" {
			if err := r.s.takeDramaTailFailure(resourceID); err != nil {
				return err
			}
			return &dramaSyncDeferred{err: &dramaPendingTail{resourceID: resourceID}}
		}
	}
	_, err = r.s.repo.UpdateDramaSegmentVideoRevision(segment.ID, payload.Revision, payload.VideoRevision, map[string]any{"video_status": model.DramaMediaReady, "video_error": ""})
	return err
}

// dramaVideoJobReplayable 表示段视频作业的生成任务已成功，只是结果回写（如抽尾帧）失败；
// 重新处理会重放同一任务结果，不再提交模型。
func dramaVideoJobReplayable(job model.DramaJob) bool {
	if job.Kind != model.DramaJobSegmentVideo || job.Status != model.DramaJobFailed || job.TaskID == "" {
		return false
	}
	var attempts []DramaJobAttempt
	_ = json.Unmarshal([]byte(job.AttemptsJSON), &attempts)
	for _, attempt := range attempts {
		if attempt.TaskID == job.TaskID && attempt.Status == string(model.TaskStatusSucceeded) {
			return true
		}
	}
	return false
}

func dramaVideoJobReplayableForSegment(job model.DramaJob, segment model.DramaSegment) bool {
	var payload dramaRevisionPayload
	return dramaVideoJobReplayable(job) && json.Unmarshal([]byte(job.PayloadJSON), &payload) == nil && payload.Revision == segment.Revision && payload.VideoRevision == segment.VideoRevision
}

// ReprocessDramaSegmentVideo 重新处理一段已生成、但后处理失败的视频：只重放原任务结果，不重新生成、不重复扣费。
func (s *Service) ReprocessDramaSegmentVideo(userID, projectID, episodeID string, index int) (map[string]any, error) {
	project, p, err := s.dramaForUser(userID, projectID)
	if err != nil {
		return nil, err
	}
	if err := requireDramaGuideComplete(p); err != nil {
		return nil, err
	}
	episode, err := s.repo.DramaEpisode(project.ID, episodeID)
	if err != nil {
		return nil, err
	}
	rows, err := s.repo.DramaSegments(episode.ID)
	if err != nil {
		return nil, err
	}
	var segment *model.DramaSegment
	for i := range rows {
		if rows[i].SegmentIndex == index {
			segment = &rows[i]
			break
		}
	}
	if segment == nil {
		return nil, BadAuthRequest("剧情段不存在")
	}
	if segment.VideoStatus != model.DramaMediaFailed || segment.VideoResourceID == "" {
		return nil, BadAuthRequest("本段没有需要重新处理的视频")
	}
	jobs, err := s.repo.RecentDramaSegmentJobs(project.ID, episode.ID)
	if err != nil {
		return nil, err
	}
	for _, job := range jobs {
		if job.Kind != model.DramaJobSegmentVideo || job.ShotID != segment.ID {
			continue
		}
		// 只看最近一次视频作业：更早的结果已被后续生成取代，不能拿来重放。
		if !dramaVideoJobReplayableForSegment(job, *segment) {
			break
		}
		reopened, err := s.repo.ReopenDramaSegmentVideoJob(job.ID, segment.ID)
		if err != nil {
			return nil, err
		}
		if !reopened {
			break
		}
		return map[string]any{"reprocessing": true}, s.requestDramaWork(p)
	}
	return nil, BadAuthRequest("找不到可重新处理的视频结果，请重新生成本段视频")
}

// dramaTailDownloadTimeout 是抽尾帧前读取段视频的上限；超时转为可重新处理的失败，而不是一直“生成中”。
const dramaTailDownloadTimeout = 3 * time.Minute

func (s *Service) extractDramaTailFrame(userID, resourceID string) (string, error) {
	if s.dramaTailFrameHook != nil {
		return s.dramaTailFrameHook(userID, resourceID)
	}
	var tail string
	err := s.withDramaVideoFile(userID, resourceID, func(resource *model.Resource, input string) error {
		var saveErr error
		tail, saveErr = s.saveDramaTailFrame(userID, resource, input)
		return saveErr
	})
	return tail, err
}

// dramaVideoFacts 是对一段视频的本地探测结果：尾帧资源、实际时长与是否含音轨（探测不到时为 nil）。
type dramaVideoFacts struct {
	TailResourceID string
	DurationMs     int64
	HasAudio       *bool
}

// inspectDramaVideo 下载一次视频，抽取尾帧并探测时长与音轨；用于把画布上的视频采用为剧情段。
func (s *Service) inspectDramaVideo(userID string, resource *model.Resource) (dramaVideoFacts, error) {
	facts := dramaVideoFacts{DurationMs: resource.DurationMs}
	if s.dramaTailFrameHook != nil {
		tail, err := s.dramaTailFrameHook(userID, resource.ID)
		facts.TailResourceID = tail
		return facts, err
	}
	err := s.withDramaVideoFile(userID, resource.ID, func(opened *model.Resource, input string) error {
		tail, err := s.saveDramaTailFrame(userID, opened, input)
		if err != nil {
			return err
		}
		facts.TailResourceID = tail
		if probed := probeMediaDurationMs(input); probed > 0 {
			facts.DurationMs = probed
		}
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		if hasAudio, probeErr := probeHasAudioStream(ctx, input); probeErr == nil {
			facts.HasAudio = &hasAudio
		}
		return nil
	})
	return facts, err
}

// withDramaVideoFile 把视频资源下载到临时文件后交给 fn；读取对象存储有超时保护。
func (s *Service) withDramaVideoFile(userID, resourceID string, fn func(resource *model.Resource, input string) error) error {
	resource, body, err := s.OpenResource(userID, resourceID)
	if err != nil {
		return err
	}
	defer body.Close()
	// 读取对象存储可能卡住：超时后关闭读取流让 io.Copy 返回，避免一段视频阻塞整个调度循环。
	var stalled atomic.Bool
	watchdog := time.AfterFunc(dramaTailDownloadTimeout, func() {
		stalled.Store(true)
		_ = body.Close()
	})
	defer watchdog.Stop()
	if !strings.HasPrefix(resource.MimeType, "video/") {
		return errors.New("尾帧来源不是视频")
	}
	dir, err := os.MkdirTemp("", "yingce-drama-tail-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	input := filepath.Join(dir, "input.mp4")
	file, err := os.Create(input)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(file, body)
	watchdog.Stop()
	closeErr := file.Close()
	if copyErr != nil {
		if stalled.Load() {
			return fmt.Errorf("读取段视频超时（%d 秒），可稍后点“重新处理”", int(dramaTailDownloadTimeout.Seconds()))
		}
		return copyErr
	}
	if closeErr != nil {
		return closeErr
	}
	return fn(resource, input)
}

// saveDramaTailFrame 用 ffmpeg 取本地视频的最后一帧并保存为图片资源。
func (s *Service) saveDramaTailFrame(userID string, resource *model.Resource, input string) (string, error) {
	ffmpegBin, err := renderFfmpegBinary()
	if err != nil {
		return "", fmt.Errorf("抽取尾帧失败：%w", err)
	}
	dir, err := os.MkdirTemp("", "yingce-drama-tail-out-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(dir)
	output := filepath.Join(dir, "tail.png")
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	// Decode every remaining frame and update the same output, so the saved image is the actual final frame.
	cmd := exec.CommandContext(ctx, ffmpegBin, "-hide_banner", "-loglevel", "error", "-sseof", "-1", "-i", input, "-an", "-update", "1", "-y", output)
	hideCommandWindow(cmd)
	if out, err := cmd.CombinedOutput(); err != nil {
		detail := strings.TrimSpace(string(out))
		if detail == "" {
			detail = err.Error()
		}
		return "", fmt.Errorf("抽取尾帧失败：%s", clipText(detail, 400))
	}
	image, err := os.Open(output)
	if err != nil {
		return "", err
	}
	defer image.Close()
	info, err := image.Stat()
	if err != nil {
		return "", err
	}
	saved, err := s.UploadResourceFile(userID, "tail.png", info.Size(), "image", resource.Width, resource.Height, 0, image, "drama-tail:"+resource.ID)
	if err != nil {
		return "", err
	}
	return saved.ID, nil
}
