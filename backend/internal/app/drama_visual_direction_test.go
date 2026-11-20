package app

import (
	"strings"
	"testing"
	"unicode/utf8"

	"yingce/backend/internal/model"
	"yingce/backend/internal/production"
)

func typedPromptSettings(settings DramaSettings, dramaType string) DramaSettings {
	settings.DramaType = dramaType
	settings.StyleName = "冻蓝色调"
	settings.StylePrompt = "利用结霜玻璃和黄铜反射组织画面"
	settings.StyleSelection = &DramaStyleSelection{Mode: "custom"}
	return settings
}

func assertDramaVisualPrompt(t *testing.T, prompt, family, style string) {
	t.Helper()
	if strings.Count(prompt, dramaVisualDirectionStart) != 1 || !strings.Contains(prompt, "剧集类型："+family) || !strings.Contains(prompt, dramaVisualMediumRule) || !strings.Contains(prompt, style) {
		t.Fatalf("缺少唯一的剧集类型或风格设置: %s", prompt)
	}
}

func TestDramaVisualDirectionWritingAndReferenceImages(t *testing.T) {
	settings := typedPromptSettings(DramaSettings{}, "comic")
	promptSettings := dramaPromptSettings(settings)
	assertDramaVisualPrompt(t, production.BiblePrompt("作品", promptSettings, nil, 0, nil), "漫剧", settings.StylePrompt)
	assertDramaVisualPrompt(t, production.ScriptPrompt(production.ScriptContext{Settings: promptSettings}), "漫剧", settings.StylePrompt)
	for _, kind := range []string{"character", "scene", "prop"} {
		cast := model.DramaCast{Kind: kind, Name: "测试", Appearance: "原稿"}
		assertDramaVisualPrompt(t, buildDramaCastImagePrompt(settings, dramaBibleMeta{}, cast), "漫剧", settings.StylePrompt)
	}
	staleStyle := dramaVisualDirection(settings, "旧画风", "旧风格说明")
	cast := model.DramaCast{Kind: "character", ImagePrompt: staleStyle + "\n原稿", ImageStyleName: "新画风", ImageStylePrompt: "复古手绘感"}
	next := buildDramaCastImagePrompt(settings, dramaBibleMeta{}, cast)
	assertDramaVisualPrompt(t, next, "漫剧", "复古手绘感")
	if !strings.Contains(next, "原稿") || strings.Contains(next, "旧风格说明") || strings.Contains(next, settings.StylePrompt) {
		t.Fatalf("独立画风替换影响已有正文或保留了错误画风: %s", next)
	}
	untypedPreset := typedPromptSettings(DramaSettings{}, "")
	untypedPreset.StyleSelection = &DramaStyleSelection{Mode: "preset", PresetID: "2d-manhua"}
	typedDirection := dramaVisualDirection(untypedPreset, "", "")
	assertDramaVisualPrompt(t, typedDirection, "漫剧", settings.StylePrompt)
	untypedCustom := typedPromptSettings(DramaSettings{}, "")
	untypedCustom.StylePrompt = "真人实拍"
	if prompt := production.ScriptPrompt(production.ScriptContext{Settings: dramaPromptSettings(untypedCustom)}); strings.Contains(prompt, "剧集类型：") || !strings.Contains(prompt, "真人实拍") {
		t.Fatalf("未设置剧集类型的旧作品仍可使用自定义风格: %s", prompt)
	}
	settings.StyleSelection = nil
	legacyCast := model.DramaCast{Kind: "scene", Name: "历史素材", ImagePrompt: "原有设定"}
	if strings.Contains(buildDramaCastImagePrompt(settings, dramaBibleMeta{}, legacyCast), dramaVisualDirectionStart) {
		t.Fatal("历史配置使用了新画风编排")
	}
}

