package app

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"gorm.io/gorm"
	"yingce/backend/internal/model"
	"yingce/backend/internal/repository"
)

// seedDramaBillingOrder 在 taskProjectID 下建一条带计费订单的已完成任务；taskProjectID 是作品 ID（流水线）或画布 ID（精修）。
func seedDramaBillingOrder(t *testing.T, db *gorm.DB, taskProjectID, name string, order model.BillingOrder) *model.Task {
	t.Helper()
	completed := time.Now()
	task := &model.Task{ID: "task-" + name, UserID: "usr-drama", ProjectID: taskProjectID, Type: "canvas_video", Status: model.TaskStatusSucceeded, BillingOrderID: "order-" + name, CompletedAt: &completed}
	order.ID, order.UserID, order.TaskID, order.IdempotencyKey = task.BillingOrderID, task.UserID, task.ID, "task:"+task.ID
	if err := db.Create(&order).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(task).Error; err != nil {
		t.Fatal(err)
	}
	return task
}

func TestDramaTaskCostFollowsBillingSettlement(t *testing.T) {
	svc, fake := newDramaTestService(t)
	run := &dramaRun{s: svc}
	recent, stale := time.Now(), time.Now().Add(-dramaBillingSettleGrace-time.Minute)
	for _, test := range []struct {
		name     string
		order    *model.BillingOrder
		finished time.Time
		want     int64
		pending  bool
	}{
		{name: "free", want: 0},
		{name: "settled", order: &model.BillingOrder{AmountMicrocredits: 1_000_000, ActualAmountMicrocredits: 600_000, RefundedAmountMicrocredits: 400_000, Status: model.BillingStatusSettled}, finished: recent, want: 600_000},
		{name: "refunded", order: &model.BillingOrder{AmountMicrocredits: 1_000_000, RefundedAmountMicrocredits: 1_000_000, Status: model.BillingStatusRefunded}, finished: recent, want: 0},
		{name: "running", order: &model.BillingOrder{AmountMicrocredits: 1_000_000, Status: model.BillingStatusRunning}, finished: recent, pending: true},
		{name: "reserved", order: &model.BillingOrder{AmountMicrocredits: 1_000_000, Status: model.BillingStatusReserved}, finished: recent, pending: true},
		// 待人工核对不会很快落到终态：按冻结额记，不让作业一直等。
		{name: "uncertain", order: &model.BillingOrder{AmountMicrocredits: 1_000_000, Status: model.BillingStatusUncertain}, finished: recent, want: 1_000_000},
		{name: "stuck", order: &model.BillingOrder{AmountMicrocredits: 1_000_000, Status: model.BillingStatusRunning}, finished: stale, want: 1_000_000},
	} {
		t.Run(test.name, func(t *testing.T) {
			task := &model.Task{ID: "task-" + test.name, UpdatedAt: test.finished}
			if test.order != nil {
				task = seedDramaBillingOrder(t, fake.db, "drama-cost", test.name, *test.order)
				task.CompletedAt = &test.finished
			}
			cost, err := run.taskCost(task)
			var pending *dramaPendingBilling
			if test.pending {
				if !errors.As(err, &pending) {
					t.Fatalf("unsettled order must defer the job: cost=%d err=%v", cost, err)
				}
				return
			}
			if err != nil || cost != test.want {
				t.Fatalf("taskCost = %d, %v; want %d", cost, err, test.want)
			}
		})
	}
	// 订单记录丢失按 0 记，不阻塞作业。
	if cost, err := run.taskCost(&model.Task{ID: "orphan", BillingOrderID: "missing"}); err != nil || cost != 0 {
		t.Fatalf("missing order = %d, %v", cost, err)
	}
}

