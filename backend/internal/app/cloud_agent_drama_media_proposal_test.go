package app

import (
	"encoding/json"
	"strings"
	"testing"

	"yingce/backend/internal/model"
)

func TestCloudAgentDramaStudioNextStepsSeparateIntentFromExecution(t *testing.T) {
	request := agentTestRequest()
	request.CanvasID = ""
	request.DramaProjectID = "drama-project"
	request.ContextScope = []string{"drama"}
	policy, _, err := compileCloudAgentPolicies(request, defaultCanvasAppearance().AgentName, nil, "", cloudAgentProfileSnapshot{})
	if err != nil {
		t.Fatal(err)
	}
	for _, contract := range []string{
		"制作台先区分“选择下一步方向”和“确认执行媒体任务”",
		"回复最末尾列 2–4 条编号短句，每条一行",
		"界面提供直接选择与空白自定义输入",
		"此时不调用 drama_propose_changes(kind=media)",
		"不提前为尚未选中的方向提出媒体动作",
		"用户明确选中或直接要求具体动作后，先用 drama_get_context 读取最新状态",
		"只针对本次选中的真实目标",
		"检查状态等只读选择直接读取，不提出媒体动作",
		"不能复用旧预检确认来替代本轮选择",
		"方向选择不等于确认生成，仍须经过真实预检、展示范围与费用并由用户确认后才执行",
		"顶层 confirmationOption 中填写去掉编号与 Markdown 后的精确选项文字",
		"不靠“确认”等关键词推断",
		"普通下一步方向、取消或暂不生成选项不能作为媒体执行确认关联",
		"confirmationOption 仅控制展示关联，不表示用户已经确认",
		"不要猜测费用与前置条件",
		"不能声称已生成、已重试或已计费",
		"允许初始值 0，不能省略或自行改成 1",
	} {
		if !strings.Contains(policy, contract) {
			t.Fatalf("missing studio next-step boundary: %s", contract)
		}
	}
	canvasPolicy, _, err := compileCloudAgentPolicies(agentTestRequest(), defaultCanvasAppearance().AgentName, nil, "", cloudAgentProfileSnapshot{})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(canvasPolicy, "制作台先区分") {
		t.Fatal("short-drama next-step policy leaked into ordinary canvas sessions")
	}
}

func TestCloudAgentDramaMediaProposalConfirmationOptionIsOptionalDisplayMetadata(t *testing.T) {
	request := agentTestRequest()
	request.CanvasID = ""
	request.DramaProjectID = "drama-project"
	request.ContextScope = []string{"drama"}
	found := false
	for _, tool := range compileCloudAgentTools(request, true) {
		function := tool["function"].(map[string]any)
		if function["name"] != "drama_propose_changes" {
			continue
		}
		found = true
		parameters := function["parameters"].(map[string]any)
		property := parameters["properties"].(map[string]any)["confirmationOption"].(map[string]any)
		if property["type"] != "string" || property["minLength"] != float64(1) || property["maxLength"] != float64(90) {
			t.Fatalf("confirmation option must be bounded text: %+v", property)
		}
		for _, required := range parameters["required"].([]any) {
			if required == "confirmationOption" {
				t.Fatal("media without a numbered confirmation must not require a text association")
			}
		}
		for _, contract := range []string{"仅 media", "去掉编号与 Markdown 后的精确单行文字", "其他类型省略", "仅用于展示", "不执行或绕过预检、费用展示及用户确认"} {
			if !strings.Contains(property["description"].(string), contract) {
				t.Fatalf("confirmation option lost display boundary: %s", contract)
			}
		}
	}
	if !found {
		t.Fatal("missing short-drama proposal tool")
	}
}