func TestDramaVisualDirectionSegmentPreviewBudgetAndSubmission(t *testing.T) {
	s, fake, projectID, detail := dramaStudioFixture(t)
	p, _ := s.repo.DramaProduction(projectID)
	episode, _ := s.repo.DramaEpisode(projectID, detail.Episode.ID)
	project, _ := s.repo.ProjectForUser("usr-drama", projectID)
	settings := typedPromptSettings(dramaEpisodeSettings(parseDramaSettings(p.SettingsJSON), *episode), "comic")
	styleOpening := "真人实拍，" + settings.StylePrompt
	settings.StylePrompt = styleOpening + strings.Repeat("色", production.MaxStylePromptRunes-utf8.RuneCountInString(styleOpening)-1) + "尾"
	if err := fake.db.Model(episode).Update("settings_json", encodeDramaSettings(settings)).Error; err != nil {
		t.Fatal(err)
	}
	if err := fake.db.Model(p).Update("settings_json", encodeDramaSettings(settings)).Error; err != nil {
		t.Fatal(err)
	}
	segment, err := s.repo.DramaSegment(projectID, detail.Segments[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	const manual = "人物推门走进有落地窗的大厅。"
	if err := s.repo.UpdateDramaSegmentFields(segment.ID, map[string]any{"video_status": model.DramaMediaQueued, "video_prompt_override": manual}); err != nil {
		t.Fatal(err)
	}
	segment.VideoPromptOverride = manual
	view, err := s.DramaEpisodeDetail("usr-drama", projectID, episode.ID)
	if err != nil {
		t.Fatal(err)
	}
	header := view.Segments[0].Request.Header
	assertDramaVisualPrompt(t, header, "漫剧", styleOpening)
	if strings.Contains(header, manual) || strings.Contains(header, settings.StylePrompt) {
		t.Fatal("视频预览的画风前缀应缩短长篇画风并保留独立的手写正文")
	}
	shots, _ := s.repo.DramaShots(episode.ID)
	casts, _ := s.repo.DramaCasts(projectID)
	byID := make(map[string]model.DramaCast, len(casts))
	for _, cast := range casts {
		byID[cast.ID] = cast
	}
	draft := buildDramaSegmentDrafts(settings, dramaBibleMeta{}, shots, byID, nil)[0]
	writer := production.SegmentWriterPrompt(draft.input, production.SegmentVideoPrompt(draft.input), "", nil)
	if strings.Count(writer, settings.StylePrompt) != 1 {
		t.Fatalf("撰写任务画风应在素材稿中提供一次: %s", writer)
	}
	profile, err := s.dramaVideoProfile(settings.Models.Video)
	if err != nil {
		t.Fatal(err)
	}
	run := &dramaRun{s: s, project: project, production: p, settings: settings}
	budget, err := run.segmentPromptBudget(settings, profile, draft, segment, nil, byID)
	if err != nil || budget != profile.PromptMaxChars-utf8.RuneCountInString(header)-2 {
		t.Fatalf("段稿预算未扣除预览中的画风说明: %d %v", budget, err)
	}
	baseHeader := stripDramaVisualDirection(header)
	if baseHeader == "" {
		t.Fatal("测试段缺少参考素材说明")
	}
	nearLimit := *segment
	body := strings.Repeat("景", profile.PromptMaxChars-utf8.RuneCountInString(baseHeader)-4-20)
	nearLimit.VideoPromptOverride = dramaVisualDirection(settings, "旧风格", "旧规则") + "\n\n" + body
	request, _, _, err := s.prepareDramaSegment(settings, draft, nearLimit, nil, byID)
	if err != nil {
		t.Fatal(err)
	}
	compiled := request.Header + "\n\n" + dramaSegmentRequestPrompt(nearLimit, request)
	if !strings.Contains(request.Header, "漫剧") || !strings.Contains(request.Header, baseHeader) || strings.Contains(compiled, "旧风格") || !strings.HasSuffix(compiled, body) || utf8.RuneCountInString(compiled) > profile.PromptMaxChars {
		t.Fatal("接近上限时应保留段稿、参考说明和剧集类型，并在上限内替换旧画风")
	}
	task, skip, err := run.submitSegmentVideo(&model.DramaJob{ShotID: segment.ID, EpisodeID: episode.ID})
	if err != nil || skip || task == nil {
		t.Fatalf("段视频提交失败: %v %v", skip, err)
	}
	requests := dramaVideoRequests(fake)
	prompt := requests[len(requests)-1].Prompt
	assertDramaVisualPrompt(t, prompt, "漫剧", styleOpening)
	if prompt != header+"\n\n"+manual || utf8.RuneCountInString(prompt) > profile.PromptMaxChars {
		t.Fatalf("实际段视频请求与预览内容不一致或超长: %s", prompt)
	}
}

func TestDramaVisualDirectionManualShotRequest(t *testing.T) {
	s, db, saved := shotPromptFixture(t)
	episode, _ := s.repo.DramaEpisode("drama-project", "episode")
	p, _ := s.repo.DramaProduction("drama-project")
	settings := typedPromptSettings(dramaEpisodeSettings(parseDramaSettings(p.SettingsJSON), *episode), "live_action")
	if err := db.Model(p).Update("settings_json", encodeDramaSettings(settings)).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(episode).Update("settings_json", encodeDramaSettings(settings)).Error; err != nil {
		t.Fatal(err)
	}
	config := saved.Config
	config.Prompt = "手写动作与台词保持原样。"
	config.Operation, config.FirstFrameResourceID, config.LastFrameResourceID = "text_to_video", "", ""
	config.ReferenceResourceIDs = nil
	updated, err := s.SaveDramaShotMedia("user", "drama-project", "real-shot", "video", DramaShotMediaSaveRequest{ExpectedRevision: &saved.Revision, Config: config})
	if err != nil {
		t.Fatal(err)
	}
	plan, err := s.prepareDramaShotMedia(s.repo, "user", "drama-project", "real-shot", "video", DramaShotMediaActionRequest{ExpectedRevision: &updated.Revision})
	if err != nil || !plan.view.Ready {
		t.Fatalf("单镜视频预检失败: %+v %v", plan.view, err)
	}
	assertDramaVisualPrompt(t, plan.request.Prompt, "真人剧", settings.StylePrompt)
	if !strings.Contains(plan.request.Prompt, config.Prompt) || plan.view.Config.Prompt != config.Prompt || mustShotMedia(t, s).Config.Prompt != config.Prompt {
		t.Fatal("剧集画风改变了单镜手写稿")
	}
	profile, err := s.dramaVideoProfile(config.Model)
	if err != nil {
		t.Fatal(err)
	}
	baseChars := utf8.RuneCountInString(stripDramaVisualDirection(plan.request.Prompt)) - utf8.RuneCountInString(config.Prompt)
	for _, freeChars := range []int{20, 0} {
		body := strings.Repeat("景", profile.PromptMaxChars-baseChars-freeChars)
		config.Prompt = dramaVisualDirection(settings, "旧风格", "旧规则") + "\n\n" + body
		updated, err = s.SaveDramaShotMedia("user", "drama-project", "real-shot", "video", DramaShotMediaSaveRequest{ExpectedRevision: &updated.Revision, Config: config})
		if err != nil {
			t.Fatal(err)
		}
		plan, err = s.prepareDramaShotMedia(s.repo, "user", "drama-project", "real-shot", "video", DramaShotMediaActionRequest{ExpectedRevision: &updated.Revision})
		if err != nil || !plan.view.Ready {
			t.Fatalf("剩余 %d 字时单镜视频预检失败: %s %v", freeChars, plan.view.Reason, err)
		}
		prompt := plan.request.Prompt
		if utf8.RuneCountInString(prompt) > profile.PromptMaxChars || !strings.Contains(prompt, body) || strings.Contains(prompt, "旧风格") || strings.Contains(prompt, "真人剧") != (freeChars > 0) {
			t.Fatalf("剩余 %d 字时未正确替换单镜视频画风：请求 %d/%d 字，正文完整 %t，含旧画风 %t，含剧集类型 %t", freeChars, utf8.RuneCountInString(prompt), profile.PromptMaxChars, strings.Contains(prompt, body), strings.Contains(prompt, "旧风格"), strings.Contains(prompt, "真人剧"))
		}
	}
}

func TestDramaVisualDirectionSuppressesOnlyIncompatibleSavedRules(t *testing.T) {
	settings := typedPromptSettings(DramaSettings{}, "live_action")
	meta := dramaBibleMeta{StyleHash: dramaStyleHash(settings), VisualRules: "夜间冷光"}
	episode := model.DramaEpisode{SettingsJSON: encodeDramaSettings(settings)}
	if currentDramaVisualRules(settings, meta) != meta.VisualRules {
		t.Fatal("风格相同应保留画面规则")
	}
	settings.StylePrompt = "清晨暖光"
	if currentDramaVisualRules(settings, meta) != "" {
		t.Fatal("变更风格后沿用了旧画面规则")
	}
	if _, episodeMeta := dramaEpisodeStyleSettings(settings, meta, episode); episodeMeta.VisualRules != meta.VisualRules {
		t.Fatal("本集仍使用已提取的画风时，应保留对应的画面规则")
	}
	settings.StyleSelection = nil
	if currentDramaVisualRules(settings, meta) != meta.VisualRules {
		t.Fatal("历史画风应保留画面规则")
	}
}

func TestDramaVisualDirectionKeepsLongRebuiltReferencePromptEditable(t *testing.T) {
	settings := typedPromptSettings(DramaSettings{}, "comic")
	settings.StylePrompt = strings.Repeat("色", production.MaxStylePromptRunes)
	cast := model.DramaCast{Kind: "character", Name: "测试", Appearance: strings.Repeat("蓝色衣服", 750)}
	rebuilt := buildDramaCastImagePrompt(settings, dramaBibleMeta{}, cast)
	if utf8.RuneCountInString(rebuilt) <= 12000 {
		t.Fatal("预览应长于草稿限额")
	}
	if _, err := applyDramaCastImageFields(&cast, &rebuilt, nil, nil, nil); err != nil {
		t.Fatalf("重新编排结果无法作为草稿保存: %v", err)
	}
	if cast.ImagePrompt != stripDramaVisualDirection(rebuilt) {
		t.Fatal("应保留完整素材正文")
	}
	assertDramaVisualPrompt(t, buildDramaCastImagePrompt(settings, dramaBibleMeta{}, cast), "漫剧", settings.StylePrompt)
}
