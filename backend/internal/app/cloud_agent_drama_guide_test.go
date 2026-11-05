package app

import (
	"encoding/json"
	"fmt"
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
	projectID := createTestDrama(t, svc, DramaReviewAuto).Project.ID
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
