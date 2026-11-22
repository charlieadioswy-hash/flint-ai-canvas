package production

import (
	"strings"
	"testing"
)

func TestShotVideoPromptCameraIntentKeepsProseAndReplacesStructuredFixedPosition(t *testing.T) {
	const motion = "镜头贴着桌面缓慢向上抬，桌旁的人回过头。"
	generated := ShotVideoPrompt(ShotVideoPromptInput{
		Segment: SegmentPromptInput{Shots: []SegmentShot{{ShotSize: "中景", Camera: "固定", VideoPrompt: motion}}}, Seconds: 4,
	})
	got := ShotVideoCameraPrompt(generated+"\n【运镜意图】拉镜头", "中景", "固定", "")
	for _, want := range []string{"中景·拉镜头】", motion, "运镜要求：镜头沿视轴平稳后拉", "以本项为准"} {
		if !strings.Contains(got, want) {
			t.Fatalf("missing %q in %s", want, got)
		}
	}
	for _, unwanted := range []string{"中景·固定】", "机位固定", "固定机位"} {
		if strings.Contains(got, unwanted) {
			t.Fatalf("obsolete %q in %s", unwanted, got)
		}
	}
	if markerOnly := ShotVideoCameraPrompt("【运镜意图】手持", "中景", "跟", ""); !strings.HasPrefix(markerOnly, "运镜要求：轻微自然手持运动") {
		t.Fatalf("marker-only prompt = %q", markerOnly)
	}
	const unsupported = "【运镜意图】保留自定义文字"
	if got := ShotVideoCameraPrompt(unsupported, "中景", "跟", ""); got != unsupported+"\n运镜要求："+CameraPresetRule("跟") {
		t.Fatalf("unrecognized text uses inherited direction: %q", got)
	}
}

func TestShotVideoPromptOverridesWrittenFramingWithoutLosingAction(t *testing.T) {
	in := shotPromptFixture()
	in.WrittenPrompt = strings.Replace(in.WrittenPrompt, "50mm近景，缓慢推近。", "50mm近景，缓慢推近，青衣人握紧钥匙。", 1)
	in.CameraIntent = "无运镜"
	prompt := ShotVideoCameraPrompt(ShotVideoPrompt(in), "近景", "推", in.CameraIntent)
	timeline := shotPromptTimeline(t, prompt)
	for _, want := range []string{
		"【00.00—06.00秒｜镜头8：近景·无运镜】", "50mm近景，固定机位", "青衣人握紧钥匙。",
		"00.00—03.00：青衣人（参考图2）微抬下巴", "03.00—06.00：右手握紧钥匙（参考图3）", "青衣人（压低声音）：“你终于来了。”",
	} {
		if !strings.Contains(timeline, want) {
			t.Fatalf("missing %q from camera override:\n%s", want, timeline)
		}
	}
	if strings.Contains(timeline, "缓慢推近") {
		t.Fatalf("old written camera direction survived:\n%s", timeline)
	}
	if strings.Count(timeline, "保持镜头稳定，用人物动作推动画面") != 2 {
		t.Fatalf("expected camera guidance once in framing and once in the final rule:\n%s", timeline)
	}
	legacy := ShotVideoCameraPrompt(ShotVideoPrompt(shotPromptFixture())+"\n【运镜意图】拉镜头", "近景", "推", "无运镜")
	if strings.Contains(legacy, "缓慢推近") || strings.Contains(legacy, "镜头沿视轴平稳后拉") || !strings.Contains(legacy, "近景·无运镜】") {
		t.Fatalf("dedicated camera intent did not take precedence over the written framing and legacy line:\n%s", legacy)
	}
	for _, lightingOrSound := range []string{"固定方向的光线从窗边透入", "稳定的雨声"} {
		in.WrittenPrompt = strings.Replace(shotPromptFixture().WrittenPrompt, "缓慢推近", lightingOrSound, 1)
		if got := ShotVideoPrompt(in); !strings.Contains(got, lightingOrSound) {
			t.Fatalf("lost non-camera description %q:\n%s", lightingOrSound, got)
		}
	}
}

