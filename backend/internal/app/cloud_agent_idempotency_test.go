package app

import (
	"errors"
	"testing"

	"gorm.io/gorm"
	"yingce/backend/internal/model"
)

func dramaStartupIdempotencyFixture(t *testing.T) (*Service, *gorm.DB, CloudAgentRequest) {
	t.Helper()
	s, db, _, _ := creationTestService(t)
	for _, projectID := range []string{"startup-drama", "other-startup-drama"} {
		if err := db.Create(&model.Project{ID: projectID, UserID: "user", Name: projectID, Status: model.ProjectStatusActive}).Error; err != nil {
			t.Fatal(err)
		}
		if err := db.Create(&model.DramaProduction{ProjectID: projectID, UserID: "user", GuideStep: model.DramaGuideConfiguring}).Error; err != nil {
			t.Fatal(err)
		}
	}
	req := agentTestRequest()
	req.CanvasID = ""
	req.DramaProjectID = "startup-drama"
	req.ContextScope = []string{"drama"}
	req.IdempotencyKey = "drama-start-startup-drama"
	return s, db, req
}

func requireAgentIdempotencyConflict(t *testing.T, err error) *AppError {
	t.Helper()
	var conflict *AppError
	if !errors.As(err, &conflict) || conflict.Status != 409 || conflict.Code != 409 || conflict.Reason != "agent_idempotency_conflict" {
		t.Fatalf("expected definitive idempotency conflict, got %v", err)
	}
	return conflict
}

func TestCloudAgentDramaStartupIdempotencyConflictRestoresIdentity(t *testing.T) {
	for _, change := range []string{"model", "profile"} {
		t.Run(change, func(t *testing.T) {
			s, db, req := dramaStartupIdempotencyFixture(t)
			first, err := s.CreateCloudAgentRun("user", req, "")
			if err != nil {
				t.Fatal(err)
			}
			replayed, err := s.CreateCloudAgentRun("user", req, "")
			if err != nil || replayed.ID != first.ID {
				t.Fatalf("same request must replay its original run: %+v, %v", replayed, err)
			}
			if change == "model" {
				req.Model, req.ChannelModelKey = "different-text-model", "different-text-model"
			} else {
				view := saveAgentProfileForTest(t, s, "user", AgentProfileRequest{Scope: model.AgentProfileScopeUser, Content: "使用新的创作风格"})
				req.ProfileRevision = view.Revision
			}
			_, err = s.CreateCloudAgentRun("user", req, "")
			conflict := requireAgentIdempotencyConflict(t, err)
			if conflict.Details["runId"] != first.ID || conflict.Details["conversationId"] != first.ConversationID || conflict.Details["dramaProjectId"] != req.DramaProjectID || conflict.Details["canvasId"] != "" {
				t.Fatalf("missing safe recovery identity: %+v", conflict.Details)
			}
			for _, table := range []any{&model.Task{}, &model.BillingOrder{}, &model.CreditLedgerEntry{}} {
				var count int64
				if err := db.Model(table).Count(&count).Error; err != nil || count != 1 {
					t.Fatalf("conflict created another %T: count=%d, %v", table, count, err)
				}
			}
		})
	}
}

func TestCloudAgentIdempotencyConflictDoesNotRecoverAnotherBinding(t *testing.T) {
	s, db, req := dramaStartupIdempotencyFixture(t)
	if _, err := s.CreateCloudAgentRun("user", req, ""); err != nil {
		t.Fatal(err)
	}
	for _, binding := range []string{"drama", "canvas", "parent"} {
		t.Run(binding, func(t *testing.T) {
			changed := req
			parentID := ""
			switch binding {
			case "drama":
				changed.DramaProjectID = "other-startup-drama"
			case "canvas":
				if err := db.Create(&model.CanvasProject{ID: "agent-canvas", UserID: "user", PayloadJSON: `{"nodes":[]}`}).Error; err != nil {
					t.Fatal(err)
				}
				changed.DramaProjectID, changed.CanvasID, changed.ContextScope = "", "agent-canvas", []string{"canvas"}
			case "parent":
				parentID = "a-different-parent"
			}
			_, err := s.CreateCloudAgentRun("user", changed, parentID)
			if conflict := requireAgentIdempotencyConflict(t, err); len(conflict.Details) != 0 {
				t.Fatalf("cross-binding conflict exposed a recoverable identity: %+v", conflict.Details)
			}
		})
	}
	if _, err := s.CreateCloudAgentRun("other-user", req, ""); err == nil {
		t.Fatal("another user accessed the original startup request")
	} else {
		var appErr *AppError
		if !errors.As(err, &appErr) || appErr.Status != 404 || len(appErr.Details) != 0 {
			t.Fatalf("ownership rejection leaked recovery details: %v", err)
		}
	}
}

