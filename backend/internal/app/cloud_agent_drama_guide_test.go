package app

import (
	"encoding/json"
	"fmt"
	"slices"
	"strings"
	"testing"

	agenttool "yingce/backend/internal/agent/tool"
	"yingce/backend/internal/model"
)

func TestCloudAgentDramaGuideScopeContract(t *testing.T) {
	request := agentTestRequest()
	request.CanvasID = ""
	request.DramaProjectID = "drama-project"
	request.ContextScope = []string{"drama"}
	if err := validateCloudAgentRequest(&request); err != nil {
		t.Fatal(err)
	}
	request.DramaLinked = true
	tools := compileCloudAgentTools(request, true)
	if len(tools) != 4 {
		t.Fatalf("guide must expose only its four tools: %+v", tools)
	}
	for _, name := range []string{agenttool.DramaGetContext, agenttool.DramaProposeChanges, agenttool.AskUser, agenttool.PlanUpdate} {
		if _, ok := cloudAgentRegistry().Lookup(name); !ok || !agenttool.Of(name).Allowed(cloudAgentToolScope(request, true)) {
			t.Fatalf("guide tool unavailable: %s", name)
		}
	}
	for _, mutate := range []func(*CloudAgentRequest){
		func(r *CloudAgentRequest) { r.CanvasID = "canvas" },
		func(r *CloudAgentRequest) { r.ContextScope = []string{"canvas"} },
		func(r *CloudAgentRequest) { r.PermissionMode = "auto" },
		func(r *CloudAgentRequest) { r.FocusNodeIDs = []string{"node"} },
	} {
		invalid := request
		mutate(&invalid)
		if err := validateCloudAgentRequest(&invalid); err == nil {
			t.Fatal("mixed guide scope accepted")
		}
	}
	other := request
	other.DramaProjectID = "another-project"
	if cloudAgentFingerprint(request, "") == cloudAgentFingerprint(other, "") || cloudAgentPromptCacheIdentity(request, cloudAgentPolicySnapshot{}) == cloudAgentPromptCacheIdentity(other, cloudAgentPolicySnapshot{}) {
		t.Fatal("project binding must participate in immutable request identity")
	}
}