func shotPromptFixture() ShotVideoPromptInput {
	return ShotVideoPromptInput{
		ShotIndex: 1, ShotNumber: 8, Seconds: 6,
		Segment: SegmentPromptInput{
			Index: 1, Count: 4, Title: "雨夜来客", AspectRatio: "16:9", Style: "水墨电影感", VisualRules: "保持淡墨轮廓", Language: "中文", FirstFrame: true,
			Shots: []SegmentShot{
				{Scene: "茶室", ShotSize: "全景", ImagePrompt: "红衣人站在紧闭的门外", Action: "红衣人撞开木门", Speaker: "红衣人", Dialogue: "把钥匙交出来！", DurationMs: 4000},
				{Scene: "茶室", ShotSize: "近景", Camera: "推", ImagePrompt: "青衣人站在窗边，右手捏着钥匙", Action: "青衣人缓缓抬眼", VideoPrompt: "视线停在门口，手指收紧", Speaker: "青衣人", Dialogue: "你终于来了。", DurationMs: 6000, Transition: TransitionBlack},
				{Scene: "茶室", ShotSize: "中景", Action: "红衣人踢翻茶桌", Speaker: "红衣人", Dialogue: "别想逃！", DurationMs: 3000},
			},
			References: []SegmentReference{
				{Label: "参考图1", Kind: "scene", Name: "茶室", Detail: "纸窗透入冷月光"},
				{Label: "参考图2", Kind: "character", Name: "青衣人", Detail: "青色长衫", Voice: "清冷青年音"},
				{Label: "参考图3", Kind: "prop", Name: "钥匙", Detail: "黄铜材质"},
			},
		},
		SourceReferences: []SegmentReference{
			{Label: "参考图1", Kind: "character", Name: "红衣人"},
			{Label: "参考图2", Kind: "prop", Name: "钥匙"},
			{Label: "参考图3", Kind: "character", Name: "青衣人"},
			{Label: "参考图4", Kind: "scene", Name: "茶室"},
		},
		WrittenPrompt: `严格从第1段视频末尾的画面继续，不重新摆位。
第2段视频《雨夜来客》
13秒｜16:9｜水墨电影感｜中文对白｜无字幕｜3个镜头
【视觉与首帧】
首帧即第1段视频最后一帧。红衣人撞开木门，末尾红衣人踢翻茶桌。
【场景布局、人物站位与机位轴线】
青衣人会离开窗边，红衣人会走进茶室。
【光源与声音】
在末尾听到茶桌摔碎的响声。

【00.00—04.00秒｜镜头一：破门】
24mm全景，固定机位。
00.00—04.00：红衣人撞开木门。
红衣人（暴怒）：“把钥匙交出来！”

【04.00—10.00秒｜镜头二：窗前对视】
50mm近景，缓慢推近。
04.00—07.00：青衣人（参考图3）微抬下巴，眼睛转向门口。
07.00—10.00：右手握紧钥匙（参考图2），拇指按住钥匙齿。
青衣人（压低声音）：“你终于来了。”

【10.00—13.00秒｜镜头三：掀桌】
35mm中景。
10.00—13.00：红衣人踢翻茶桌，碎瓷落地。
红衣人（急怒）：“别想逃！”
【总结】
下一段打开密室，红衣人跳窗。
`,
	}
}

func shotPromptTimeline(t *testing.T, prompt string) string {
	t.Helper()
	index := strings.Index(prompt, "【00.00—")
	if index < 0 {
		t.Fatalf("single-shot timeline missing:\n%s", prompt)
	}
	if got := len(shotWrittenHeading.FindAllStringIndex(prompt, -1)); got != 1 {
		t.Fatalf("got %d shot blocks, want exactly one:\n%s", got, prompt)
	}
	return prompt[index:]
}