// 作品花费按订单重算：历史 spent_microcredits 里的冻结额不再影响展示与预算，调度时回写为流水线实收。
func TestDramaSpendFollowsBillingOrders(t *testing.T) {
	svc, fake := newDramaTestService(t)
	project := createTestDrama(t, svc, DramaReviewAuto).Project.ID
	if err := fake.db.Create(&model.CanvasProject{ID: "canvas-drama", UserID: "usr-drama", ProjectID: project, Title: "精修", PayloadJSON: `{"nodes":[],"connections":[]}`}).Error; err != nil {
		t.Fatal(err)
	}
	seedDramaBillingOrder(t, fake.db, project, "pipeline-settled", model.BillingOrder{AmountMicrocredits: 100, ActualAmountMicrocredits: 60, RefundedAmountMicrocredits: 40, Status: model.BillingStatusSettled})
	seedDramaBillingOrder(t, fake.db, project, "pipeline-refunded", model.BillingOrder{AmountMicrocredits: 70, RefundedAmountMicrocredits: 70, Status: model.BillingStatusRefunded})
	seedDramaBillingOrder(t, fake.db, project, "pipeline-uncertain", model.BillingOrder{AmountMicrocredits: 30, Status: model.BillingStatusUncertain})
	seedDramaBillingOrder(t, fake.db, "canvas-drama", "canvas-settled", model.BillingOrder{AmountMicrocredits: 50, ActualAmountMicrocredits: 20, RefundedAmountMicrocredits: 30, Status: model.BillingStatusSettled})
	seedDramaBillingOrder(t, fake.db, "canvas-drama", "canvas-running", model.BillingOrder{AmountMicrocredits: 15, Status: model.BillingStatusRunning})
	// 旧版本把冻结额累加进缓存列；budget 1000 足够，按缓存会误判超预算。
	if err := svc.repo.UpdateDramaProduction(project, map[string]any{"budget_microcredits": 1000, "spent_microcredits": 5000}); err != nil {
		t.Fatal(err)
	}
	summary, err := svc.DramaSummary("usr-drama", project)
	if err != nil {
		t.Fatal(err)
	}
	if got := summary.Production; got.SpentMicrocredits != 80 || got.CanvasSpentMicrocredits != 20 || got.HeldMicrocredits != 45 {
		t.Fatalf("summary spend = spent %d canvas %d held %d", got.SpentMicrocredits, got.CanvasSpentMicrocredits, got.HeldMicrocredits)
	}
	list, err := svc.ListDramas("usr-drama", DramaListRequest{Page: 1, PageSize: 20})
	if err != nil {
		t.Fatal(err)
	}
	items, _ := list["items"].([]DramaListItem)
	if len(items) != 1 || items[0].SpentMicrocredits != 80 || items[0].HeldMicrocredits != 45 {
		t.Fatalf("list spend = %+v", items)
	}
	if spent, err := svc.dramaCanvasSpent(mustDramaProduction(t, svc, project)); err != nil || spent != 35 {
		t.Fatalf("canvas budget usage = %d, %v; want charged 20 + held 15", spent, err)
	}
	runDramaTicks(t, svc, project, 1)
	p := mustDramaProduction(t, svc, project)
	if p.Status != model.DramaStatusRunning || len(fake.requests) == 0 {
		t.Fatalf("stale cached spend must not pause the drama: %+v requests=%d", p, len(fake.requests))
	}
	if p.SpentMicrocredits != 60 {
		t.Fatalf("dispatch must rewrite the cache with pipeline charges: %d", p.SpentMicrocredits)
	}
}

