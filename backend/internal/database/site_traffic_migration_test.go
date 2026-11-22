package database

import (
	"reflect"
	"testing"
	"time"

	"yingce/backend/internal/model"

	"github.com/google/uuid"
	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
	_ "modernc.org/sqlite"
)

func TestSiteTrafficMigrationIsAdditiveAndPreservesPublishedLedger(t *testing.T) {
	t.Run("Flint v108", func(t *testing.T) {
		testSiteTrafficMigration(t, 108, false)
	})
	t.Run("upstream v99", func(t *testing.T) {
		testSiteTrafficMigration(t, 99, true)
	})
}

func testSiteTrafficMigration(t *testing.T, version int64, upstream bool) {
	t.Helper()
	db, err := gorm.Open(sqlite.Dialector{DriverName: "sqlite", DSN: ":memory:"}, &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	connection, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	connection.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = connection.Close() })
	if err := db.AutoMigrate(&schemaMigration{}); err != nil {
		t.Fatal(err)
	}
	if upstream {
		// Seed a published identity that distinguishes the upstream ledger.
		record := schemaMigration{Version: 78, Name: "drama_cast_voice_looks", Checksum: "sha256:drama-cast-voice-looks-v78-20261101", AppliedAt: time.Now().UTC()}
		if err := db.Create(&record).Error; err != nil {
			t.Fatal(err)
		}
	}
	plan, err := migrationsForDatabase(db)
	if err != nil {
		t.Fatal(err)
	}
	var migration migration
	for _, item := range plan {
		if item.version == version {
			migration = item
			break
		}
	}
	if migration.version != version || migration.name != "site_traffic_events" || migration.checksum != "sha256:site-traffic-events-v99-20261111" || migration.apply == nil {
		t.Fatalf("unexpected traffic migration: %+v", migration)
	}
	// 登记其他迁移身份，隔离验证流量迁移，不重跑无关业务转换。
	records := make([]schemaMigration, 0, len(plan)-1)
	for _, item := range plan {
		if item.version == migration.version || (upstream && item.version == 78) {
			continue
		}
		records = append(records, schemaMigration{
			Version: item.version, Name: item.name, Checksum: item.checksum,
			AppliedAt: time.Date(2026, 11, 10, 0, 0, 0, 0, time.UTC),
		})
	}
	if err := db.Create(&records).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Exec("CREATE TABLE traffic_unrelated (id TEXT PRIMARY KEY, value TEXT NOT NULL)").Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Exec("INSERT INTO traffic_unrelated (id, value) VALUES ('keep', 'unchanged')").Error; err != nil {
		t.Fatal(err)
	}
	var before []schemaMigration
	if err := db.Order("version").Find(&before).Error; err != nil {
		t.Fatal(err)
	}
	if db.Migrator().HasTable(&model.SiteTrafficEvent{}) {
		t.Fatal("previous schema fixture already contains traffic table")
	}
	for range 2 {
		if err := MigrateSchema(db); err != nil {
			t.Fatal(err)
		}
	}
	var after []schemaMigration
	if err := db.Order("version").Find(&after).Error; err != nil {
		t.Fatal(err)
	}
	preserved := make([]schemaMigration, 0, len(before))
	for _, record := range after {
		if record.Version != migration.version {
			preserved = append(preserved, record)
		}
	}
	if len(after) != len(before)+1 || !reflect.DeepEqual(preserved, before) {
		t.Fatal("traffic migration changed published migration identities or applied timestamps")
	}
	if !db.Migrator().HasTable(&model.SiteTrafficEvent{}) {
		t.Fatal("missing traffic table")
	}
	for _, index := range []string{"idx_site_traffic_received_at", "idx_site_traffic_type_received_at"} {
		if !db.Migrator().HasIndex(&model.SiteTrafficEvent{}, index) {
			t.Fatalf("missing traffic index %s", index)
		}
	}
	columns, err := db.Migrator().ColumnTypes(&model.SiteTrafficEvent{})
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]bool{"id": false, "visitor_hash": false, "session_hash": false, "received_at_epoch": false, "type": false, "page": false, "action": false}
	for _, column := range columns {
		if _, exists := want[column.Name()]; !exists {
			t.Fatalf("traffic table contains unexpected identifying/property column %s", column.Name())
		}
		want[column.Name()] = true
	}
	for column, found := range want {
		if !found {
			t.Fatalf("traffic table missing %s", column)
		}
	}
	var value string
	if err := db.Raw("SELECT value FROM traffic_unrelated WHERE id = 'keep'").Scan(&value).Error; err != nil || value != "unchanged" {
		t.Fatalf("unrelated data changed: %q, %v", value, err)
	}
	registered := 0
	for _, entity := range Models() {
		if _, ok := entity.(*model.SiteTrafficEvent); ok {
			registered++
		}
	}
	if registered != 1 {
		t.Fatalf("traffic Models registrations = %d", registered)
	}
	event := model.SiteTrafficEvent{ID: uuid.NewString(), VisitorHash: "visitor-digest", SessionHash: "session-digest", ReceivedAtEpoch: time.Now().Unix(), Type: "page_view", Page: "welcome"}
	if err := db.Create(&event).Error; err != nil {
		t.Fatal(err)
	}
	if err := migration.apply(db); err != nil {
		t.Fatal(err)
	}
	var saved model.SiteTrafficEvent
	if err := db.First(&saved, "id = ?", event.ID).Error; err != nil || !reflect.DeepEqual(saved, event) {
		t.Fatalf("repeat traffic DDL changed events: %+v, %v", saved, err)
	}
}