func TestShotVideoPromptExtractsMiddleShotAndResetsTime(t *testing.T) {
	in := shotPromptFixture()
	prompt := ShotVideoPrompt(in)
	timeline := shotPromptTimeline(t, prompt)
	for _, want := range []string{
		"单镜生成", "6秒｜16:9｜水墨电影感｜中文对白｜无字幕｜1个镜头", "段内第2/3镜", "清冷青年音", "青衣人站在窗边，右手捏着钥匙", "纸窗透入冷月光", "保持淡墨轮廓",
	} {
		if !strings.Contains(prompt, want) {
			t.Errorf("missing context %q:\n%s", want, prompt)
		}
	}
	for _, want := range []string{"【00.00—06.00秒｜镜头8：近景·推】", "00.00—03.00：青衣人（参考图2）微抬下巴", "03.00—06.00：右手握紧钥匙（参考图3）", "青衣人（压低声音）：“你终于来了。”"} {
		if !strings.Contains(timeline, want) {
			t.Errorf("missing extracted content %q:\n%s", want, timeline)
		}
	}
	for _, forbidden := range []string{"把钥匙交出来！", "别想逃！", "首帧即第1段", "茶桌摔碎", "离开窗边", "下一段打开密室", "镜头一", "镜头二", "镜头三"} {
		if strings.Contains(prompt, forbidden) {
			t.Errorf("leaked segment content %q:\n%s", forbidden, prompt)
		}
	}
	for _, forbidden := range []string{"红衣人撞开木门", "红衣人踢翻茶桌", "04.00—", "07.00—", "10.00—", "13.00", "青衣人缓缓抬眼"} {
		if strings.Contains(timeline, forbidden) {
			t.Errorf("non-current or fallback action in timeline %q:\n%s", forbidden, timeline)
		}
	}
}

func TestShotVideoPromptFallbackIncludesStructuredCurrentShot(t *testing.T) {
	in := shotPromptFixture()
	in.WrittenPrompt = "技能自由格式：先撞门，再抬眼，最后踢桌。"
	prompt := ShotVideoPrompt(in)
	timeline := shotPromptTimeline(t, prompt)
	for _, want := range []string{"茶室", "起幅：青衣人站在窗边，右手捏着钥匙", "50mm近景，缓慢推近。", "本镜从黑场淡入。", "青衣人缓缓抬眼", "视线停在门口，手指收紧", "青衣人：“你终于来了。”", "00.00—06.00"} {
		if !strings.Contains(prompt, want) {
			t.Errorf("fallback missing %q:\n%s", want, prompt)
		}
	}
	if strings.Contains(timeline, "撞门") || strings.Contains(timeline, "踢桌") || strings.Contains(timeline, "微抬下巴") {
		t.Fatalf("unreliable written prompt leaked into fallback:\n%s", timeline)
	}
}

func TestShotVideoPromptChangedDurationUsesCurrentRequestedTimeline(t *testing.T) {
	in := shotPromptFixture()
	in.Seconds = 8
	prompt := ShotVideoPrompt(in)
	timeline := shotPromptTimeline(t, prompt)
	if !strings.Contains(prompt, "8秒｜16:9") || !strings.Contains(timeline, "【00.00—08.00秒") || !strings.Contains(timeline, "青衣人缓缓抬眼") {
		t.Fatalf("requested duration or fallback lost:\n%s", prompt)
	}
	if strings.Contains(timeline, "03.00") || strings.Contains(timeline, "微抬下巴") {
		t.Fatalf("old time-sliced actions reused for changed duration:\n%s", timeline)
	}
}

func TestShotVideoPromptResetsSoundTimePointsAndRangesOnce(t *testing.T) {
	in := shotPromptFixture()
	in.WrittenPrompt = strings.ReplaceAll(in.WrittenPrompt, "07.00：青衣人", "07.00秒：青衣人")
	in.WrittenPrompt = strings.ReplaceAll(in.WrittenPrompt, "10.00：右手", "10.00秒：右手")
	in.WrittenPrompt = strings.Replace(in.WrittenPrompt, "青衣人（压低声音）", "08.50秒时响起钥匙摩擦声。在09.00秒右手略微松开。\n青衣人（压低声音）", 1)
	timeline := shotPromptTimeline(t, ShotVideoPrompt(in))
	for _, want := range []string{"00.00—03.00秒：青衣人", "03.00—06.00秒：右手", "04.50秒时响起钥匙摩擦声", "在05.00秒右手略微松开"} {
		if !strings.Contains(timeline, want) {
			t.Errorf("timestamp was not rebased once: missing %q:\n%s", want, timeline)
		}
	}
	if strings.Contains(timeline, "08.50") || strings.Contains(timeline, "09.00") || strings.Contains(timeline, "—-") {
		t.Fatalf("absolute or doubly shifted timestamp retained:\n%s", timeline)
	}
}