func mustDramaProduction(t *testing.T, svc *Service, project string) *model.DramaProduction {
	t.Helper()
	p, err := svc.repo.DramaProduction(project)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

func TestDramaTaskReservationRejectsOrdersAboveRemainingBudget(t *testing.T) {
	s, _, _ := shotMediaFixture(t)
	const user, project = "user", "drama-project"
	if err := s.repo.UpdateDramaProduction(project, map[string]any{"budget_microcredits": 100}); err != nil {
		t.Fatal(err)
	}
	jobs := []model.DramaJob{
		{ID: "budget-job-first", ProjectID: project, Kind: model.DramaJobCastImage, Status: model.DramaJobQueued},
		{ID: "budget-job-second", ProjectID: project, Kind: model.DramaJobCastImage, Status: model.DramaJobQueued},
	}
	if err := s.repo.CreateDramaJobs(jobs); err != nil {
		t.Fatal(err)
	}
	persist := func(job *model.DramaJob, amount int64) error {
		task := &model.Task{ID: "task-" + job.ID, UserID: user, ProjectID: project, Type: "canvas_image", Status: model.TaskStatusQueued}
		order := &model.BillingOrder{ID: "order-" + job.ID, UserID: user, TaskID: task.ID, IdempotencyKey: task.ID, AmountMicrocredits: amount, Status: model.BillingStatusReserved}
		_, err := s.persistDramaTask(job, task, order)
		return err
	}
	if err := persist(&jobs[0], 60); err != nil {
		t.Fatal(err)
	}
	if err := persist(&jobs[1], 60); !errors.Is(err, repository.ErrDramaBudgetInsufficient) {
		t.Fatalf("second reservation = %v, want insufficient production budget", err)
	}
	pending, err := s.repo.DramaJobsByStatus(project, model.DramaJobQueued)
	if err != nil || len(pending) != 1 || pending[0].ID != jobs[1].ID || pending[0].TaskID != "" {
		t.Fatalf("blocked job did not stay queued: %+v, %v", pending, err)
	}
	totals, err := s.dramaBillingTotals(mustDramaProduction(t, s, project))
	if err != nil || totals.HeldMicrocredits() != 60 {
		t.Fatalf("rejected reservation changed holds: %+v, %v", totals, err)
	}
	if err := persist(&jobs[1], 40); err != nil {
		t.Fatalf("reservation equal to remaining budget failed: %v", err)
	}
}

func TestDramaBudgetGuardsRouteReplacementAndTaskCenterRetry(t *testing.T) {
	s, db, _ := shotMediaFixture(t)
	const user, project = "user", "drama-project"
	if err := s.repo.UpdateDramaProduction(project, map[string]any{"budget_microcredits": 100}); err != nil {
		t.Fatal(err)
	}
	job := model.DramaJob{ID: "budget-route-job", ProjectID: project, Status: model.DramaJobQueued, Kind: model.DramaJobSegmentPrompt}
	if err := s.repo.CreateDramaJobs([]model.DramaJob{job}); err != nil {
		t.Fatal(err)
	}
	task := &model.Task{ID: "budget-route-task", UserID: user, ProjectID: project, Status: model.TaskStatusQueued, Type: "canvas_text", RouteID: "first", InputJSON: "{}"}
	order := &model.BillingOrder{ID: "budget-route-order", UserID: user, TaskID: task.ID, IdempotencyKey: task.ID, AmountMicrocredits: 60, Status: model.BillingStatusReserved}
	if _, err := s.persistDramaTask(&job, task, order); err != nil {
		t.Fatal(err)
	}
	if err := db.Model(task).Update("status", model.TaskStatusRunning).Error; err != nil {
		t.Fatal(err)
	}
	replace := func(amount int64) error {
		newOrder := &model.BillingOrder{UserID: user, TaskID: task.ID, AmountMicrocredits: amount}
		return s.repo.SwitchTaskLogicalRoute(task.ID, "first", "fallback", "{}", order.ID, "channel", "fallback-model", newOrder, model.BillingCostSnapshot{}, "")
	}
	if err := replace(120); !errors.Is(err, repository.ErrDramaBudgetInsufficient) {
		t.Fatalf("over-budget replacement = %v", err)
	}
	saved, err := s.repo.Task(task.ID)
	if err != nil || saved.RouteID != "first" {
		t.Fatalf("rejected replacement changed the route: %+v, %v", saved, err)
	}
	if err := replace(100); err != nil {
		t.Fatalf("replacement equal to remaining budget: %v", err)
	}
	if err := db.Model(task).Update("status", model.TaskStatusFailed).Error; err != nil {
		t.Fatal(err)
	}
	if err := s.repo.RefundBillingOrder(order.ID, "测试任务失败"); err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.DramaJob{}).Where("id = ?", job.ID).Update("task_id", "").Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(task).Update("input_json", `{"metadata":{"source":"drama_production","domainProjectId":"drama-project"}}`).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := s.RetryTask(user, task.ID); err == nil || !strings.Contains(err.Error(), "作品制作队列") {
		t.Fatalf("generic retry should direct the user to the production queue: %v", err)
	}
	saved, err = s.repo.Task(task.ID)
	if err != nil || saved.Status != model.TaskStatusFailed || saved.BillingOrderID != order.ID {
		t.Fatalf("rejected generic retry changed the task: %+v, %v", saved, err)
	}
}

