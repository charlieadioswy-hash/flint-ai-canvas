package database

import (
	"testing"
	"yingce/backend/internal/model"
)

func TestEcommerceRunLeaseMigrationFrom85PreservesRunAndReservation(t *testing.T) {
	db := schemaBranchFixture(t, "local", 85)
	var prior schemaMigration
	if err := db.First(&prior, "version = ?", 85).Error; err != nil {
		t.Fatal(err)
	}
	for _, row := range []any{
		&model.EcommerceAgentRun{ID: "old-run", UserID: "owner", IdempotencyKey: "old-key", ProjectID: "project", BillingOrderID: "old-bill", Status: "running", Mode: "live", PageCount: 2, UnitMicrocredits: 100, CanvasJSON: "{}"},
		&model.BillingOrder{ID: "old-bill", UserID: "owner", TaskID: "old-run", IdempotencyKey: "old-bill", Scene: "ecommerce_agent", Status: model.BillingStatusRunning, AmountMicrocredits: 200, ReservedAmountMicrocredits: 200},
		&model.CreditAccount{UserID: "owner", AvailableMicrocredits: 800, ReservedMicrocredits: 200},
	} {
		if err := db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	// Baseline migrations use today's model. Recreate the released v85 columns
	// so v86 must actually add the lease rather than merely record its version.
	if err := db.Migrator().DropIndex(&model.EcommerceAgentRun{}, "idx_ecommerce_agent_runs_lease_expires_at"); err != nil {
		t.Fatal(err)
	}
	for _, column := range []string{"lease_owner", "lease_expires_at"} {
		if err := db.Migrator().DropColumn(&model.EcommerceAgentRun{}, column); err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 2; i++ {
		if err := MigrateSchema(db); err != nil {
			t.Fatal(err)
		}
	}
	for _, column := range []string{"lease_owner", "lease_expires_at"} {
		if !db.Migrator().HasColumn(&model.EcommerceAgentRun{}, column) {
			t.Fatalf("missing %s", column)
		}
	}
	var run model.EcommerceAgentRun
	var bill model.BillingOrder
	var wallet model.CreditAccount
	if err := db.First(&run, "id = ?", "old-run").Error; err != nil {
		t.Fatal(err)
	}
	if err := db.First(&bill, "id = ?", "old-bill").Error; err != nil {
		t.Fatal(err)
	}
	if err := db.First(&wallet, "user_id = ?", "owner").Error; err != nil {
		t.Fatal(err)
	}
	if run.Status != "running" || run.LeaseOwner != "" || run.LeaseExpiresAt != nil || run.BillingOrderID != bill.ID || bill.Status != model.BillingStatusRunning || wallet.AvailableMicrocredits != 800 || wallet.ReservedMicrocredits != 200 {
		t.Fatalf("migration changed billing state: run=%+v bill=%+v wallet=%+v", run, bill, wallet)
	}
	var retained, added schemaMigration
	if err := db.First(&retained, "version = ?", 85).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.First(&added, "version = ?", 86).Error; err != nil {
		t.Fatal(err)
	}
	if retained.Name != prior.Name || retained.Checksum != prior.Checksum || !retained.AppliedAt.Equal(prior.AppliedAt) || added.Name != "ecommerce_agent_run_leases" {
		t.Fatalf("migration identity changed: old=%+v new=%+v added=%+v", prior, retained, added)
	}
}