func TestShotVideoPromptKeepsNarratedDialogueWithinTimeSlice(t *testing.T) {
	for _, prefix := range []string{"青衣人保持视线朝向门口，轻声说", "抬起右手，轻声说"} {
		in := shotPromptFixture()
		in.WrittenPrompt = strings.Replace(in.WrittenPrompt, "07.00—10.00：右手握紧钥匙（参考图2），拇指按住钥匙齿。\n青衣人（压低声音）：“你终于来了。”", "07.00—10.00："+prefix+"：“你终于来了。”", 1)
		prompt := ShotVideoPrompt(in)
		timeline := shotPromptTimeline(t, prompt)
		if !strings.Contains(timeline, "微抬下巴") || !strings.Contains(timeline, "03.00—06.00："+prefix) || !strings.Contains(prompt, "本镜台词的说话人：青衣人") {
			t.Errorf("narrated dialogue unnecessarily discarded:\n%s", prompt)
		}
	}
}

func TestShotVideoPromptCameraRulesKeepFixedSingleShot(t *testing.T) {
	in := shotPromptFixture()
	in.Segment.Shots[1].Camera, in.Segment.CameraMotion = "固定", 10
	prompt := ShotVideoPrompt(in)
	if !strings.Contains(prompt, "本镜全程保持固定机位") || !strings.Contains(prompt, "不新增切镜") {
		t.Fatalf("single fixed camera constraint missing:\n%s", prompt)
	}
	for _, forbidden := range []string{"正反打", "切到特写", "不要连续多个", CameraMotionRule(10)} {
		if strings.Contains(prompt, forbidden) {
			t.Errorf("multi-shot direction %q in a single shot:\n%s", forbidden, prompt)
		}
	}
}

func TestShotVideoPromptFallbackRemapsRawShotReferenceTokens(t *testing.T) {
	in := shotPromptFixture()
	in.WrittenPrompt = "没有可靠镜头结构"
	in.Segment.Shots[1].Scene = "茶室（参考图4）"
	in.Segment.Shots[1].ImagePrompt = "青衣人（参考图3）站在窗边"
	in.Segment.Shots[1].Action = "青衣人握紧钥匙（参考图2）"
	in.Segment.Shots[1].VideoPrompt = "参考图999不可指向实际附件"
	prompt := ShotVideoPrompt(in)
	for _, want := range []string{"场景：茶室（参考图1）", "起幅：青衣人（参考图2）", "青衣人握紧钥匙（参考图3）", "未编号参考素材不可指向实际附件", "茶室（参考图1）：纸窗透入冷月光"} {
		if !strings.Contains(prompt, want) {
			t.Errorf("fallback reference remap missing %q:\n%s", want, prompt)
		}
	}
	if strings.Contains(prompt, "参考图999") || strings.Contains(prompt, "参考图4") {
		t.Fatalf("stale source reference retained:\n%s", prompt)
	}
}