func TestCloudAgentDramaMediaProposalConfirmationOptionRoundTripWithoutExecution(t *testing.T) {
	svc, fake := newDramaTestService(t)
	draft := createGuidedDrama(t, svc)
	projectID := draft.Project.ID
	if err := fake.db.Model(&model.DramaProduction{}).Where("project_id = ?", projectID).Update("guide_step", model.DramaGuideCompleted).Error; err != nil {
		t.Fatal(err)
	}
	if err := fake.db.Create(&model.DramaCast{ID: "cast-confirmation", ProjectID: projectID, Revision: 3, Kind: "character", Name: "主角"}).Error; err != nil {
		t.Fatal(err)
	}
	_, before, err := svc.dramaForUser("usr-drama", projectID)
	if err != nil {
		t.Fatal(err)
	}
	state := &cloudAgentRuntime{Request: CloudAgentRequest{DramaProjectID: projectID}}
	type testCase struct {
		name     string
		kind     string
		provided bool
		option   any
		invalid  bool
	}
	tests := []testCase{
		{name: "omitted"},
		{name: "explicit association", provided: true, option: "开始制作这张角色参考图"},
		{name: "trim association", provided: true, option: " \n 按当前参数制作角色参考图 \t "},
		{name: "unicode limit", provided: true, option: strings.Repeat("字", 90)},
		{name: "empty", provided: true, option: "", invalid: true},
		{name: "blank", provided: true, option: " \n\t ", invalid: true},
		{name: "null", provided: true, option: nil, invalid: true},
		{name: "number", provided: true, option: 1, invalid: true},
		{name: "boolean", provided: true, option: true, invalid: true},
		{name: "array", provided: true, option: []string{"生成角色参考图"}, invalid: true},
		{name: "object", provided: true, option: map[string]any{"text": "生成角色参考图"}, invalid: true},
		{name: "over unicode limit", provided: true, option: strings.Repeat("字", 91), invalid: true},
		{name: "multiline", provided: true, option: "制作角色参考图\n继续调整", invalid: true},
		{name: "unicode multiline", provided: true, option: "制作角色参考图\u2028继续调整", invalid: true},
	}
	for _, kind := range []string{"setup", "source", "cast", "cast_create", "cast_delete", "shot", "segment_prompt"} {
		tests = append(tests, testCase{name: "non-media " + kind, kind: kind, provided: true, option: "开始制作角色参考图", invalid: true})
	}
	tests = append(tests, testCase{name: "non-media empty", kind: "cast", provided: true, option: "", invalid: true})
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			kind := tc.kind
			if kind == "" {
				kind = "media"
			}
			args := map[string]any{"kind": kind, "targetId": "cast-confirmation", "baseRevision": before.Revision, "changes": map[string]any{"action": "cast_image", "targetRevision": 3}}
			if tc.provided {
				args["confirmationOption"] = tc.option
			}
			encoded, err := json.Marshal(args)
			if err != nil {
				t.Fatal(err)
			}
			call := cloudAgentCall{ID: "media-confirmation"}
			call.Function.Arguments = string(encoded)
			result, err := cloudAgentHandleDramaProposeChanges(svc.repo, "usr-drama", state, call, svc)
			if tc.invalid {
				if _, ok := err.(*cloudAgentArgumentError); !ok {
					t.Fatalf("invalid confirmation association accepted: %v", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			proposal := result.(cloudAgentDramaProposal)
			expected := ""
			if tc.provided {
				expected = strings.TrimSpace(tc.option.(string))
			}
			if proposal.ConfirmationOption != expected || len(proposal.Changes) != 2 || proposal.Changes["action"] != "cast_image" || proposal.Changes["targetRevision"] != float64(3) {
				t.Fatalf("display association changed the media payload: %+v", proposal)
			}
			encoded, err = json.Marshal(proposal)
			if err != nil {
				t.Fatal(err)
			}
			var replay map[string]any
			if err := json.Unmarshal(encoded, &replay); err != nil {
				t.Fatal(err)
			}
			if value, included := replay["confirmationOption"]; included != tc.provided || included && value != expected {
				t.Fatalf("confirmation association did not round-trip: %s", encoded)
			}
		})
	}
	call := cloudAgentCall{ID: "invalid-nested-confirmation"}
	encoded, err := json.Marshal(map[string]any{"kind": "media", "targetId": "cast-confirmation", "baseRevision": before.Revision, "changes": map[string]any{"action": "cast_image", "targetRevision": 3, "confirmationOption": "制作角色参考图"}})
	if err != nil {
		t.Fatal(err)
	}
	call.Function.Arguments = string(encoded)
	if _, err := cloudAgentHandleDramaProposeChanges(svc.repo, "usr-drama", state, call, svc); err == nil {
		t.Fatal("display association accepted inside media changes")
	}
	_, after, err := svc.dramaForUser("usr-drama", projectID)
	if err != nil || after.Revision != before.Revision || after.SettingsJSON != before.SettingsJSON {
		t.Fatalf("display association wrote production: %v", err)
	}
	cast, err := svc.repo.DramaCast(projectID, "cast-confirmation")
	if err != nil || cast.Revision != 3 || cast.Name != "主角" {
		t.Fatalf("display association wrote asset: %v", err)
	}
	if len(fake.requests) != 0 {
		t.Fatal("display association submitted generation")
	}
	var jobs int64
	if err := fake.db.Model(&model.DramaJob{}).Where("project_id = ?", projectID).Count(&jobs).Error; err != nil || jobs != 0 {
		t.Fatalf("display association enqueued jobs: %d %v", jobs, err)
	}
}

