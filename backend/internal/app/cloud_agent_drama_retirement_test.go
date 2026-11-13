package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"gorm.io/gorm"
	"yingce/backend/internal/model"
	"yingce/backend/internal/repository"
)

func requireDramaAgentRetired(t *testing.T, err error) {
	t.Helper()
	var appErr *AppError
	if !errors.As(err, &appErr) || appErr.Status != 400 || appErr.Reason != "drama_agent_retired" {
		t.Fatalf("expected retired short-drama Agent rejection, got %v", err)
	}
}

func TestCloudAgentDedicatedDramaRequestsAreRetiredBeforeAdmission(t *testing.T) {
	s, db, _, _ := creationTestService(t)
	for _, canvasID := range []string{"", "agent-canvas"} {
		req := agentTestRequest()
		req.CanvasID, req.DramaProjectID, req.ContextScope = canvasID, "drama-project", []string{"drama"}
		_, err := s.CreateCloudAgentRun("user", req, "")
		requireDramaAgentRetired(t, err)
	}
	req := agentTestRequest()
	req.ContextScope = []string{"drama"}
	if _, err := s.CreateCloudAgentRun("user", req, ""); err == nil {
		t.Fatal("the retired drama context must not become a general conversation")
	}
	for _, table := range []any{&model.Task{}, &model.BillingOrder{}, &model.CreditLedgerEntry{}, &model.CloudAgentExecution{}} {
		var count int64
		if err := db.Model(table).Count(&count).Error; err != nil || count != 0 {
			t.Fatalf("retired request created %T: count=%d, %v", table, count, err)
		}
	}
}

func TestCloudAgentRetiredDramaHistoryRemainsReadableButCannotExecuteOrContinue(t *testing.T) {
	s, db, _, _ := creationTestService(t)
	req := unboundAgentTestRequest("historical-drama-agent")
	root, err := s.CreateCloudAgentRun("user", req, "")
	if err != nil {
		t.Fatal(err)
	}
	execution, err := s.repo.CloudAgent("user", root.ID)
	if err != nil {
		t.Fatal(err)
	}
	state, err := cloudAgentDecode(execution)
	if err != nil {
		t.Fatal(err)
	}
	state.Request.DramaProjectID, state.Request.ContextScope = "historical-drama", []string{"drama"}
	if err := cloudAgentSave(execution, &state); err != nil {
		t.Fatal(err)
	}
	if err := db.Model(execution).Updates(map[string]any{"state_json": execution.StateJSON}).Error; err != nil {
		t.Fatal(err)
	}
	view, err := s.CloudAgentRun("user", root.ID)
	if err != nil || view.DramaProjectID != "historical-drama" || view.ID != root.ID {
		t.Fatalf("historical run must remain readable: %+v %v", view, err)
	}
	if _, err := cloudAgentDecodeForExecution(execution); err == nil {
		t.Fatal("historical short-drama run must never resume")
	} else {
		requireDramaAgentRetired(t, err)
	}
	// The authoritative runtime must reject continuation even when the task
	// input still has an earlier, unbound request snapshot.
	finishConversationTestRun(t, db, root.ID)
	req.IdempotencyKey = "continue-retired-drama"
	_, err = s.CreateCloudAgentRun("user", req, root.ID)
	requireDramaAgentRetired(t, err)
	var count int64
	if err := db.Model(&model.Task{}).Count(&count).Error; err != nil || count != 1 {
		t.Fatalf("retired continuation created a new task: count=%d, %v", count, err)
	}
	if err := db.Model(execution).Update("status", "queued").Error; err != nil {
		t.Fatal(err)
	}
	if err := s.CancelCloudAgent(context.Background(), "user", root.ID); err != nil {
		t.Fatalf("retired run must remain cancellable: %v", err)
	}
}

func TestCloudAgentRetirementPreservesOnlyLinkedCanvasDramaTools(t *testing.T) {
	req := agentTestRequest()
	req.PermissionMode, req.DramaLinked = "auto", true
	tools := map[string]bool{}
	for _, schema := range cloudAgentTools(req) {
		function := schema["function"].(map[string]any)
		tools[stringValue(function["name"])] = true
		if function["name"] == "drama_get_context" {
			properties := function["parameters"].(map[string]any)["properties"].(map[string]any)
			if _, ok := properties["chapterId"]; ok {
				t.Fatal("dedicated source chapter scope survived retirement")
			}
		}
	}
	for _, name := range []string{"drama_get_context", "drama_adopt_canvas_media", "generate_media", "generate_media_batch", "canvas_get_state"} {
		if !tools[name] {
			t.Fatalf("linked canvas lost general capability %s", name)
		}
	}
	if tools["drama_propose_changes"] {
		t.Fatal("dedicated proposal tool survived retirement")
	}
	req.ContextScope = []string{"drama"}
	for _, schema := range cloudAgentTools(req) {
		function := schema["function"].(map[string]any)
		if function["name"] == "drama_get_context" || function["name"] == "drama_adopt_canvas_media" {
			t.Fatal("synthetic retired context exposed canvas drama tools")
		}
	}
}