func TestShotVideoPromptRejectsUnreliableWrittenBoundaries(t *testing.T) {
	base := shotPromptFixture()
	cases := map[string]string{
		"missing shot":             strings.Replace(base.WrittenPrompt, "【10.00—13.00秒｜镜头三：掀桌】", "掀桌", 1),
		"reordered ordinal":        strings.Replace(base.WrittenPrompt, "镜头三：掀桌", "镜头四：掀桌", 1),
		"duplicate block":          base.WrittenPrompt + "\n【04.00—10.00秒｜镜头二：重复】\n再次微抬下巴。",
		"changed boundary":         strings.Replace(base.WrittenPrompt, "【04.00—10.00秒", "【04.00—09.00秒", 1),
		"mixed local time":         strings.Replace(base.WrittenPrompt, "07.00—10.00：右手", "03.00—06.00：右手", 1),
		"gapped time slices":       strings.Replace(base.WrittenPrompt, "07.00—10.00：右手", "08.00—10.00：右手", 1),
		"foreign dialogue":         strings.Replace(base.WrittenPrompt, "青衣人（压低声音）", "红衣人：“别想逃！”\n青衣人（压低声音）", 1),
		"missing current dialogue": strings.Replace(base.WrittenPrompt, "你终于来了。", "", 1),
		"next shot directive":      strings.Replace(base.WrittenPrompt, "50mm近景", "下个镜头红衣人踢翻茶桌。\n50mm近景", 1),
		"foreign action":           strings.Replace(base.WrittenPrompt, "50mm近景", "红衣人踢翻茶桌。\n50mm近景", 1),
		"wrong dialogue speaker":   strings.Replace(base.WrittenPrompt, "青衣人（压低声音）", "红衣人（压低声音）", 1),
		"unsupported time range":   strings.Replace(base.WrittenPrompt, "04.00—07.00：", "04.00 至 07.00 秒：", 1),
		"ambiguous local point":    strings.Replace(base.WrittenPrompt, "50mm近景", "在1秒时手指抬起。\n50mm近景", 1),
		"point outside this shot":  strings.Replace(base.WrittenPrompt, "50mm近景", "12.00秒时发出钟声。\n50mm近景", 1),
	}
	for name, written := range cases {
		t.Run(name, func(t *testing.T) {
			in := base
			in.WrittenPrompt = written
			timeline := shotPromptTimeline(t, ShotVideoPrompt(in))
			if !strings.Contains(timeline, "青衣人缓缓抬眼") || strings.Contains(timeline, "微抬下巴") || strings.Contains(timeline, "红衣人踢翻茶桌") || strings.Contains(timeline, "别想逃！") {
				t.Fatalf("unsafe written block did not fall back cleanly:\n%s", timeline)
			}
		})
	}
}

func TestShotVideoPromptLastShotExcludesPostscriptAndSegmentTailFrame(t *testing.T) {
	in := shotPromptFixture()
	in.ShotIndex, in.ShotNumber, in.Seconds = 2, 9, 3
	for _, ending := range []string{"【总结】\n下一段打开密室，红衣人跳窗。", "总结：下一段打开密室。", "末0.5秒动作收住，作为第3段的接续基准。"} {
		in.WrittenPrompt = strings.Split(shotPromptFixture().WrittenPrompt, "【总结】")[0] + ending
		prompt := ShotVideoPrompt(in)
		timeline := shotPromptTimeline(t, prompt)
		if !strings.Contains(timeline, "00.00—03.00") || !strings.Contains(timeline, "红衣人踢翻茶桌") {
			t.Errorf("last shot missing:\n%s", timeline)
		}
		for _, forbidden := range []string{"打开密室", "跳窗", "接续基准", "末0.5秒", "你终于来了。", "把钥匙交出来！"} {
			if strings.Contains(prompt, forbidden) {
				t.Errorf("last shot retained %q:\n%s", forbidden, prompt)
			}
		}
	}
}

func TestShotVideoPromptContinuityIsSeparateFromExecutableContent(t *testing.T) {
	in := shotPromptFixture()
	in.Segment.Shots[0].Scene = "雨巷"
	in.Segment.Shots[2].Scene, in.Segment.Shots[2].ShotSize = "码头", "远景"
	prompt := ShotVideoPrompt(in)
	timeline := shotPromptTimeline(t, prompt)
	for _, want := range []string{"【段内衔接背景（不作为本镜动作）】", "此前已发生：红衣人撞开木门", "此前镜头的场景：雨巷", "不将此前场景的站位移入当前场景", "场景为码头，景别为远景"} {
		if !strings.Contains(prompt, want) {
			t.Errorf("continuity missing %q:\n%s", want, prompt)
		}
	}
	if strings.Contains(timeline, "红衣人撞开木门") || strings.Contains(prompt, "红衣人踢翻茶桌") || strings.Contains(prompt, "别想逃！") || strings.Contains(prompt, "把钥匙交出来！") {
		t.Fatalf("neighbor events became current content:\n%s", prompt)
	}
}

