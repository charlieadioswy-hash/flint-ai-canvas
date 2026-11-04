package app

import (
	"strings"
	"sync"
	"testing"

	"yingce/backend/internal/model"
)

func TestTaskSubmissionReplaysAfterCompletionAndCompaction(t *testing.T) {
	s, db, _, _ := creationTestService(t)
	req := creationTextRequest()
	req.ClientOperationID = "fast-completed:0"
	created, err := s.CreateTask("user", req)
	if err != nil {
		t.Fatal(err)
	}
	stored, err := s.repo.TaskForUser("user", created.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.saveTaskCompletionWithinStorageQuota(stored, []byte(`{"text":"done"}`), nil, false); err != nil {
		t.Fatal(err)
	}
	var completed model.Task
	if err := db.First(&completed, "id = ?", created.ID).Error; err != nil {
		t.Fatal(err)
	}
	if strings.Contains(completed.InputJSON, "config") || !strings.Contains(completed.InputJSON, taskSubmissionInputKey) {
		t.Fatalf("completion must keep only the private receipt: %s", completed.InputJSON)
	}
	if got := compactTaskInputJSON(completed.InputJSON); got != completed.InputJSON {
		t.Fatalf("repeated migration compaction changed receipt: %s", got)
	}
	replayed, err := s.CreateTask("user", req)
	if err != nil || replayed.ID != created.ID || replayed.Status != model.TaskStatusSucceeded || strings.Contains(replayed.InputJSON, taskSubmissionInputKey) {
		t.Fatalf("completed replay = %+v, error = %v", replayed, err)
	}
}

func TestTaskSubmissionReplaysLostResponseWithoutAnotherReservation(t *testing.T) {
	s, db, _, _ := creationTestService(t)
	req := creationTextRequest()
	req.ClientOperationID = "batch-response-lost:0"
	first, err := s.CreateTask("user", req)
	if err != nil {
		t.Fatal(err)
	}
	// Replays survive process replacement and no longer need an enabled model
	// or a wallet large enough to reserve the same charge for a second time.
	if err := db.Model(&model.ChannelModel{}).Where("id = ?", "cm").Update("enabled", false).Error; err != nil {
		t.Fatal(err)
	}
	s2 := &Service{repo: s.repo}
	req.TraceID, req.RequestID = "new-trace", "new-http-request"
	replayed, err := s2.CreateTask("user", req)
	if err != nil || replayed.ID != first.ID || replayed.BillingOrderID != first.BillingOrderID {
		t.Fatalf("replay = %+v, error = %v", replayed, err)
	}
	req.Prompt = "different payload"
	if _, err := s2.CreateTask("user", req); !isAppErrorStatus(err, 409) {
		t.Fatalf("changed payload must conflict, got %v", err)
	}
	var account model.CreditAccount
	if err := db.First(&account, "user_id = ?", "user").Error; err != nil {
		t.Fatal(err)
	}
	if account.AvailableMicrocredits != 9900 || account.ReservedMicrocredits != 100 {
		t.Fatalf("wallet changed twice: %+v", account)
	}
}

func TestConcurrentTaskSubmissionReservesOnlyOnce(t *testing.T) {
	s, db, _, _ := creationTestService(t)
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	sqlDB.SetMaxOpenConns(1)
	// Distinct service locks model two instances sharing the durable database.
	other := &Service{repo: s.repo, dataDir: t.TempDir(), disablePiRuntime: true}
	req := creationTextRequest()
	req.ClientOperationID = "concurrent-batch:1"
	start := make(chan struct{})
	results := make(chan *model.Task, 2)
	errors := make(chan error, 2)
	var workers sync.WaitGroup
	for _, instance := range []*Service{s, other} {
		workers.Add(1)
		go func() {
			defer workers.Done()
			<-start
			task, err := instance.CreateTask("user", req)
			results <- task
			errors <- err
		}()
	}
	close(start)
	workers.Wait()
	for range 2 {
		if err := <-errors; err != nil {
			t.Fatal(err)
		}
	}
	first, second := <-results, <-results
	if first.ID != second.ID || first.BillingOrderID != second.BillingOrderID {
		t.Fatalf("duplicate submissions: %+v / %+v", first, second)
	}
	for _, table := range []any{&model.Task{}, &model.BillingOrder{}, &model.CreditLedgerEntry{}} {
		var count int64
		if err := db.Model(table).Count(&count).Error; err != nil || count != 1 {
			t.Fatalf("%T count = %d, error = %v", table, count, err)
		}
	}
}

func TestTaskSubmissionIdentityIsUserScoped(t *testing.T) {
	first, err := newTaskSubmission("alice", "batch:0", "tasks", creationTextRequest())
	if err != nil {
		t.Fatal(err)
	}
	second, err := newTaskSubmission("bob", "batch:0", "tasks", creationTextRequest())
	if err != nil || first.ID == second.ID || len(first.ID) != 36 {
		t.Fatalf("identities = %+v / %+v, error = %v", first, second, err)
	}
}