func TestCloudAgentDramaGuideUsesChatConfirmation(t *testing.T) {
	request := agentTestRequest()
	request.CanvasID = ""
	request.DramaProjectID = "drama-project"
	request.ContextScope = []string{"drama"}
	text, _, err := compileCloudAgentPolicies(request, defaultCanvasAppearance().AgentName, nil, "", cloudAgentProfileSnapshot{})
	if err != nil {
		t.Fatal(err)
	}
	for _, instruction := range []string{
		"由用户在对话中选择应用",
		"多个备选方案分别提交建议",
		"配置阶段先确认视觉风格",
		"给出 2–4 个可直接点选的具体风格",
		"setup 的 changes 仅含 styleName/stylePrompt",
		"风格确认后，将画幅、视频清晰度、对白语言和单集时长一次性汇总为一套推荐配置",
		"只调用一次 drama_propose_changes",
		"changes 同时包含 aspectRatio/videoResolution/language/episodeSeconds",
		"“采用推荐配置”和“在推荐配置基础上修改”两个选项",
		"修改选项允许用户填写改动要求，不为它创建第二个相同建议",
		"保留已确认的风格及用户明确的其他要求，不再逐项询问",
		"用户已经明确或已选择保存的项目不重复询问",
		"提供选项后本轮收尾，等待用户选择",
		"候选名称与每项说明通过回复内的直接选项展示",
		"写入对应建议的顶层 explanation，不混入 changes",
		"配置聊天正文只简短引导，具体推荐值和理由只通过结构化建议展示一次，不再给出重复摘要",
		"不把具体配置值再编号列为一组选项",
		"非视频配置能精确映射时仅提供该项",
		"修改推荐视频配置时，保留原推荐中未修改的值",
		"仍以一个 setup 建议完整提交 aspectRatio/videoResolution/language/episodeSeconds 四个字段",
		"不能只提交用户改动的单个字段",
		"除非用户明确要求修改风格，否则保持已确认风格不动",
		"不提示去下方卡片寻找、点击或另点应用",
		"阶段确认在回复末尾仅列“1. 确认…”和“2. 继续调整”",
		"由界面直接将这组文字呈现为可点击选项",
		"不另加标题、说明或独立选择卡片重复它们",
		"点击选项即通过既有业务接口保存",
		"每组选项都提供空白的自定义输入",
		"不把自然语言回答当作已保存",
		"ask_user 仅用于澄清尚不能形成具体修改的创作意图",
		"收到客户端的已保存反馈后，先用 drama_get_context 重新读取最新上下文与 guide.baseRevision",
		"对话中的明确阶段确认按钮触发现有制作流程",
		"按钮呈现为 Agent 回复内的直接选项",
		"选择建议本身不推进阶段",
		"不因选择方案自动生成图片或视频",
	} {
		if !strings.Contains(text, instruction) {
			t.Fatalf("missing guide interaction contract: %s", instruction)
		}
	}
	for _, obsolete := range []string{"由页面按钮启动", "配置阶段每轮只讨论一个决策", "不要一次提交整套配置", "按风格、画幅与清晰度、语言、单集时长逐项引导"} {
		if strings.Contains(text, obsolete) {
			t.Fatalf("guide retains obsolete confirmation flow: %s", obsolete)
		}
	}
	var description string
	for _, tool := range compileCloudAgentTools(request, true) {
		function := tool["function"].(map[string]any)
		if function["name"] == agenttool.DramaProposeChanges {
			description = function["description"].(string)
			parameters := function["parameters"].(map[string]any)
			properties := parameters["properties"].(map[string]any)
			explanation := properties["explanation"].(map[string]any)
			if explanation["type"] != "string" || explanation["maxLength"] != float64(1000) {
				t.Fatalf("option explanation must be bounded display metadata: %+v", explanation)
			}
			for _, required := range parameters["required"].([]any) {
				if required == "explanation" {
					t.Fatal("legacy proposals must not require explanation")
				}
			}
		}
	}
	for _, instruction := range []string{
		"用户在对话中选择应用", "多个备选分别调用本工具", "不保存、不推进阶段、不生成图片或视频",
		"用户点选即保存，无需再次应用", "每组保留空白自定义输入",
		"短剧配置先给 2–4 个风格选项", "setup 的 changes 仅含 styleName/stylePrompt",
		"一次调用本工具给出整套推荐配置", "changes 同时包含 aspectRatio/videoResolution/language/episodeSeconds",
		"“采用推荐配置”和“在推荐配置基础上修改”两个选项", "后者接收用户的改动要求，不生成第二个相同建议",
		"用户修改推荐视频配置后，保留原推荐中未修改的值", "仍完整提交 aspectRatio/videoResolution/language/episodeSeconds 四个字段",
		"不能只提交改动的单个字段", "除非用户明确要求，否则不修改已确认风格",
		"正文只简短引导，具体推荐值和理由只通过结构化建议展示一次，不再给出重复摘要",
		"每项推荐理由或适用情境放顶层 explanation，不放入 changes", "不重复候选列表，不提示去下方卡片或另点应用",
		"回复末尾只列“1. 确认…”和“2. 继续调整”", "不再重复展示独立卡片",
	} {
		if !strings.Contains(description, instruction) {
			t.Fatalf("proposal tool lost confirmation boundary: %s", instruction)
		}
	}
	for _, obsolete := range []string{"短剧配置每轮仅一个决策", "不要一次提交整套配置", "继续下一项"} {
		if strings.Contains(description, obsolete) {
			t.Fatalf("proposal tool retains obsolete setup sequence: %s", obsolete)
		}
	}
	canvasPolicy, _, err := compileCloudAgentPolicies(agentTestRequest(), defaultCanvasAppearance().AgentName, nil, "", cloudAgentProfileSnapshot{})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(canvasPolicy, "由用户在对话中选择应用") {
		t.Fatal("short-drama confirmation policy leaked into ordinary canvas sessions")
	}
	if strings.Contains(canvasPolicy, "候选名称与每项说明通过回复内的直接选项展示") {
		t.Fatal("guide-only presentation policy leaked into ordinary canvas sessions")
	}
}

