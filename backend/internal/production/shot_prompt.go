package production

import (
	"fmt"
	"math"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

// ShotVideoPromptInput 将段内的一个镜头渲染为独立生成请求。
// Segment.References 的非空 Label 对应本次实际附件，空 Label 只提供文字设定。
type ShotVideoPromptInput struct {
	Segment                         SegmentPromptInput
	ShotIndex                       int
	ShotNumber                      int
	Seconds                         int
	CameraIntent                    string
	WrittenPrompt                   string
	WrittenPromptUsesShotReferences bool
	SourceReferences                []SegmentReference
}

// ShotVideoPrompt 保留可靠的单镜写稿，并用结构化数据补齐场景、起幅、参考图和声音约束。
// 镜头索引无效时返回空串；未指定秒数时按当前镜头时长向上取整，至少一秒。
func ShotVideoPrompt(in ShotVideoPromptInput) string {
	if in.ShotIndex < 0 || in.ShotIndex >= len(in.Segment.Shots) {
		return ""
	}
	shot := in.Segment.Shots[in.ShotIndex]
	cameraIntent := NormalizeShotCameraIntent(in.CameraIntent)
	if cameraIntent != "" {
		shot.Camera = cameraIntent
	}
	seconds := in.Seconds
	if seconds <= 0 {
		seconds = max(1, int(math.Ceil(float64(shot.DurationMs)/1000)))
	}
	number := in.ShotNumber
	if number <= 0 {
		number = in.ShotIndex + 1
	}
	actual := shotActualReferenceRewriter(in.Segment.References)
	fromWritten := shotReferenceRewriter(in.SourceReferences, in.Segment.References)
	var b strings.Builder
	fmt.Fprintf(&b, "第%d镜头视频｜单镜生成\n", number)
	fmt.Fprintf(&b, "所属剧情段：第%d段《%s》，段内第%d/%d镜。\n", in.Segment.Index+1, fromWritten(firstNonEmpty(in.Segment.Title, "剧情段")), in.ShotIndex+1, len(in.Segment.Shots))
	fmt.Fprintf(&b, "%d秒｜%s｜%s对白｜无字幕｜1个镜头\n", seconds, firstNonEmpty(in.Segment.AspectRatio, "9:16")+segmentStyleLabel(fromWritten(firstNonEmpty(in.Segment.Style, "写实电影感")), in.Segment.VisualDirection), firstNonEmpty(in.Segment.Language, "中文"))
	if in.Segment.VisualDirection != "" {
		b.WriteString(in.Segment.VisualDirection + "\n")
	}
	b.WriteString("仅生成当前一个镜头，完整覆盖下方时间范围；保持本场景的服装、道具状态、光线方向和机位轴线连续。\n")
	writeShotContinuity(&b, in)

	b.WriteString("\n【场景与起幅】\n")
	if scene := strings.TrimSpace(shot.Scene); scene != "" {
		b.WriteString("场景：" + fromWritten(scene) + "。\n")
	}
	if image := strings.TrimSpace(shot.ImagePrompt); image != "" {
		b.WriteString("起幅：" + fromWritten(image) + "\n")
	}
	if rules := strings.TrimSpace(in.Segment.VisualRules); rules != "" {
		b.WriteString(fromWritten(rules) + "\n")
	}
	b.WriteString("保持人物画面左右关系与道具归属，不越轴、不穿模；画面不出现字幕、水印和界面元素。\n")
	if len(in.Segment.References) > 0 {
		b.WriteString("\n【本镜参考图】\n")
		for _, ref := range in.Segment.References {
			name := strings.TrimSpace(ref.Name)
			if name == "" {
				continue
			}
			line := actual(name)
			if label := shotReferenceLabel(ref.Label); label != "" {
				line += "（" + actual(label) + "）"
			}
			if detail := strings.TrimSpace(ref.Detail); detail != "" {
				line += "：" + actual(detail)
			}
			b.WriteString(line + "。\n")
		}
		b.WriteString("带编号项对应本次实际参考图，其余仅为文字设定；素材外观与空间以各自设定为准，出场和动作以本镜内容为准。\n")
	}

	b.WriteString("\n【声音与表演】\n")
	fmt.Fprintf(&b, "对白使用%s，口型与台词同步；环境音随本镜可见动作。\n", firstNonEmpty(in.Segment.Language, "中文"))
	if strings.TrimSpace(shot.Dialogue) == "" {
		b.WriteString("当前镜头绝对无台词。\n")
	} else {
		speaker := strings.TrimSpace(shot.Speaker)
		if speaker == "" || IsNarrator(speaker) {
			speaker = "旁白（画外音）"
		}
		b.WriteString("本镜台词的说话人：" + fromWritten(speaker) + "，只说当前镜头给定的台词。\n")
	}
	b.WriteString(PerformanceRule(in.Segment.Performance) + "\n")
	fmt.Fprintf(&b, "本镜运镜动感 %d/10，仅控制本镜既定运镜的幅度与速度；服从本镜景别与机位，不新增切镜。\n", normalizedDirectionLevel(in.Segment.CameraMotion, DefaultCameraLevel))
	if shot.Camera == "固定" || shot.Camera == "无运镜" {
		b.WriteString("本镜全程保持固定机位。\n")
	}
	for _, ref := range in.Segment.References {
		if ref.Kind == "character" && strings.TrimSpace(ref.Voice) != "" {
			b.WriteString(actual(ref.Name+"："+ref.Voice) + "\n")
		}
	}

	heading := firstNonEmpty(shot.ShotSize, "当前镜头")
	if camera := strings.TrimSpace(shot.Camera); camera != "" {
		heading += "·" + camera
	}
	fmt.Fprintf(&b, "\n【00.00—%s秒｜镜头%d：%s】\n", segmentClock(int64(seconds)*1000), number, fromWritten(heading))
	if body, ok := writtenShotBody(in, seconds); ok {
		if cameraIntent != "" {
			body = overrideWrittenShotFraming(body, shot.ShotSize, cameraIntent)
		}
		if in.WrittenPromptUsesShotReferences {
			b.WriteString(actual(body) + "\n")
		} else {
			b.WriteString(fromWritten(body) + "\n")
		}
	} else {
		writeStructuredShotBody(&b, in.Segment, shot, seconds, fromWritten)
	}
	return strings.TrimSpace(b.String())
}

func writeShotContinuity(b *strings.Builder, in ShotVideoPromptInput) {
	if len(in.Segment.Shots) < 2 {
		return
	}
	// 背景中的旧图号只还原名称，不能因它恰好等于本次附件编号而误绑图片。
	nameOnly := shotReferenceRewriter(in.SourceReferences, nil)
	current := in.Segment.Shots[in.ShotIndex]
	b.WriteString("\n【段内衔接背景（不作为本镜动作）】\n")
	if in.ShotIndex > 0 {
		previous := in.Segment.Shots[in.ShotIndex-1]
		if scene := strings.TrimSpace(previous.Scene); scene != "" {
			b.WriteString("此前镜头的场景：" + nameOnly(scene) + "。\n")
		}
		for _, detail := range []struct{ label, text string }{{"此前镜头的起始画面", previous.ImagePrompt}, {"此前已发生", previous.Action}} {
			text := strings.TrimSpace(detail.text)
			if text == "" || strings.ContainsAny(text, "【】“”\"") || (strings.TrimSpace(previous.Dialogue) != "" && strings.Contains(text, strings.TrimSpace(previous.Dialogue))) {
				continue
			}
			b.WriteString(detail.label + "：" + nameOnly(text) + "。\n")
		}
		b.WriteString("上述内容仅是既往事实，本镜不重演此前事件。")
		if scene := strings.TrimSpace(current.Scene); scene != "" && scene == strings.TrimSpace(previous.Scene) {
			b.WriteString("前后处于同一场景，延续空间、服装、道具与光线；人物当前站位和姿态以本镜起幅为准。\n")
		} else {
			b.WriteString("场景转换时使用本镜场景与起幅，不将此前场景的站位移入当前场景。\n")
		}
	}
	if in.ShotIndex+1 < len(in.Segment.Shots) {
		next := in.Segment.Shots[in.ShotIndex+1]
		parts := []string{}
		if scene := strings.TrimSpace(next.Scene); scene != "" {
			parts = append(parts, "场景为"+nameOnly(scene))
		}
		if size := strings.TrimSpace(next.ShotSize); size != "" {
			parts = append(parts, "景别为"+nameOnly(size))
		}
		if len(parts) > 0 {
			b.WriteString("后续镜头的构图背景：" + strings.Join(parts, "，") + "；本镜仅完成当前内容，不提前切入后续镜头。\n")
		}
	}
}

func shotFraming(shotSize, camera string, level int) string {
	framing := strings.TrimSpace(shotLens[shotSize] + shotSize)
	move := firstNonEmpty(cameraMoveText(level, camera), camera)
	if move != "" {
		framing = strings.Trim(strings.Join([]string{framing, move}, "，"), "，")
	}
	return framing
}

func writeStructuredShotBody(b *strings.Builder, segment SegmentPromptInput, shot SegmentShot, seconds int, rewrite func(string) string) {
	if framing := shotFraming(shot.ShotSize, shot.Camera, segment.CameraMotion); framing != "" {
		b.WriteString(rewrite(framing) + "。\n")
	}
	switch shot.Transition {
	case TransitionBlack:
		b.WriteString("本镜从黑场淡入。\n")
	case TransitionWhite:
		b.WriteString("本镜以短暂闪白切入。\n")
	}
	if action := strings.TrimSpace(shot.Action); action != "" {
		b.WriteString(rewrite(action) + "\n")
	}
	if motion := strings.TrimSpace(shot.VideoPrompt); motion != "" && motion != strings.TrimSpace(shot.Action) {
		b.WriteString(rewrite(motion) + "\n")
	}
	if dialogue := strings.TrimSpace(shot.Dialogue); dialogue != "" {
		speaker := strings.TrimSpace(shot.Speaker)
		if speaker == "" || IsNarrator(speaker) {
			speaker = "旁白（画外音）"
		}
		fmt.Fprintf(b, "%s：“%s”\n", rewrite(speaker), rewrite(dialogue))
		if rate := segment.speechRateText(); rate != "" {
			b.WriteString("台词" + rate + "。\n")
		}
		if seconds >= 2 {
			b.WriteString("台词说完留" + segment.pauseText() + "秒气口，停顿包含在本镜时长内。\n")
		}
	} else {
		b.WriteString("绝对无台词。\n")
	}
	if strings.TrimSpace(shot.Action) == "" && strings.TrimSpace(shot.VideoPrompt) == "" {
		b.WriteString("按本镜起幅和景别呈现可见表演，人物保留自然呼吸与眼神变化。\n")
	}
	b.WriteString("动作、表演与对白均在本镜时间范围内完成。\n")
}

var (
	shotVideoPromptTitle      = regexp.MustCompile(`^第[0-9]+镜头视频｜单镜生成$`)
	shotWrittenLensPrefix     = regexp.MustCompile(`(?i)^\d+(?:\.\d+)?[\t ]*mm[\t ]*`)
	shotWrittenMotionClause   = regexp.MustCompile(`^(?:(?:固定|稳定)(?:机位|镜头)|(?:机位|镜头)(?:固定|稳定)$|(?:镜头|摄影机|机位)?(?:先|再|始终|全程|缓慢|慢慢|平稳|轻微|轻轻|快速|匀速|逐渐|自然|横向|纵向|垂直|连续)*(?:跟随|跟拍|跟进|推入|推近|前推|拉远|后拉|拉出|摇向|横移|平移|侧移|升起|升高|抬升|俯拍|环绕|手持(?:镜头|拍摄|机位|晃动)|航拍|变焦))`)
	shotWrittenHeading        = regexp.MustCompile(`(?m)^[\t ]*【\s*([0-9]+(?:\.[0-9]{1,2})?)\s*[—–-]\s*([0-9]+(?:\.[0-9]{1,2})?)\s*秒\s*[｜|]\s*镜头([^：:】\r\n]+)[：:]([^】\r\n]*)】[\t ]*$`)
	shotHeadingCandidate      = regexp.MustCompile(`(?m)^[\t ]*【[^】\r\n]*镜头[^】\r\n]*】[\t ]*$`)
	shotSectionHeading        = regexp.MustCompile(`(?m)^[\t ]*【[^】\r\n]+】`)
	shotTimeRange             = regexp.MustCompile(`([0-9]+(?:\.[0-9]{1,2})?)[\t ]*[—–-][\t ]*([0-9]+(?:\.[0-9]{1,2})?)[\t ]*(秒|[：:])`)
	shotTimePoint             = regexp.MustCompile(`((?:在|于)[\t ]*)([0-9]+(?:\.[0-9]{1,2})?)[\t ]*秒|([0-9]+(?:\.[0-9]{1,2})?)[\t ]*秒(时|处|[：:])`)
	shotTimeToken             = regexp.MustCompile(shotTimeRange.String() + "|" + shotTimePoint.String())
	shotUnclearTime           = regexp.MustCompile(`[0-9]+\.[0-9]{2}[\t ]*秒|第[0-9]+(?:\.[0-9]+)?秒`)
	shotUnclearRange          = regexp.MustCompile(`[0-9]+(?:\.[0-9]+)?[\t ]*(?:至|到|~|～|－)[\t ]*[0-9]+(?:\.[0-9]+)?[\t ]*秒?`)
	shotDialogue              = regexp.MustCompile(`[：:][\t ]*[“"]([^”"\r\n]+)[”"]`)
	shotDialogueSpeaker       = regexp.MustCompile(`(?m)^[\t ]*([^“”"\r\n]+?)[：:][\t ]*[“"]([^”"\r\n]+)[”"]`)
	shotReferenceLabelPattern = regexp.MustCompile(`^参考图[1-9][0-9]*$`)
	shotOtherInstruction      = regexp.MustCompile(`第[0-9一二三四五六七八九十百]+段|镜头[0-9一二三四五六七八九十百]+`)
)

func NormalizeShotCameraIntent(value string) string {
	value = strings.TrimSpace(value)
	switch value {
	case "固定":
		return "无运镜"
	case "推", "拉", "摇", "移", "跟", "环绕", "手持":
		return value + "镜头"
	default:
		if CameraPresetRule(value) != "" {
			return value
		}
		return ""
	}
}

// SplitShotCameraIntent recognizes only standalone legacy marker lines.
func SplitShotCameraIntent(prompt string) (body, intent string) {
	const marker = "【运镜意图】"
	lines := strings.Split(prompt, "\n")
	retained := lines[:0]
	for _, line := range lines {
		if value, ok := strings.CutPrefix(strings.TrimSpace(line), marker); ok {
			if value := NormalizeShotCameraIntent(value); value != "" {
				intent = value
				continue
			}
		}
		retained = append(retained, line)
	}
	if intent == "" {
		return prompt, ""
	}
	return strings.Join(retained, "\n"), intent
}

// overrideWrittenShotFraming changes only the leading lens/framing line from a
// segment draft. Timed action, dialogue, sound and mixed prose stay intact.
func overrideWrittenShotFraming(body, shotSize, intent string) string {
	line, rest, multiline := strings.Cut(body, "\n")
	line = strings.TrimSpace(line)
	framing, suffix := line, ""
	if end := strings.IndexAny(line, "，,。；;"); end >= 0 {
		framing, suffix = strings.TrimSpace(line[:end]), line[end:]
	}
	if shotSize == "" || shotWrittenLensPrefix.ReplaceAllString(framing, "") != strings.TrimSpace(shotSize) {
		return body
	}
	if motion := strings.TrimLeft(suffix, "，,"); motion != suffix {
		end := strings.IndexAny(motion, "，,。；;")
		if end < 0 {
			end = len(motion)
		}
		if shotWrittenMotionClause.MatchString(strings.TrimSpace(motion[:end])) {
			suffix = motion[end:]
		}
	}
	line = framing + "，" + CameraPresetRule(intent) + suffix
	if suffix == "" {
		line += "。"
	}
	if multiline {
		line += "\n" + rest
	}
	return line
}

// ShotVideoCameraPrompt applies the editor's explicit camera intent at video submission.
func ShotVideoCameraPrompt(prompt, shotSize, inheritedCamera, explicit string) string {
	body, intent := SplitShotCameraIntent(prompt)
	if value := NormalizeShotCameraIntent(explicit); value != "" {
		intent = value
	}
	if intent == "" {
		if rule := CameraPresetRule(inheritedCamera); rule != "" {
			return prompt + "\n运镜要求：" + rule
		}
		return prompt
	}
	retained := strings.Split(body, "\n")

	// Replace only the recognizable fields emitted by ShotVideoPrompt. Leave human-written
	// descriptions alone; the explicit instruction below resolves any competing camera prose.
	if len(retained) > 0 && shotVideoPromptTitle.MatchString(strings.TrimSpace(retained[0])) {
		heading := firstNonEmpty(shotSize, "当前镜头")
		oldHeading := heading
		if camera := strings.TrimSpace(inheritedCamera); camera != "" {
			oldHeading += "·" + camera
		}
		for i, line := range retained {
			match := shotWrittenHeading.FindStringSubmatchIndex(line)
			if len(match) == 0 {
				continue
			}
			found := line[match[8]:match[9]]
			if found == heading+"·"+intent {
				break
			}
			if found != oldHeading {
				continue
			}
			if intent != "无运镜" && NormalizeShotCameraIntent(inheritedCamera) == "无运镜" {
				for j := range i {
					if retained[j] == "本镜全程保持固定机位。" {
						retained[j] = ""
						break
					}
				}
			}
			retained[i] = line[:match[8]] + heading + "·" + intent + line[match[9]:]
			if i+1 < len(retained) {
				framing := retained[i+1]
				retained[i+1] = overrideWrittenShotFraming(framing, shotSize, intent)
				// Only the three camera-motion bands produce distinct structured framing lines.
				for _, level := range []int{1, DefaultCameraLevel, 10} {
					if framing == shotFraming(shotSize, inheritedCamera, level)+"。" {
						retained[i+1] = shotFraming(shotSize, intent, level) + "。"
						break
					}
				}
			}
			break
		}
	}
	return strings.TrimSpace(strings.Join(retained, "\n") + "\n运镜要求：" + CameraPresetRule(intent) + "。如正文中的运镜描述与本项冲突，以本项为准；人物动作、场景与对白照原文执行。")
}

// 不复用段首栏目：其中可混有首镜动作、跨镜情绪变化和依赖上一段尾帧的指令。
func writtenShotBody(in ShotVideoPromptInput, seconds int) (string, bool) {
	shot := in.Segment.Shots[in.ShotIndex]
	if shot.DurationMs != int64(seconds)*1000 {
		return "", false
	}
	text := CleanWrittenPrompt(in.WrittenPrompt)
	blocks := shotWrittenHeading.FindAllStringSubmatchIndex(text, -1)
	candidates := shotHeadingCandidate.FindAllStringIndex(text, -1)
	if len(blocks) != len(in.Segment.Shots) || len(candidates) != len(blocks) {
		return "", false
	}
	var cursor, start, end int64
	for i, block := range blocks {
		if candidates[i][0] != block[0] || candidates[i][1] != block[1] {
			return "", false
		}
		ordinal := strings.TrimSpace(text[block[6]:block[7]])
		if ordinal != chineseOrdinal(i) && ordinal != strconv.Itoa(i+1) {
			return "", false
		}
		duration := in.Segment.Shots[i].DurationMs
		from, okFrom := shotPromptMilliseconds(text[block[2]:block[3]])
		to, okTo := shotPromptMilliseconds(text[block[4]:block[5]])
		expectedFrom, _ := shotPromptMilliseconds(segmentClock(cursor))
		expectedTo, _ := shotPromptMilliseconds(segmentClock(cursor + duration))
		if duration <= 0 || !okFrom || !okTo || from != expectedFrom || to != expectedTo || from >= to {
			return "", false
		}
		if i == in.ShotIndex {
			start, end = from, to
		}
		cursor += duration
	}
	block := blocks[in.ShotIndex]
	limit := len(text)
	if in.ShotIndex+1 < len(blocks) {
		limit = blocks[in.ShotIndex+1][0]
	}
	body := strings.TrimSpace(text[block[1]:limit])
	if next := shotSectionHeading.FindStringIndex(body); next != nil {
		body = strings.TrimSpace(body[:next[0]])
	}
	if body == "" || hasShotContinuation(body) {
		return "", false
	}
	for i, other := range in.Segment.Shots {
		if i != in.ShotIndex {
			if dialogue := strings.TrimSpace(other.Dialogue); dialogue != "" && dialogue != strings.TrimSpace(shot.Dialogue) && strings.Contains(body, dialogue) {
				return "", false
			}
			for _, action := range []string{other.Action, other.VideoPrompt} {
				action = strings.TrimSpace(action)
				if action != "" && !strings.Contains(shot.Action, action) && !strings.Contains(shot.VideoPrompt, action) && strings.Contains(body, action) {
					return "", false
				}
			}
		}
	}
	if dialogue := strings.TrimSpace(shot.Dialogue); dialogue != "" && !strings.Contains(body, dialogue) {
		return "", false
	}
	for _, dialogue := range shotDialogue.FindAllStringSubmatch(body, -1) {
		if strings.TrimSpace(dialogue[1]) != strings.TrimSpace(shot.Dialogue) {
			return "", false
		}
	}
	if strings.TrimSpace(shot.Dialogue) != "" {
		lines := shotDialogueSpeaker.FindAllStringSubmatch(body, -1)
		if len(lines) > 1 {
			return "", false
		}
		if len(lines) == 1 {
			prefix := shotTimeRange.ReplaceAllString(lines[0][1], "")
			expected := strings.TrimSpace(shot.Speaker)
			// 写稿允许时间片内叙述“某人侧身，轻声说”；未写姓名时由上方结构化说话人约束。
			if expected == "" || !strings.Contains(prefix, expected) {
				for _, other := range in.Segment.Shots {
					if speaker := strings.TrimSpace(other.Speaker); speaker != "" && speaker != expected && !IsNarrator(speaker) && strings.Contains(prefix, speaker) {
						return "", false
					}
				}
				for _, ref := range in.Segment.References {
					if name := strings.TrimSpace(ref.Name); ref.Kind == "character" && name != "" && name != expected && strings.Contains(prefix, name) {
						return "", false
					}
				}
			}
		}
	}
	// 有时间片时必须整段连续覆盖当前镜头，混用局部与段内时间码时降级。
	ranges := shotTimeRange.FindAllStringSubmatchIndex(body, -1)
	previous := start
	for _, part := range ranges {
		from, okFrom := shotPromptMilliseconds(body[part[2]:part[3]])
		to, okTo := shotPromptMilliseconds(body[part[4]:part[5]])
		if !okFrom || !okTo || from != previous || from < start || to > end || from >= to {
			return "", false
		}
		previous = to
	}
	if len(ranges) > 0 && previous != end {
		return "", false
	}
	withoutTimes := shotTimeRange.ReplaceAllString(body, "")
	for _, point := range shotTimePoint.FindAllStringSubmatch(withoutTimes, -1) {
		value := firstNonEmpty(point[2], point[3])
		at, ok := shotPromptMilliseconds(value)
		if !ok || at < start || at > end {
			return "", false
		}
	}
	withoutTimes = shotTimePoint.ReplaceAllString(withoutTimes, "")
	if shotUnclearTime.MatchString(withoutTimes) || shotUnclearRange.MatchString(withoutTimes) {
		return "", false
	}
	// 时间范围和单点统一做一次替换，防止范围末端的“秒：”被再次当成单点平移。
	body = shotTimeToken.ReplaceAllStringFunc(body, func(value string) string {
		if part := shotTimeRange.FindStringSubmatch(value); len(part) > 0 {
			from, _ := shotPromptMilliseconds(part[1])
			to, _ := shotPromptMilliseconds(part[2])
			return segmentClock(from-start) + "—" + segmentClock(to-start) + part[3]
		}
		part := shotTimePoint.FindStringSubmatch(value)
		at, _ := shotPromptMilliseconds(firstNonEmpty(part[2], part[3]))
		return part[1] + segmentClock(at-start) + "秒" + part[4]
	})
	return body, true
}

func hasShotContinuation(text string) bool {
	for _, marker := range []string{"上一段", "下一段", "上个镜头", "下个镜头", "上一镜", "下一镜", "前一镜", "后一镜", "前镜", "后镜", "接续基准", "接续起点", "总结：", "总结:", "备注：", "备注:"} {
		if strings.Contains(text, marker) {
			return true
		}
	}
	return shotOtherInstruction.MatchString(text)
}

func shotPromptMilliseconds(text string) (int64, bool) {
	value, err := strconv.ParseFloat(text, 64)
	if err != nil || math.IsInf(value, 0) || value < 0 || value >= float64(math.MaxInt64)/1000 {
		return 0, false
	}
	return int64(math.Round(value * 1000)), true
}

func shotReferenceLabel(label string) string {
	label = NormalizeReferenceTokens(strings.TrimSpace(label))
	if shotReferenceLabelPattern.MatchString(label) {
		return label
	}
	return ""
}

func shotActualReferenceRewriter(refs []SegmentReference) func(string) string {
	labels := map[string]bool{}
	for _, ref := range refs {
		if label := shotReferenceLabel(ref.Label); label != "" {
			labels[label] = true
		}
	}
	return func(text string) string {
		return referenceTokenPattern.ReplaceAllStringFunc(text, func(token string) string {
			label := NormalizeReferenceTokens(token)
			if labels[label] {
				return label
			}
			return "未编号参考素材"
		})
	}
}

// 单次替换通过素材身份重编号，避免 1→2→3 连锁；同名素材无法确定身份时只保留名称。
func shotReferenceRewriter(source, actual []SegmentReference) func(string) string {
	nameKey := func(ref SegmentReference) string {
		kind, name := strings.TrimSpace(ref.Kind), strings.TrimSpace(ref.Name)
		if kind == "" || name == "" {
			return ""
		}
		return kind + "\x00" + name
	}
	byID := map[string][]SegmentReference{}
	byName := map[string][]SegmentReference{}
	sourceNameCount := map[string]int{}
	for _, ref := range source {
		if key := nameKey(ref); key != "" {
			sourceNameCount[key]++
		}
	}
	for _, ref := range actual {
		if id := strings.TrimSpace(ref.Identity); id != "" {
			byID[id] = append(byID[id], ref)
		}
		if key := nameKey(ref); key != "" {
			byName[key] = append(byName[key], ref)
		}
	}
	resolve := func(ref SegmentReference) string {
		var matches []SegmentReference
		if id := strings.TrimSpace(ref.Identity); id != "" {
			matches = byID[id]
		} else if key := nameKey(ref); key != "" {
			matches = byName[key]
			if len(matches) != 1 || sourceNameCount[key] != 1 {
				return ""
			}
		}
		label := ""
		for _, match := range matches {
			next := shotReferenceLabel(match.Label)
			if next == "" || (label != "" && next != label) {
				return ""
			}
			label = next
		}
		return label
	}
	sourceByLabel := map[string][]SegmentReference{}
	for _, ref := range source {
		if label := shotReferenceLabel(ref.Label); label != "" {
			sourceByLabel[label] = append(sourceByLabel[label], ref)
		}
	}
	replacements := map[string]string{}
	for sourceLabel, refs := range sourceByLabel {
		label, names := resolve(refs[0]), []string{}
		for _, ref := range refs {
			if resolve(ref) != label {
				label = ""
			}
			if name := strings.TrimSpace(ref.Name); name != "" {
				name = referenceTokenPattern.ReplaceAllString(name, "未编号参考素材")
				if !slices.Contains(names, name) {
					names = append(names, name)
				}
			}
		}
		if label != "" {
			replacements[sourceLabel] = label
		} else if len(names) > 0 {
			replacements[sourceLabel] = strings.Join(names, "、")
		}
	}
	return func(text string) string {
		return referenceTokenPattern.ReplaceAllStringFunc(text, func(token string) string {
			if replacement := replacements[NormalizeReferenceTokens(token)]; replacement != "" {
				return replacement
			}
			return "未编号参考素材"
		})
	}
}