func TestShotVideoPromptReferenceRemappingUsesIdentityAndOnePass(t *testing.T) {
	ref := func(label, kind, name, id string) SegmentReference {
		return SegmentReference{Label: label, Kind: kind, Name: name, Identity: id}
	}
	tests := []struct {
		name           string
		source, actual []SegmentReference
		text, want     string
	}{
		{"reorder without cascade", []SegmentReference{ref("参考图1", "character", "甲", ""), ref("参考图2", "prop", "剑", "")}, []SegmentReference{ref("参考图2", "character", "甲", ""), ref("参考图1", "prop", "剑", "")}, "@参考图 1与参考图2", "参考图2与参考图1"},
		{"absent image becomes name", []SegmentReference{ref("参考图1", "character", "甲", "")}, []SegmentReference{ref("", "character", "甲", "")}, "参考图1", "甲"},
		{"unknown source cannot alias actual", nil, []SegmentReference{ref("参考图2", "character", "乙", "")}, "参考图2", "未编号参考素材"},
		{"same name other kind", []SegmentReference{ref("参考图1", "prop", "明月", "")}, []SegmentReference{ref("参考图1", "character", "明月", "")}, "参考图1", "明月"},
		{"ambiguous name", []SegmentReference{ref("参考图1", "character", "甲", "")}, []SegmentReference{ref("参考图1", "character", "甲", "cast:1"), ref("参考图2", "character", "甲", "cast:2")}, "参考图1", "甲"},
		{"ambiguous source name", []SegmentReference{ref("参考图1", "character", "甲", ""), ref("参考图2", "character", "甲", "")}, []SegmentReference{ref("参考图1", "character", "甲", "")}, "参考图2", "甲"},
		{"unattached same name still ambiguous", []SegmentReference{ref("参考图1", "character", "甲", "")}, []SegmentReference{ref("参考图1", "character", "甲", "cast:1"), ref("", "character", "甲", "cast:2")}, "参考图1", "甲"},
		{"identity disambiguates names", []SegmentReference{ref("参考图1", "character", "甲", "cast:2")}, []SegmentReference{ref("参考图1", "character", "甲", "cast:1"), ref("参考图2", "character", "甲", "cast:2")}, "参考图1", "参考图2"},
		{"different identity cannot use same name", []SegmentReference{ref("参考图1", "character", "甲", "cast:2")}, []SegmentReference{ref("参考图1", "character", "甲", "cast:1")}, "参考图1", "甲"},
		{"shared attached image", []SegmentReference{ref("参考图3", "character", "乙", "cast:2")}, []SegmentReference{ref("参考图1", "character", "甲", "cast:1"), ref("参考图1", "character", "乙", "cast:2")}, "参考图3", "参考图1"},
		{"shared source image stays shared", []SegmentReference{ref("参考图3", "character", "甲", "cast:1"), ref("参考图3", "character", "乙", "cast:2")}, []SegmentReference{ref("参考图1", "character", "甲", "cast:1"), ref("参考图1", "character", "乙", "cast:2")}, "参考图3", "参考图1"},
		{"shared source image split conservatively", []SegmentReference{ref("参考图3", "character", "甲", "cast:1"), ref("参考图3", "character", "乙", "cast:2")}, []SegmentReference{ref("参考图1", "character", "甲", "cast:1"), ref("参考图2", "character", "乙", "cast:2")}, "参考图3", "甲、乙"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := shotReferenceRewriter(tt.source, tt.actual)(tt.text); got != tt.want {
				t.Errorf("got %q, want %q", got, tt.want)
			}
		})
	}
}

func TestShotVideoPromptWithoutDialogueAndInvalidIndex(t *testing.T) {
	in := ShotVideoPromptInput{Segment: SegmentPromptInput{Shots: []SegmentShot{{Scene: "空房间", ImagePrompt: "烛火照着木桌", DurationMs: 2500}}}}
	prompt := ShotVideoPrompt(in)
	if !strings.Contains(prompt, "绝对无台词") || !strings.Contains(prompt, "【00.00—03.00秒") {
		t.Fatalf("default duration or no-dialogue contract missing:\n%s", prompt)
	}
	in.ShotIndex = -1
	if got := ShotVideoPrompt(in); got != "" {
		t.Fatalf("invalid shot index rendered another shot: %s", got)
	}
}