func TestCloudAgentDramaGuideChoicesKeepCustomInputWithoutChangingCanvasQuestions(t *testing.T) {
	request := agentTestRequest()
	request.CanvasID = ""
	request.DramaProjectID = "drama-project"
	request.ContextScope = []string{"drama"}
	for _, test := range []struct {
		name    string
		request CloudAgentRequest
		guided  bool
	}{{"short drama", request, true}, {"canvas", agentTestRequest(), false}} {
		t.Run(test.name, func(t *testing.T) {
			var question map[string]any
			for _, tool := range compileCloudAgentTools(test.request, true) {
				function := tool["function"].(map[string]any)
				if function["name"] == agenttool.AskUser {
					question = function
					break
				}
			}
			if question == nil {
				t.Fatal("missing clarification tool")
			}
			params := question["parameters"].(map[string]any)
			properties := params["properties"].(map[string]any)
			freeform := properties["allowFreeform"].(map[string]any)
			description := question["description"].(string)
			if test.guided {
				allowed, ok := freeform["enum"].([]any)
				if !ok || len(allowed) != 1 || allowed[0] != true {
					t.Fatalf("short-drama questions must permit custom answers: %+v", freeform)
				}
				for _, required := range []string{"已能保存的风格等决策用 drama_propose_changes", "必须保留空白自定义输入", "不要询问用户是否看到了卡片、是否点选或要求重新提交", "具体候选与说明只放工具参数，正文只简短引导，不重复候选列表或提示去下方卡片"} {
					if !strings.Contains(description, required) {
						t.Fatalf("missing direct-choice question boundary: %s", required)
					}
				}
			} else if _, changed := freeform["enum"]; changed || strings.Contains(description, "短剧引导") {
				t.Fatalf("short-drama choice policy changed ordinary canvas questions: %+v", question)
			}
		})
	}
}

func TestCloudAgentDramaGuideContextWithoutEpisodes(t *testing.T) {
	svc, _ := newDramaTestService(t)
	draft := createGuidedDrama(t, svc)
	state := &cloudAgentRuntime{Request: CloudAgentRequest{DramaProjectID: draft.Project.ID}}
	for _, arguments := range []string{`{}`, `{"chapterId":"","episodeId":"","episodeNumber":0}`} {
		call := cloudAgentCall{ID: "overview"}
		call.Function.Arguments = arguments
		value, err := cloudAgentHandleDramaGetContext(svc.repo, "usr-drama", state, call, svc)
		if err != nil {
			t.Fatalf("overview without episodes rejected: %v", err)
		}
		context := value.(map[string]any)
		if len(context["episodes"].([]map[string]any)) != 0 || context["guide"].(map[string]any)["baseRevision"] != draft.Production.Revision {
			t.Fatalf("overview must return the real empty directory and revision: %+v", context)
		}
	}
	call := cloudAgentCall{ID: "missing-episode"}
	call.Function.Arguments = `{"episodeNumber":1}`
	_, err := cloudAgentHandleDramaGetContext(svc.repo, "usr-drama", state, call, svc)
	if _, ok := err.(*cloudAgentArgumentError); !ok || !strings.Contains(err.Error(), "{}") {
		t.Fatalf("missing episode must remain invalid with actionable overview feedback: %v", err)
	}
}

