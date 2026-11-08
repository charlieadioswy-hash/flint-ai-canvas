package repository

import (
	"errors"
	"fmt"
	"testing"
	"time"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	_ "modernc.org/sqlite"
	"yingce/backend/internal/model"
)

func ecommerceAgentTestRepository(t *testing.T) *Repository {
	t.Helper()
	db, err := gorm.Open(sqlite.Dialector{DriverName: "sqlite", DSN: "file:" + t.Name() + "?mode=memory&cache=shared"}, &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err = db.AutoMigrate(&model.CreditAccount{}, &model.CreditLedgerEntry{}, &model.BillingOrder{}, &model.EcommerceProject{}, &model.EcommerceAgentRun{}, &model.EcommerceAgentPage{}, &model.EcommerceAgentCanvasVersion{}); err != nil {
		t.Fatal(err)
	}
	if err = db.Create(&model.CreditAccount{UserID: "owner", AvailableMicrocredits: 1_000_000}).Error; err != nil {
		t.Fatal(err)
	}
	return New(db)
}

func TestEcommerceAgentExpiredRunRecoveryAndLeaseFencing(t *testing.T) {
	for _, scenario := range []string{"unstarted", "partial", "submitted", "cancelled", "active", "legacy-live", "recent-legacy", "cancelled-legacy"} {
		t.Run(scenario, func(t *testing.T) {
			repo := ecommerceAgentTestRepository(t)
			now := time.Now()
			expires := now.Add(-time.Minute)
			if scenario == "active" {
				expires = now.Add(time.Minute)
			}
			run := &model.EcommerceAgentRun{ID: "run", UserID: "owner", IdempotencyKey: "key", ProjectID: "project", BillingOrderID: "order", Status: "running", Mode: "live", PageCount: 2, UnitMicrocredits: 100, LeaseOwner: "dead-backend", LeaseExpiresAt: &expires, CancelRequested: scenario == "cancelled"}
			if scenario == "legacy-live" || scenario == "recent-legacy" || scenario == "cancelled-legacy" {
				run.LeaseOwner, run.LeaseExpiresAt = "", nil
				if scenario == "legacy-live" {
					run.UpdatedAt = now.Add(-16 * time.Minute)
				}
			}
			project := &model.EcommerceProject{ID: "project", UserID: "owner", Name: "商品", DraftJSON: "{}", PlanJSON: "{}"}
			order := &model.BillingOrder{ID: "order", UserID: "owner", TaskID: run.ID, IdempotencyKey: "order", Scene: "ecommerce_agent", Model: "image", Capability: "image", BillingMode: "fixed_request", UnitPriceMicrocredits: 100, Quantity: 2, AmountMicrocredits: 200, ReservedAmountMicrocredits: 200, Status: model.BillingStatusReserved}
			if err := repo.CreateEcommerceAgentRun(run, project, order); err != nil {
				t.Fatal(err)
			}
			if scenario == "cancelled-legacy" {
				if err := repo.RequestEcommerceAgentCancel("owner", run.ID); err != nil {
					t.Fatal(err)
				}
			}
			if scenario == "partial" {
				if err := repo.SaveEcommerceAgentPage("owner", &model.EcommerceAgentPage{ID: "page", RunID: run.ID, Index: 1, Status: "completed", URL: "/api/resources/result/file"}); err != nil {
					t.Fatal(err)
				}
			}
			if scenario == "submitted" {
				if err := repo.SaveEcommerceAgentPage("owner", &model.EcommerceAgentPage{ID: "page", RunID: run.ID, Index: 1, Status: "submitted"}); err != nil {
					t.Fatal(err)
				}
			}
			candidates, err := repo.ExpiredEcommerceAgentRuns(now, 10)
			if err != nil {
				t.Fatal(err)
			}
			wantCandidates := 1
			if scenario == "active" || scenario == "recent-legacy" {
				wantCandidates = 0
			}
			if len(candidates) != wantCandidates {
				t.Fatalf("incorrect recovery scan: %+v", candidates)
			}
			if err := repo.RecoverExpiredEcommerceAgentRun("owner", run.ID, now); err != nil {
				t.Fatal(err)
			}
			stored, err := repo.EcommerceAgentRun("owner", run.ID)
			if err != nil {
				t.Fatal(err)
			}
			bill, _ := repo.BillingOrder(order.ID)
			wallet, _ := repo.CreditAccount("owner")
			status, billStatus, available, reserved := "failed", model.BillingStatusRefunded, int64(1_000_000), int64(0)
			switch scenario {
			case "partial":
				billStatus, available = model.BillingStatusSettled, 999900
			case "submitted", "legacy-live", "cancelled-legacy":
				status, billStatus, available, reserved = "uncertain", model.BillingStatusUncertain, 999800, 200
			case "cancelled":
				status = "cancelled"
			case "active", "recent-legacy":
				status, billStatus, available, reserved = "running", model.BillingStatusReserved, 999800, 200
			}
			if stored.Status != status || bill.Status != billStatus || wallet.AvailableMicrocredits != available || wallet.ReservedMicrocredits != reserved {
				t.Fatalf("run=%+v bill=%+v wallet=%+v", stored, bill, wallet)
			}
			if scenario == "active" {
				if ok, err := repo.RenewEcommerceAgentLease("owner", run.ID, run.LeaseOwner, now, 2*time.Minute); err != nil || !ok {
					t.Fatalf("healthy lease was lost: %v", err)
				}
				if err := repo.RecoverExpiredEcommerceAgentRun("owner", run.ID, now.Add(90*time.Second)); err != nil {
					t.Fatal(err)
				}
				stored, _ = repo.EcommerceAgentRun("owner", run.ID)
				if stored.Status != "running" {
					t.Fatal("renewed run recovered from stale snapshot")
				}
			} else {
				if err := repo.SaveEcommerceAgentPage("owner", &model.EcommerceAgentPage{ID: "late", RunID: run.ID, Index: 2, Status: "completed"}, "dead-backend"); !errors.Is(err, ErrTaskStateConflict) {
					t.Fatalf("stale worker wrote after recovery: %v", err)
				}
				if ok, err := repo.RenewEcommerceAgentLease("owner", run.ID, "dead-backend", now, time.Minute); err != nil || ok {
					t.Fatalf("stale worker renewed recovered run: %v", err)
				}
				if err := repo.RecoverExpiredEcommerceAgentRun("owner", run.ID, now); err != nil {
					t.Fatal(err)
				}
				wallet, _ = repo.CreditAccount("owner")
				if wallet.AvailableMicrocredits != available || wallet.ReservedMicrocredits != reserved {
					t.Fatal("duplicate recovery changed balance")
				}
			}
		})
	}
}

func TestEcommerceAgentUncertainBillRequiresManualReview(t *testing.T) {
	repo := ecommerceAgentTestRepository(t)
	if err := repo.db.AutoMigrate(&model.Task{}); err != nil {
		t.Fatal(err)
	}
	for _, order := range []model.BillingOrder{
		{ID: "uncertain-ecommerce", UserID: "owner", TaskID: "failed-ecommerce", IdempotencyKey: "uncertain-ecommerce", Scene: "ecommerce_agent", Status: model.BillingStatusUncertain},
		{ID: "uncertain-canvas", UserID: "owner", TaskID: "failed-canvas", IdempotencyKey: "uncertain-canvas", Scene: "canvas", Status: model.BillingStatusUncertain},
	} {
		if err := repo.db.Create(&order).Error; err != nil {
			t.Fatal(err)
		}
		if err := repo.db.Create(&model.Task{ID: order.TaskID, UserID: order.UserID, BillingOrderID: order.ID, Status: model.TaskStatusFailed}).Error; err != nil {
			t.Fatal(err)
		}
	}
	orders, err := repo.AutoRefundableBillingOrders(10, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(orders) != 1 || orders[0].ID != "uncertain-canvas" {
		t.Fatalf("only the failed canvas order may be automatically refunded: %+v", orders)
	}
}

func TestLatestEcommerceAgentRunByProjectIsOwnerScoped(t *testing.T) {
	repo := ecommerceAgentTestRepository(t)
	for _, run := range []model.EcommerceAgentRun{
		{ID: "older", UserID: "owner", ProjectID: "project", IdempotencyKey: "older", Status: "completed", CreatedAt: time.Now().Add(-time.Hour)},
		{ID: "latest", UserID: "owner", ProjectID: "project", IdempotencyKey: "latest", Status: "completed", CreatedAt: time.Now()},
		{ID: "other-project", UserID: "owner", ProjectID: "elsewhere", IdempotencyKey: "elsewhere", Status: "completed", CreatedAt: time.Now().Add(time.Hour)},
	} {
		if err := repo.db.Create(&run).Error; err != nil {
			t.Fatal(err)
		}
	}
	latest, err := repo.LatestEcommerceAgentRunByProject("owner", "project")
	if err != nil || latest.ID != "latest" {
		t.Fatalf("latest=%+v err=%v", latest, err)
	}
	if _, err := repo.LatestEcommerceAgentRunByProject("another-user", "project"); !errors.Is(err, gorm.ErrRecordNotFound) {
		t.Fatalf("cross-account project read: %v", err)
	}
}

func TestEcommerceAgentReservationPartialSettlementAndIdempotency(t *testing.T) {
	repo := ecommerceAgentTestRepository(t)
	run := &model.EcommerceAgentRun{ID: "run-1", UserID: "owner", IdempotencyKey: "same", ProjectID: "project-1", BillingOrderID: "order-1", Status: "running", Mode: "mock", PageCount: 10, UnitMicrocredits: 32_000}
	project := &model.EcommerceProject{ID: "project-1", UserID: "owner", Name: "商品", Status: "draft", DraftJSON: "{}", PlanJSON: "{}", Revision: 1}
	order := &model.BillingOrder{ID: "order-1", UserID: "owner", TaskID: run.ID, IdempotencyKey: "ecommerce:same", Scene: "ecommerce_agent", Model: "mock", Capability: "image", BillingMode: "fixed_request", UnitPriceMicrocredits: 32_000, Quantity: 10, AmountMicrocredits: 320_000, ReservedAmountMicrocredits: 320_000, Status: model.BillingStatusReserved}
	if err := repo.CreateEcommerceAgentRun(run, project, order); err != nil {
		t.Fatal(err)
	}
	account, err := repo.CreditAccount("owner")
	if err != nil {
		t.Fatal(err)
	}
	if account.AvailableMicrocredits != 680_000 || account.ReservedMicrocredits != 320_000 {
		t.Fatalf("reservation=%+v", account)
	}
	for i := 1; i <= 3; i++ {
		if err := repo.SaveEcommerceAgentPage("owner", &model.EcommerceAgentPage{ID: fmt.Sprintf("page-%d", i), RunID: run.ID, Index: i, Status: "completed", URL: "data:image/svg+xml,..."}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := repo.FinishEcommerceAgentRun("owner", run.ID, "completed", ""); err != nil {
		t.Fatal(err)
	}
	account, err = repo.CreditAccount("owner")
	if err != nil {
		t.Fatal(err)
	}
	if account.AvailableMicrocredits != 904_000 || account.ReservedMicrocredits != 0 {
		t.Fatalf("settled account=%+v", account)
	}
	settled, err := repo.BillingOrder(order.ID)
	if err != nil {
		t.Fatal(err)
	}
	if settled.Status != model.BillingStatusSettled || settled.ActualAmountMicrocredits != 96_000 || settled.RefundedAmountMicrocredits != 224_000 {
		t.Fatalf("settled order=%+v", settled)
	}
	if _, err := repo.FinishEcommerceAgentRun("owner", run.ID, "completed", ""); err != nil {
		t.Fatal(err)
	}
	account, _ = repo.CreditAccount("owner")
	if account.AvailableMicrocredits != 904_000 {
		t.Fatal("duplicate settlement changed balance")
	}
	duplicate := *run
	duplicate.ID = "run-2"
	duplicate.BillingOrderID = "order-2"
	if err := repo.CreateEcommerceAgentRun(&duplicate, nil, nil); err == nil {
		t.Fatal("duplicate idempotency key accepted")
	}
	account, _ = repo.CreditAccount("owner")
	if account.AvailableMicrocredits != 904_000 {
		t.Fatal("duplicate request changed balance")
	}
	if _, err := repo.EcommerceAgentRun("other", run.ID); !errors.Is(err, gorm.ErrRecordNotFound) {
		t.Fatalf("other user read run: %v", err)
	}
}

func TestEcommerceAgentZeroSuccessRefundsFullReservation(t *testing.T) {
	repo := ecommerceAgentTestRepository(t)
	run := &model.EcommerceAgentRun{ID: "run-3", UserID: "owner", IdempotencyKey: "zero", ProjectID: "project-3", BillingOrderID: "order-3", Status: "running", PageCount: 5, UnitMicrocredits: 32_000}
	project := &model.EcommerceProject{ID: "project-3", UserID: "owner", Name: "商品", Status: "draft", DraftJSON: "{}", PlanJSON: "{}", Revision: 1}
	order := &model.BillingOrder{ID: "order-3", UserID: "owner", TaskID: run.ID, IdempotencyKey: "ecommerce:zero", Scene: "ecommerce_agent", BillingMode: "fixed_request", AmountMicrocredits: 160_000, ReservedAmountMicrocredits: 160_000, Status: model.BillingStatusReserved}
	if err := repo.CreateEcommerceAgentRun(run, project, order); err != nil {
		t.Fatal(err)
	}
	if _, err := repo.FinishEcommerceAgentRun("owner", run.ID, "cancelled", "CANCELLED"); err != nil {
		t.Fatal(err)
	}
	account, _ := repo.CreditAccount("owner")
	if account.AvailableMicrocredits != 1_000_000 || account.ReservedMicrocredits != 0 {
		t.Fatalf("refund account=%+v", account)
	}
	refunded, _ := repo.BillingOrder(order.ID)
	if refunded.Status != model.BillingStatusRefunded {
		t.Fatalf("order=%+v", refunded)
	}
}