func TestDramaBudgetGuardsLinkedCanvasRouteReplacement(t *testing.T) {
	s, db, _ := shotMediaFixture(t)
	const user, project = "user", "drama-project"
	if err := s.repo.UpdateDramaProduction(project, map[string]any{"budget_microcredits": 100}); err != nil {
		t.Fatal(err)
	}
	canvas := model.CanvasProject{ID: "linked-canvas", ProjectID: project, UserID: user}
	if err := db.Create(&canvas).Error; err != nil {
		t.Fatal(err)
	}
	task := model.Task{ID: "canvas-route-task", UserID: user, ProjectID: canvas.ID, Status: model.TaskStatusRunning, RouteID: "initial", BillingOrderID: "canvas-order"}
	order := model.BillingOrder{ID: task.BillingOrderID, UserID: user, TaskID: task.ID, IdempotencyKey: task.ID, AmountMicrocredits: 60, Status: model.BillingStatusReserved}
	if err := s.repo.CreateTaskWithCreditReservation(&task, &order, 8); err != nil {
		t.Fatal(err)
	}
	replacement := model.BillingOrder{UserID: user, TaskID: task.ID, AmountMicrocredits: 120}
	err := s.repo.SwitchTaskLogicalRoute(task.ID, "initial", "fallback", "{}", order.ID, "channel", "model", &replacement, model.BillingCostSnapshot{}, "")
	if !errors.Is(err, repository.ErrDramaBudgetInsufficient) {
		t.Fatalf("linked canvas switch did not check production budget: %v", err)
	}
}