func TestCloudAgentDramaAssetProposalsRequireConfirmationAndCurrentScope(t *testing.T) {
	svc, fake := newDramaTestService(t)
	draft := createGuidedDrama(t, svc)
	other, err := svc.CreateDrama("usr-drama", CreateDramaRequest{Name: "另一部引导作品", Guided: true, Brief: "另一部故事", Settings: draft.Production.Settings})
	if err != nil {
		t.Fatal(err)
	}
	projectID := draft.Project.ID
	if err := fake.db.Model(&model.DramaProduction{}).Where("project_id = ?", projectID).Updates(map[string]any{"guide_step": model.DramaGuideAssets, "stage": model.DramaStageProduce}).Error; err != nil {
		t.Fatal(err)
	}
	if err := svc.repo.CreateDramaCasts([]model.DramaCast{
		{ID: "asset-own", ProjectID: projectID, Kind: "prop", Name: "旧道具"},
		{ID: "asset-foreign", ProjectID: other.Project.ID, Kind: "prop", Name: "别的作品道具"},
	}); err != nil {
		t.Fatal(err)
	}
	state := &cloudAgentRuntime{Request: CloudAgentRequest{DramaProjectID: projectID}}
	propose := func(userID, kind, target string, revision int64, changes map[string]any) error {
		arguments, _ := json.Marshal(cloudAgentDramaProposal{Kind: kind, TargetID: target, BaseRevision: revision, Changes: changes})
		call := cloudAgentCall{ID: "asset-proposal"}
		call.Function.Arguments = string(arguments)
		_, err := cloudAgentHandleDramaProposeChanges(svc.repo, userID, state, call, svc)
		return err
	}
	for _, kind := range []string{"character", "scene", "prop"} {
		if err := propose("usr-drama", "cast_create", "", draft.Production.Revision, map[string]any{"kind": kind, "name": "新设定", "description": "待确认的文字"}); err != nil {
			t.Fatalf("valid %s proposal rejected: %v", kind, err)
		}
	}
	if err := propose("usr-drama", "cast_delete", "asset-own", draft.Production.Revision, map[string]any{"reason": "与故事无关"}); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, kind, target string
		changes            map[string]any
	}{
		{"missing_kind", "cast_create", "", map[string]any{"name": "道具"}},
		{"unknown_kind", "cast_create", "", map[string]any{"kind": "video", "name": "视频"}},
		{"empty_name", "cast_create", "", map[string]any{"kind": "prop", "name": " "}},
		{"create_target", "cast_create", "asset-own", map[string]any{"kind": "prop", "name": "道具"}},
		{"media_write", "cast_create", "", map[string]any{"kind": "prop", "name": "道具", "imageResourceId": "image"}},
		{"foreign_target", "cast_delete", "asset-foreign", map[string]any{"reason": "删除"}},
		{"missing_target", "cast_delete", "", map[string]any{"reason": "删除"}},
		{"empty_reason", "cast_delete", "asset-own", map[string]any{"reason": " "}},
		{"delete_extra_field", "cast_delete", "asset-own", map[string]any{"reason": "删除", "cascade": true}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := propose("usr-drama", tc.kind, tc.target, draft.Production.Revision, tc.changes); err == nil {
				t.Fatal("invalid asset proposal accepted")
			}
		})
	}
	if err := propose("usr-drama", "cast_delete", "asset-own", draft.Production.Revision+1, map[string]any{"reason": "删除"}); err == nil {
		t.Fatal("stale version accepted")
	}
	if err := propose("foreign-user", "cast_delete", "asset-own", draft.Production.Revision, map[string]any{"reason": "删除"}); err == nil {
		t.Fatal("foreign user accepted")
	}
	for _, step := range []string{model.DramaGuideConfiguring, model.DramaGuideCompleted, ""} {
		if err := fake.db.Model(&model.DramaProduction{}).Where("project_id = ?", projectID).Update("guide_step", step).Error; err != nil {
			t.Fatal(err)
		}
		if err := propose("usr-drama", "cast_create", "", draft.Production.Revision, map[string]any{"kind": "prop", "name": "新道具"}); err == nil {
			t.Fatalf("asset proposal accepted in %q", step)
		}
	}
	casts, err := svc.repo.DramaCasts(projectID)
	if err != nil || len(casts) != 1 || casts[0].ID != "asset-own" {
		t.Fatalf("proposals mutated saved assets: %+v, %v", casts, err)
	}
	_, after, err := svc.dramaForUser("usr-drama", projectID)
	if err != nil || after.Revision != draft.Production.Revision || len(fake.requests) != 0 {
		t.Fatalf("proposals changed production or submitted generation: %v", err)
	}
}