func TestCloudAgentIdempotencyConflictAfterConcurrentAdmission(t *testing.T) {
	s, db, req := dramaStartupIdempotencyFixture(t)
	first, err := s.CreateCloudAgentRun("user", req, "")
	if err != nil {
		t.Fatal(err)
	}
	// Model the interval after the winner committed its task but before it
	// created its execution checkpoint; the loser initially saw no task.
	if err := db.Delete(&model.CloudAgentExecution{}, "id = ?", first.ID).Error; err != nil {
		t.Fatal(err)
	}
	hidden := false
	if err := db.Callback().Query().After("gorm:query").Register("idempotency:hide_initial_lookup", func(tx *gorm.DB) {
		if task, ok := tx.Statement.Dest.(*model.Task); ok && task.ID == first.ID && !hidden {
			hidden = true
			tx.AddError(gorm.ErrRecordNotFound)
		}
	}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Callback().Query().Remove("idempotency:hide_initial_lookup") })
	req.Prompt = "另一端的首轮请求内容"
	_, err = s.CreateCloudAgentRun("user", req, "")
	conflict := requireAgentIdempotencyConflict(t, err)
	if !hidden || conflict.Details["runId"] != first.ID || conflict.Details["conversationId"] != first.ID || conflict.Details["dramaProjectId"] != req.DramaProjectID {
		t.Fatalf("concurrent collision lost startup identity before checkpoint: hidden=%t details=%+v", hidden, conflict.Details)
	}
	var count int64
	if err := db.Model(&model.Task{}).Count(&count).Error; err != nil || count != 1 {
		t.Fatalf("concurrent conflict admitted a second task: count=%d, %v", count, err)
	}
}

func TestCloudAgentIdempotencyConflictRecoversParentConversation(t *testing.T) {
	s, db, req := dramaStartupIdempotencyFixture(t)
	root, err := s.CreateCloudAgentRun("user", req, "")
	if err != nil {
		t.Fatal(err)
	}
	finishConversationTestRun(t, db, root.ID)
	req.IdempotencyKey = "drama-startup-follow-up"
	child, err := s.CreateCloudAgentRun("user", req, root.ID)
	if err != nil {
		t.Fatal(err)
	}
	req.Prompt = "另一份续轮请求"
	_, err = s.CreateCloudAgentRun("user", req, root.ID)
	conflict := requireAgentIdempotencyConflict(t, err)
	if conflict.Details["runId"] != child.ID || conflict.Details["conversationId"] != root.ConversationID {
		t.Fatalf("continuation conflict must restore the inherited conversation: %+v", conflict.Details)
	}
}

func TestCloudAgentIdempotencyUsesFrozenExplicitProfileBeforeAdmissionCAS(t *testing.T) {
	s, db, req := dramaStartupIdempotencyFixture(t)
	profile := saveAgentProfileForTest(t, s, "user", AgentProfileRequest{Scope: model.AgentProfileScopeUser, Content: "最初的创作偏好"})
	req.ProfileRevision = profile.Revision
	first, err := s.CreateCloudAgentRun("user", req, "")
	if err != nil {
		t.Fatal(err)
	}
	before, err := s.repo.CloudAgent("user", first.ID)
	if err != nil {
		t.Fatal(err)
	}
	saveAgentProfileForTest(t, s, "user", AgentProfileRequest{Scope: model.AgentProfileScopeUser, Content: "新的创作偏好", Revision: profile.Layers[0].Revision})

	replayed, err := s.CreateCloudAgentRun("user", req, "")
	if err != nil || replayed.ID != first.ID {
		t.Fatalf("original frozen request must replay after profile change: %+v, %v", replayed, err)
	}
	changed := req
	changed.Prompt = "使用旧偏好但内容不同的请求"
	_, err = s.CreateCloudAgentRun("user", changed, "")
	if conflict := requireAgentIdempotencyConflict(t, err); conflict.Details["conversationId"] != first.ConversationID {
		t.Fatalf("stale explicit profile hid the recoverable collision: %+v", conflict.Details)
	}
	changed.IdempotencyKey = "new-request-with-stale-profile"
	_, err = s.CreateCloudAgentRun("user", changed, "")
	var rejected *AppError
	if !errors.As(err, &rejected) || rejected.Status != 409 || rejected.Reason == "agent_idempotency_conflict" || len(rejected.Details) != 0 {
		t.Fatalf("new stale-profile request bypassed admission CAS: %v", err)
	}
	after, err := s.repo.CloudAgent("user", first.ID)
	if err != nil || before.StateJSON != after.StateJSON || before.Revision != after.Revision {
		t.Fatalf("replay or collision changed the admitted profile snapshot: %v", err)
	}
	for _, table := range []any{&model.Task{}, &model.BillingOrder{}, &model.CreditLedgerEntry{}} {
		var count int64
		if err := db.Model(table).Count(&count).Error; err != nil || count != 1 {
			t.Fatalf("replay or rejected request created another %T: count=%d, %v", table, count, err)
		}
	}
}