func TestDramaBudgetGuardsLinkedCanvasAdmissionAndRetry(t *testing.T) {
	s, db, _ := shotAudioFixture(t)
	const user, project, canvasID = "user", "drama-project", "linked-canvas"
	if err := db.Create(&model.CanvasProject{ID: canvasID, ProjectID: project, UserID: user}).Error; err != nil {
		t.Fatal(err)
	}
	req := CreateTaskRequest{Type: "canvas_audio", Operation: "audio", ProjectID: canvasID, Prompt: "你好", Input: map[string]any{
		"mode": "audio", "prompt": "你好", "config": map[string]any{"channelId": "channel", "model": "gpt-4o-mini-tts", "audioVoice": "alloy"},
	}}
	if err := s.repo.UpdateDramaProduction(project, map[string]any{"budget_microcredits": 10}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.CreateTask(user, req); err == nil || !strings.Contains(err.Error(), "剩余预算不足") {
		t.Fatalf("25 microcredit order against a budget of 10: %v", err)
	}
	if err := s.repo.UpdateDramaProduction(project, map[string]any{"budget_microcredits": 25}); err != nil {
		t.Fatal(err)
	}
	task, err := s.CreateTask(user, req)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Model(task).Update("status", model.TaskStatusFailed).Error; err != nil {
		t.Fatal(err)
	}
	if err := s.repo.RefundBillingOrder(task.BillingOrderID, "failed"); err != nil {
		t.Fatal(err)
	}
	if err := s.repo.UpdateDramaProduction(project, map[string]any{"budget_microcredits": 10}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.RetryTask(user, task.ID); err == nil || !strings.Contains(err.Error(), "剩余预算不足") {
		t.Fatalf("over-budget retry: %v", err)
	}
	saved, err := s.repo.Task(task.ID)
	if err != nil || saved.Status != model.TaskStatusFailed || saved.BillingOrderID != task.BillingOrderID {
		t.Fatalf("rejected retry changed task: %+v, %v", saved, err)
	}
}

func TestDramaBudgetRejectsTokenSettlementSupplement(t *testing.T) {
	s, db, _ := shotMediaFixture(t)
	const project = "drama-project"
	if err := s.repo.UpdateDramaProduction(project, map[string]any{"budget_microcredits": 100}); err != nil {
		t.Fatal(err)
	}
	task := model.Task{ID: "token-task", UserID: "user", ProjectID: project, Type: "canvas_text", Status: model.TaskStatusSucceeded}
	order := model.BillingOrder{ID: "token-order", UserID: "user", TaskID: task.ID, IdempotencyKey: "token-order", Capability: "text", BillingMode: "token", OutputTokenPriceMicrocredits: 1_000_000, MultiplierBasisPoints: 10_000, AmountMicrocredits: 60, Status: model.BillingStatusRunning}
	if err := s.repo.CreateTaskWithCreditReservation(&task, &order, 8); err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.ApiCallLog{ID: "token-usage", BillingOrderID: order.ID, RequestKind: "generate", Billable: true, Status: model.ApiCallStatusSucceeded, UsageAvailable: true, OutputTokens: 120}).Error; err != nil {
		t.Fatal(err)
	}
	if err := s.repo.SettleBillingOrder(order.ID, ""); !errors.Is(err, repository.ErrDramaBudgetInsufficient) {
		t.Fatalf("token supplement should be blocked: %v", err)
	}
	saved, err := s.repo.BillingOrder(order.ID)
	if err != nil || saved.Status == model.BillingStatusSettled || saved.OutputTokens != 120 || saved.ReservedAmountMicrocredits != 60 {
		t.Fatalf("expected pending order and retained usage: %+v, %v", saved, err)
	}
	if err := s.repo.UpdateDramaProduction(project, map[string]any{"budget_microcredits": 120}); err != nil {
		t.Fatal(err)
	}
	if err := s.repo.SettleBillingOrder(order.ID, ""); err != nil {
		t.Fatal(err)
	}
	saved, err = s.repo.BillingOrder(order.ID)
	if err != nil || saved.Status != model.BillingStatusSettled || saved.ActualAmountMicrocredits != 120 {
		t.Fatalf("expected measured charge after top-up: %+v, %v", saved, err)
	}
}

func TestDramaBudgetPauseSkipsOutdatedBudget(t *testing.T) {
	s, _, _ := shotMediaFixture(t)
	const project = "drama-project"
	if err := s.repo.UpdateDramaProduction(project, map[string]any{"budget_microcredits": 10, "status": model.DramaStatusRunning}); err != nil {
		t.Fatal(err)
	}
	run := &dramaRun{s: s, production: mustDramaProduction(t, s, project)}
	_ = run.pauseForBudget()
	if err := s.repo.UpdateDramaProduction(project, map[string]any{"budget_microcredits": 100}); err != nil {
		t.Fatal(err)
	}
	if err := run.saveProgress(model.DramaStatusRunning, true); err != nil {
		t.Fatal(err)
	}
	current := mustDramaProduction(t, s, project)
	if current.Status != model.DramaStatusRunning || current.PauseReason != "" {
		t.Fatalf("outdated pause changed production: %+v", current)
	}
}

func TestDramaBudgetPausesAndResumesPromptCondensation(t *testing.T) {
	s, db, _ := shotMediaFixture(t)
	const user, project = "user", "drama-project"
	settings := DramaSettings{Models: DramaModels{Text: DramaModelChoice{ChannelID: "channel", ModelKey: "text-test"}}}
	if err := s.repo.UpdateDramaProduction(project, map[string]any{"budget_microcredits": 50, "status": model.DramaStatusRunning, "settings_json": encodeDramaSettings(settings)}); err != nil {
		t.Fatal(err)
	}
	result, err := json.Marshal(map[string]string{"text": strings.Repeat("镜头缓缓移动，主角穿过大厅。", 25)})
	if err != nil {
		t.Fatal(err)
	}
	payload, err := json.Marshal(dramaRevisionPayload{Revision: 1, MaxChars: 200})
	if err != nil {
		t.Fatal(err)
	}
	task := model.Task{ID: "overlong-segment-prompt", UserID: user, ProjectID: project, Type: "canvas_text", Status: model.TaskStatusSucceeded, ResultJSON: string(result)}
	segment := model.DramaSegment{ID: "segment-to-condense", ProjectID: project, EpisodeID: "episode", Revision: 1, PromptStatus: model.DramaMediaRunning}
	job := model.DramaJob{ID: "condense-job", ProjectID: project, EpisodeID: segment.EpisodeID, ShotID: segment.ID, TaskID: task.ID, Kind: model.DramaJobSegmentPrompt, Status: model.DramaJobRunning, PayloadJSON: string(payload)}
	for _, row := range []any{&task, &segment, &job} {
		if err := db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err := s.tickDrama(mustDramaProduction(t, s, project)); err != nil {
		t.Fatal(err)
	}
	paused := mustDramaProduction(t, s, project)
	pending, err := s.repo.DramaJob(project, job.ID)
	if err != nil || paused.Status != model.DramaStatusPaused || pending.Status != model.DramaJobRunning || pending.TaskID != task.ID || pending.PayloadJSON != string(payload) {
		t.Fatalf("budget pause must retain the original result and continuation: %+v, %+v, %v", paused, pending, err)
	}
	budget := int64(100)
	if _, err := s.UpdateDramaSettings(user, project, UpdateDramaSettingsRequest{BudgetMicrocredits: &budget}); err != nil {
		t.Fatal(err)
	}
	if err := s.tickDrama(mustDramaProduction(t, s, project)); err != nil {
		t.Fatal(err)
	}
	waiting, err := s.repo.DramaJob(project, job.ID)
	if err != nil || waiting.TaskID != task.ID || waiting.PayloadJSON != string(payload) || mustDramaProduction(t, s, project).Status != model.DramaStatusPaused {
		t.Fatalf("saving budget alone changed the paused continuation: %+v, %v", waiting, err)
	}
	if err := s.repo.UpdateDramaProduction(project, map[string]any{"status": model.DramaStatusRunning}); err != nil {
		t.Fatal(err)
	}
	resumed := &dramaRun{s: s, production: mustDramaProduction(t, s, project), project: &model.Project{ID: project, UserID: user}, settings: settings}
	for range 2 {
		if err := resumed.syncJobs(); err != nil {
			t.Fatal(err)
		}
	}
	completed, err := s.repo.DramaJob(project, job.ID)
	var tasks int64
	if countErr := db.Model(&model.Task{}).Where("project_id = ?", project).Count(&tasks).Error; countErr != nil {
		t.Fatal(countErr)
	}
	if err != nil || completed.TaskID == task.ID || completed.Status != model.DramaJobRunning || tasks != 2 {
		t.Fatalf("expected exactly one continuation of the original task: %+v, tasks=%d, %v", completed, tasks, err)
	}
}

func TestDramaDirectTextTaskRespectsProjectBudget(t *testing.T) {
	svc, fake := newDramaTestService(t)
	project := createTestDrama(t, svc, DramaReviewAuto).Project.ID
	if err := svc.repo.UpdateDramaProduction(project, map[string]any{"budget_microcredits": 100}); err != nil {
		t.Fatal(err)
	}
	if err := svc.ensureTaskProjectActive("usr-drama", project); err != nil {
		t.Fatal(err)
	}
	seedDramaBillingOrder(t, fake.db, project, "prompt-rewrite-held", model.BillingOrder{AmountMicrocredits: 100, Status: model.BillingStatusRunning})
	var appErr *AppError
	if err := svc.ensureTaskProjectActive("usr-drama", project); !errors.As(err, &appErr) || appErr.Reason != ReasonDramaBudget {
		t.Fatalf("direct task must honor budget: %v", err)
	}
}