func retiredDramaPiFixture(t *testing.T, status string) (*Service, *gorm.DB, *CloudAgentRun, cloudAgentCall) {
	t.Helper()
	s, db, _, _ := creationTestService(t)
	s.legacyCloudAgentRootTask = false
	root, err := s.CreateCloudAgentRun("user", unboundAgentTestRequest("historical-drama-pi"), "")
	if err != nil {
		t.Fatal(err)
	}
	run, state := agentInterjectionState(t, s, root.ID)
	state.Request.DramaProjectID, state.Request.ContextScope, state.Request.DramaLinked = "historical-drama", []string{"drama"}, true
	state.Policy.CompilerVersion = "cloud-agent-policy-compiler/v8"
	state.Canonical.Tools = append(state.Canonical.Tools, map[string]any{"type": "function", "function": map[string]any{
		"name": "drama_propose_changes", "parameters": map[string]any{"type": "object"},
	}})
	call := cloudAgentCall{ID: "historical-plan"}
	call.Function.Name, call.Function.Arguments = "plan_update", `{"items":[{"id":"1","title":"旧引导不应继续","status":"pending"}]}`
	state.Calls = []cloudAgentCall{call}
	if err := s.repo.MutateCloudAgent("user", run.ID, run.Revision, func(current *model.CloudAgentExecution, _ *repository.Repository) error {
		current.Status = status
		return cloudAgentSave(current, &state)
	}); err != nil {
		t.Fatal(err)
	}
	return s, db, root, call
}

func TestCloudAgentRetiredDramaPiProductionEntrypointsRejectBeforeWork(t *testing.T) {
	for _, entry := range []string{"queued session", "running session", "model bridge", "model bridge without model id", "model step", "tool bridge"} {
		t.Run(entry, func(t *testing.T) {
			status := "running"
			if entry == "queued session" {
				status = "queued"
			}
			s, db, root, call := retiredDramaPiFixture(t, status)
			before, _ := agentInterjectionState(t, s, root.ID)
			var runtimeCalls atomic.Int32
			runtime := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				runtimeCalls.Add(1)
				w.Header().Set("Content-Type", "application/x-ndjson")
				_, _ = w.Write([]byte("{\"event\":\"settled\"}\n"))
			}))
			defer runtime.Close()
			t.Setenv("YINGCE_AGENT_URL", runtime.URL)
			t.Setenv("YINGCE_AGENT_TOKEN", strings.Repeat("t", 32))
			t.Setenv("YINGCE_AGENT_BRIDGE_HOST", "127.0.0.1")
			ctx, cancel := context.WithTimeout(context.Background(), 250*time.Millisecond)
			defer cancel()
			messages := []map[string]any{{"role": "user", "content": "继续"}}
			var err error
			switch entry {
			case "queued session", "running session":
				err = s.runCloudAgentPiSession(ctx, "user", root.ID)
			case "model bridge", "model bridge without model id":
				payload := approvalPauseModelPayload(t, messages)
				if entry == "model bridge without model id" {
					delete(payload, "modelId")
				}
				_, err = s.cloudAgentPiModel(ctx, "user", root.ID, payload)
			case "model step":
				_, _, err = s.runCloudAgentModelStep(ctx, "user", root.ID, messages, "off")
			case "tool bridge":
				_, err = s.cloudAgentPiTool(ctx, "user", root.ID, map[string]json.RawMessage{
					"callId": json.RawMessage(`"` + call.ID + `"`), "name": json.RawMessage(`"plan_update"`), "arguments": json.RawMessage(call.Function.Arguments),
				})
			}
			requireDramaAgentRetired(t, err)
			if runtimeCalls.Load() != 0 {
				t.Fatal("retired run reached the external Agent runtime")
			}
			after, state := agentInterjectionState(t, s, root.ID)
			if before.Revision != after.Revision || after.Status != status || state.ActiveTaskID != "" || state.CallIndex != 0 || len(state.Plan) != 0 {
				t.Fatalf("retired run was advanced: revision=%d/%d status=%s state=%+v", before.Revision, after.Revision, after.Status, state)
			}
			for _, row := range []struct {
				table any
				want  int64
			}{{&model.Task{}, 1}, {&model.BillingOrder{}, 0}, {&model.CreditLedgerEntry{}, 0}} {
				var count int64
				if err := db.Model(row.table).Count(&count).Error; err != nil || count != row.want {
					t.Fatalf("retired run created %T: count=%d want=%d error=%v", row.table, count, row.want, err)
				}
			}
		})
	}
}

func TestCloudAgentRetiredDramaPiCommittedToolReceiptRemainsReadable(t *testing.T) {
	s, _, root, call := retiredDramaPiFixture(t, "completed")
	run, state := agentInterjectionState(t, s, root.ID)
	state.CallIndex = len(state.Calls)
	state.Canonical.Messages = append(state.Canonical.Messages, map[string]any{"role": "tool", "tool_call_id": call.ID, "name": call.Function.Name, "content": `{"historical":true}`})
	if err := s.repo.MutateCloudAgent("user", run.ID, run.Revision, func(current *model.CloudAgentExecution, _ *repository.Repository) error {
		return cloudAgentSave(current, &state)
	}); err != nil {
		t.Fatal(err)
	}
	before, _ := agentInterjectionState(t, s, root.ID)
	result, err := s.executeCloudAgentRuntimeTool(context.Background(), "user", root.ID, call)
	if err != nil || result == nil {
		t.Fatalf("committed historical receipt must remain replayable: %v %v", result, err)
	}
	after, _ := agentInterjectionState(t, s, root.ID)
	if after.Revision != before.Revision {
		t.Fatal("historical receipt replay changed the run")
	}
	if _, err := s.CloudAgentRun("user", root.ID); err != nil {
		t.Fatalf("old compiler and retired tool schema prevented a historical read: %v", err)
	}
}