func TestCloudAgentDramaGuideReadsAndProposesWithoutWriting(t *testing.T) {
	svc, fake := newDramaTestService(t)
	projectID := createGuidedDrama(t, svc).Project.ID
	_, before, err := svc.dramaForUser("usr-drama", projectID)
	if err != nil {
		t.Fatal(err)
	}
	state := &cloudAgentRuntime{Request: CloudAgentRequest{DramaProjectID: projectID}}
	call := cloudAgentCall{ID: "read"}
	call.Function.Name = agenttool.DramaGetContext
	call.Function.Arguments = `{}`
	value, err := cloudAgentReadToolCached(svc.repo, "usr-drama", state, call, svc)
	if err != nil {
		t.Fatal(err)
	}
	context := value.(map[string]any)
	if context["guide"].(map[string]any)["baseRevision"] != before.Revision || context["drama"].(map[string]any)["id"] != projectID {
		t.Fatalf("missing bound project/revision: %+v", context)
	}
	call.Function.Arguments = fmt.Sprintf(`{"kind":"setup","baseRevision":%d,"changes":{"language":"中文"}}`, before.Revision)
	proposal, err := cloudAgentHandleDramaProposeChanges(svc.repo, "usr-drama", state, call, svc)
	if err != nil {
		t.Fatal(err)
	}
	if proposal.(cloudAgentDramaProposal).Changes["language"] != "中文" {
		t.Fatal("proposal lost changes")
	}
	_, after, err := svc.dramaForUser("usr-drama", projectID)
	if err != nil || after.Revision != before.Revision || after.SettingsJSON != before.SettingsJSON {
		t.Fatalf("proposal wrote production: %v", err)
	}
	for _, arguments := range []string{
		fmt.Sprintf(`{"kind":"setup","baseRevision":%d,"changes":{"guideStep":"completed"}}`, before.Revision),
		fmt.Sprintf(`{"kind":"cast","targetId":"foreign-cast","baseRevision":%d,"changes":{"name":"越权"}}`, before.Revision),
		fmt.Sprintf(`{"kind":"setup","baseRevision":%d,"changes":{"language":"English"}}`, before.Revision+1),
	} {
		call.Function.Arguments = arguments
		if _, err := cloudAgentHandleDramaProposeChanges(svc.repo, "usr-drama", state, call, svc); err == nil {
			t.Fatalf("invalid proposal accepted: %s", arguments)
		}
	}
	call.Function.Arguments = `{}`
	if _, err := cloudAgentHandleDramaGetContext(svc.repo, "another-user", state, call, svc); err == nil {
		t.Fatal("foreign project read accepted")
	}
	if err := fake.db.Model(&model.DramaProduction{}).Where("project_id = ?", projectID).Update("revision", before.Revision+1).Error; err != nil {
		t.Fatal(err)
	}
	fresh, err := cloudAgentReadToolCached(svc.repo, "usr-drama", state, call, svc)
	if err != nil {
		t.Fatal(err)
	}
	if fresh.(map[string]any)["guide"].(map[string]any)["baseRevision"] != before.Revision+1 {
		t.Fatal("same-run context read reused a stale production revision")
	}
}