func TestCloudAgentDramaMediaProposalTargetsCurrentObjectWithoutEnqueue(t *testing.T) {
	svc, fake := newDramaTestService(t)
	draft := createGuidedDrama(t, svc)
	projectID := draft.Project.ID
	if err := fake.db.Model(&model.DramaProduction{}).Where("project_id = ?", projectID).Update("guide_step", model.DramaGuideCompleted).Error; err != nil {
		t.Fatal(err)
	}
	for _, row := range []any{
		&model.DramaCast{ID: "cast-current", ProjectID: projectID, Revision: 3, Kind: "character", Name: "主角"},
		&model.DramaCast{ID: "cast-new", ProjectID: projectID, Kind: "prop", Name: "尚未生成"},
		&model.DramaCast{ID: "cast-foreign", ProjectID: "other-project", Revision: 3, Kind: "character", Name: "其他作品"},
		&model.DramaSegment{ID: "segment-current", ProjectID: projectID, EpisodeID: "episode-current", SegmentIndex: 0, Revision: 4},
		&model.DramaSegment{ID: "segment-foreign", ProjectID: "other-project", EpisodeID: "episode-other", Revision: 4},
	} {
		if err := fake.db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	state := &cloudAgentRuntime{Request: CloudAgentRequest{DramaProjectID: projectID}}
	contextCall := cloudAgentCall{ID: "read"}
	contextCall.Function.Arguments = `{}`
	context, err := cloudAgentHandleDramaGetContext(svc.repo, "usr-drama", state, contextCall, svc)
	if err != nil {
		t.Fatal(err)
	}
	castViews := context.(map[string]any)["casts"].([]map[string]any)
	seenInitial := false
	for _, cast := range castViews {
		if cast["id"] == "cast-new" {
			seenInitial = cast["revision"] == int64(0)
		}
	}
	if !seenInitial {
		t.Fatal("current context omitted the real initial asset version")
	}
	propose := func(userID, target string, revision int64, changes map[string]any) error {
		body, err := json.Marshal(cloudAgentDramaProposal{Kind: "media", TargetID: target, BaseRevision: revision, Changes: changes})
		if err != nil {
			t.Fatal(err)
		}
		call := cloudAgentCall{ID: "media"}
		call.Function.Arguments = string(body)
		_, err = cloudAgentHandleDramaProposeChanges(svc.repo, userID, state, call, svc)
		return err
	}
	for _, action := range []string{"segment_video", "segment_assets", "segment_prompt", "segment_reprocess"} {
		if err := propose("usr-drama", "segment-current", draft.Production.Revision, map[string]any{"action": action, "episodeId": "episode-current", "targetRevision": 4}); err != nil {
			t.Fatalf("%s: %v", action, err)
		}
	}
	if err := propose("usr-drama", "cast-current", draft.Production.Revision, map[string]any{"action": "cast_image", "targetRevision": 3}); err != nil {
		t.Fatal(err)
	}
	if err := propose("usr-drama", "cast-new", draft.Production.Revision, map[string]any{"action": "cast_image", "targetRevision": 0}); err != nil {
		t.Fatalf("initial asset revision zero rejected: %v", err)
	}
	for _, tc := range []struct {
		name, user, target string
		revision           int64
		changes            map[string]any
	}{
		{"stale production", "usr-drama", "segment-current", draft.Production.Revision + 1, map[string]any{"action": "segment_video", "episodeId": "episode-current", "targetRevision": 4}},
		{"stale target", "usr-drama", "segment-current", draft.Production.Revision, map[string]any{"action": "segment_video", "episodeId": "episode-current", "targetRevision": 3}},
		{"wrong episode", "usr-drama", "segment-current", draft.Production.Revision, map[string]any{"action": "segment_video", "episodeId": "episode-other", "targetRevision": 4}},
		{"missing episode", "usr-drama", "segment-current", draft.Production.Revision, map[string]any{"action": "segment_video", "targetRevision": 4}},
		{"foreign target", "usr-drama", "segment-foreign", draft.Production.Revision, map[string]any{"action": "segment_video", "episodeId": "episode-other", "targetRevision": 4}},
		{"foreign cast", "usr-drama", "cast-foreign", draft.Production.Revision, map[string]any{"action": "cast_image", "targetRevision": 3}},
		{"foreign user", "other-user", "cast-current", draft.Production.Revision, map[string]any{"action": "cast_image", "targetRevision": 3}},
		{"invalid action", "usr-drama", "cast-current", draft.Production.Revision, map[string]any{"action": "release_all", "targetRevision": 3}},
		{"no target version", "usr-drama", "cast-current", draft.Production.Revision, map[string]any{"action": "cast_image"}},
		{"fraction target version", "usr-drama", "cast-current", draft.Production.Revision, map[string]any{"action": "cast_image", "targetRevision": 3.5}},
		{"arbitrary scope", "usr-drama", "cast-current", draft.Production.Revision, map[string]any{"action": "cast_image", "targetRevision": 3, "castIds": []string{"cast-foreign"}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := propose(tc.user, tc.target, tc.revision, tc.changes); err == nil {
				t.Fatal("invalid media proposal accepted")
			}
		})
	}
	if err := fake.db.Model(&model.DramaProduction{}).Where("project_id = ?", projectID).Update("guide_step", model.DramaGuideStory).Error; err != nil {
		t.Fatal(err)
	}
	if err := propose("usr-drama", "cast-current", draft.Production.Revision, map[string]any{"action": "cast_image", "targetRevision": 3}); err == nil {
		t.Fatal("guide proposed media before completing text")
	}
	if err := fake.db.Model(&model.DramaProduction{}).Where("project_id = ?", projectID).Update("guide_step", "").Error; err != nil {
		t.Fatal(err)
	}
	if err := propose("usr-drama", "cast-new", draft.Production.Revision, map[string]any{"action": "cast_image", "targetRevision": 0}); err != nil {
		t.Fatalf("legacy production rejected media proposal: %v", err)
	}
	if len(fake.requests) != 0 {
		t.Fatal("proposal submitted generation")
	}
	var jobs int64
	if err := fake.db.Model(&model.DramaJob{}).Where("project_id = ?", projectID).Count(&jobs).Error; err != nil || jobs != 0 {
		t.Fatalf("proposal enqueued jobs: %d %v", jobs, err)
	}
}