func TestCloudAgentDramaGuideProposalExplanationStaysDisplayOnly(t *testing.T) {
	svc, _ := newDramaTestService(t)
	draft := createGuidedDrama(t, svc)
	_, before, err := svc.dramaForUser("usr-drama", draft.Project.ID)
	if err != nil {
		t.Fatal(err)
	}
	state := &cloudAgentRuntime{Request: CloudAgentRequest{DramaProjectID: draft.Project.ID}}
	for _, tc := range []struct {
		name        string
		explanation string
		invalid     bool
	}{
		{"legacy without explanation", "", false},
		{"blank omitted", " \n\t ", false},
		{"trimmed explanation", "  适合国内观众，便于理解对白。 \n", false},
		{"unicode limit", strings.Repeat("字", 1000), false},
		{"over unicode limit", strings.Repeat("字", 1001), true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			args := cloudAgentDramaProposal{Kind: "setup", BaseRevision: before.Revision, Changes: map[string]any{"language": "中文"}, Explanation: tc.explanation}
			encoded, err := json.Marshal(args)
			if err != nil {
				t.Fatal(err)
			}
			call := cloudAgentCall{ID: "language-option"}
			call.Function.Arguments = string(encoded)
			result, err := cloudAgentHandleDramaProposeChanges(svc.repo, "usr-drama", state, call, svc)
			if tc.invalid {
				if _, ok := err.(*cloudAgentArgumentError); !ok {
					t.Fatalf("unbounded explanation accepted: %v", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			proposal := result.(cloudAgentDramaProposal)
			if proposal.Explanation != strings.TrimSpace(tc.explanation) || len(proposal.Changes) != 1 || proposal.Changes["language"] != "中文" {
				t.Fatalf("explanation changed the save payload: %+v", proposal)
			}
			encoded, err = json.Marshal(proposal)
			if err != nil {
				t.Fatal(err)
			}
			var event map[string]any
			if err := json.Unmarshal(encoded, &event); err != nil {
				t.Fatal(err)
			}
			if _, included := event["explanation"]; included != (proposal.Explanation != "") {
				t.Fatalf("empty explanation must preserve legacy event shape: %s", encoded)
			}
		})
	}
	call := cloudAgentCall{ID: "invalid-language-option"}
	call.Function.Arguments = fmt.Sprintf(`{"kind":"setup","baseRevision":%d,"changes":{"language":"中文","explanation":"不允许写入设置"}}`, before.Revision)
	if _, err := cloudAgentHandleDramaProposeChanges(svc.repo, "usr-drama", state, call, svc); err == nil {
		t.Fatal("explanation accepted inside business changes")
	}
	_, after, err := svc.dramaForUser("usr-drama", draft.Project.ID)
	if err != nil || after.Revision != before.Revision || after.SettingsJSON != before.SettingsJSON {
		t.Fatalf("display metadata wrote production: %v", err)
	}
}

func TestCloudAgentDramaGuideSetupUsesVideoModelContract(t *testing.T) {
	svc, fake := newDramaTestService(t)
	video := dramaVideoFixture()
	video.Resolutions, video.DefaultResolution = []string{"480p", "720p", "1080p"}, "720p"
	setDramaVideoCapability(t, svc, fake, video)
	draft := createGuidedDrama(t, svc)
	projectID := draft.Project.ID
	before, err := svc.repo.DramaProduction(projectID)
	if err != nil {
		t.Fatal(err)
	}
	state := &cloudAgentRuntime{Request: CloudAgentRequest{DramaProjectID: projectID}}
	read := cloudAgentCall{ID: "read-model-contract"}
	read.Function.Arguments = `{}`
	context, err := cloudAgentHandleDramaGetContext(svc.repo, "usr-drama", state, read, svc)
	if err != nil {
		t.Fatal(err)
	}
	contract := context.(map[string]any)["guide"].(map[string]any)["videoModel"].(cloudAgentDramaVideoModel)
	if !slices.Equal(contract.VideoRatios, []string{"9:16", "16:9"}) || !slices.Equal(contract.VideoResolutions, video.Resolutions) || contract.DefaultVideoResolution != "720p" || contract.Issue != "" {
		t.Fatalf("context must expose the selected model contract: %+v", contract)
	}
	propose := func(changes map[string]any) (any, error) {
		arguments, _ := json.Marshal(cloudAgentDramaProposal{Kind: "setup", BaseRevision: before.Revision, Changes: changes})
		call := cloudAgentCall{ID: "setup-contract"}
		call.Function.Arguments = string(arguments)
		return cloudAgentHandleDramaProposeChanges(svc.repo, "usr-drama", state, call, svc)
	}
	result, err := propose(map[string]any{"aspectRatio": "9:16", "videoResolution": "1080x1920"})
	if _, ok := err.(*cloudAgentArgumentError); !ok || result != nil {
		t.Fatalf("invalid resolution must fail before a proposal can be emitted: %+v %v", result, err)
	}
	for _, correction := range []string{"480p", "720p", "1080p", "guide.videoModel.videoResolutions", "空字符串", "aspectRatio"} {
		if !strings.Contains(err.Error(), correction) {
			t.Fatalf("missing actionable correction %q: %v", correction, err)
		}
	}
	for _, resolution := range []string{"1080p", "", " auto "} {
		result, err := propose(map[string]any{"aspectRatio": "9:16", "videoResolution": resolution, "language": "中文普通话", "episodeSeconds": 90.0})
		if err != nil {
			t.Fatalf("valid resolution %q rejected: %v", resolution, err)
		}
		want := resolution
		if isAutomaticVideoResolution(resolution) {
			want = ""
		}
		proposal := result.(cloudAgentDramaProposal)
		if proposal.Changes["aspectRatio"] != "9:16" || proposal.Changes["videoResolution"] != want || proposal.Changes["language"] != "中文普通话" || proposal.Changes["episodeSeconds"] != float64(90) || len(proposal.Changes) != 4 {
			t.Fatalf("batch recommendation must show all four settings without changing the confirmed style: %+v", proposal)
		}
	}
	for _, changes := range []map[string]any{
		{"episodeSeconds": 90.5},
		{"aspectRatio": "3:4", "videoResolution": "1080p"},
		{"aspectRatio": "1080x1920"},
	} {
		if result, err := propose(changes); err == nil || result != nil {
			t.Fatalf("invalid setup returned a proposal: %+v %v", result, err)
		}
	}
	for _, step := range []string{model.DramaGuideAssets, model.DramaGuideStory, model.DramaGuideCompleted, ""} {
		if err := fake.db.Model(&model.DramaProduction{}).Where("project_id = ?", projectID).Update("guide_step", step).Error; err != nil {
			t.Fatal(err)
		}
		if result, err := propose(map[string]any{"language": "English"}); err == nil || result != nil {
			t.Fatalf("setup proposal accepted after configuration in %q", step)
		}
	}
	after, err := svc.repo.DramaProduction(projectID)
	if err != nil || after.Revision != before.Revision || after.SettingsJSON != before.SettingsJSON || len(fake.requests) != 0 {
		t.Fatalf("validation must not save settings or dispatch generation: %+v %v", after, err)
	}
	for _, entity := range []any{&model.DramaJob{}, &model.Task{}} {
		var count int64
		if err := fake.db.Model(entity).Where("project_id = ?", projectID).Count(&count).Error; err != nil || count != 0 {
			t.Fatalf("proposal created work: %T count=%d err=%v", entity, count, err)
		}
	}
}

func TestCloudAgentDramaGuideKeepsDeclaredPixelAndFixedScreenResolutions(t *testing.T) {
	for _, fixed := range []bool{false, true} {
		t.Run(fmt.Sprintf("fixedScreen=%t", fixed), func(t *testing.T) {
			svc, fake := newDramaTestService(t)
			video := dramaVideoFixture()
			video.Resolutions, video.DefaultResolution = []string{"1080x1920", "1920x1080"}, "1080x1920"
			wantResolutions, wantDefault := video.Resolutions, video.DefaultResolution
			validRequests := []string{"1080x1920", ""}
			if fixed {
				video.Ratios, video.DefaultRatio = []string{}, ""
				video.Resolutions, video.DefaultResolution = []string{"768p竖(768*1376)", "768p横(1376*768)"}, "768p横(1376*768)"
				video.FixedScreenSpec = &VideoScreenSpecConfig{Resolutions: video.Resolutions, DefaultResolution: video.DefaultResolution}
				wantResolutions, wantDefault = []string{"768p"}, "768p"
				validRequests = []string{"768p", "768p竖(768*1376)", ""}
			}
			setDramaVideoCapability(t, svc, fake, video)
			draft := createGuidedDrama(t, svc)
			state := &cloudAgentRuntime{Request: CloudAgentRequest{DramaProjectID: draft.Project.ID}}
			call := cloudAgentCall{ID: "model-contract"}
			call.Function.Arguments = `{}`
			result, err := cloudAgentHandleDramaGetContext(svc.repo, "usr-drama", state, call, svc)
			if err != nil {
				t.Fatal(err)
			}
			contract := result.(map[string]any)["guide"].(map[string]any)["videoModel"].(cloudAgentDramaVideoModel)
			if contract.Issue != "" || !slices.Equal(contract.VideoResolutions, wantResolutions) || contract.DefaultVideoResolution != wantDefault || !slices.Contains(contract.VideoRatios, "9:16") {
				t.Fatalf("declared values were guessed or discarded: %+v", contract)
			}
			for _, resolution := range validRequests {
				arguments, _ := json.Marshal(cloudAgentDramaProposal{Kind: "setup", BaseRevision: draft.Production.Revision, Changes: map[string]any{"aspectRatio": "9:16", "videoResolution": resolution}})
				call.Function.Arguments = string(arguments)
				result, err := cloudAgentHandleDramaProposeChanges(svc.repo, "usr-drama", state, call, svc)
				if err != nil || result.(cloudAgentDramaProposal).Changes["videoResolution"] != resolution {
					t.Fatalf("declared resolution %q must remain valid: %+v %v", resolution, result, err)
				}
			}
			if len(fake.requests) != 0 {
				t.Fatal("context and proposals must not call models")
			}
		})
	}
}

func TestCloudAgentDramaGuideMissingVideoModelKeepsBasicContext(t *testing.T) {
	svc, fake := newDramaTestService(t)
	draft := createGuidedDrama(t, svc, DramaChapterInput{Title: "第一章", Text: "故事正文"})
	state := &cloudAgentRuntime{Request: CloudAgentRequest{DramaProjectID: draft.Project.ID}}
	for _, choice := range []DramaModelChoice{{}, {ChannelID: "missing", ModelKey: "missing"}} {
		settings := draft.Production.Settings
		settings.Models.Video = choice
		if err := fake.db.Model(&model.DramaProduction{}).Where("project_id = ?", draft.Project.ID).Update("settings_json", encodeDramaSettings(settings)).Error; err != nil {
			t.Fatal(err)
		}
		call := cloudAgentCall{ID: "missing-model-context"}
		call.Function.Arguments = `{}`
		result, err := cloudAgentHandleDramaGetContext(svc.repo, "usr-drama", state, call, svc)
		if err != nil {
			t.Fatalf("unavailable video model must not block reading the story: %v", err)
		}
		context := result.(map[string]any)
		contract := context["guide"].(map[string]any)["videoModel"].(cloudAgentDramaVideoModel)
		if contract.Issue == "" || len(contract.VideoRatios) != 0 || len(contract.VideoResolutions) != 0 || len(context["chapters"].([]DramaChapterRef)) == 0 {
			t.Fatalf("missing model needs readable feedback and basic story context: %+v", context)
		}
	}
}
