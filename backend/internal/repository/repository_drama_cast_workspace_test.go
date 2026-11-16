package repository

import (
	"fmt"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
	"yingce/backend/internal/model"
)

func TestDramaCastWorkspaceLockProtectsCheckedRevisionPostgres(t *testing.T) {
	dsn := os.Getenv("CANVAS_TEST_POSTGRES_DSN")
	if dsn == "" {
		t.Skip("set CANVAS_TEST_POSTGRES_DSN to an isolated test database")
	}
	config := &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)}
	admin, err := gorm.Open(postgres.Open(dsn), config)
	if err != nil {
		t.Fatal(err)
	}
	connection, _ := admin.DB()
	t.Cleanup(func() { _ = connection.Close() })
	schema := fmt.Sprintf("cast_workspace_%d", time.Now().UnixNano())
	if err := admin.Exec("CREATE SCHEMA " + schema).Error; err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = admin.Exec("DROP SCHEMA " + schema + " CASCADE").Error })
	parsed, err := url.Parse(dsn)
	if err != nil {
		t.Fatal(err)
	}
	query := parsed.Query()
	query.Set("search_path", schema)
	parsed.RawQuery = query.Encode()
	db, err := gorm.Open(postgres.Open(parsed.String()), config)
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, _ := db.DB()
	t.Cleanup(func() { _ = sqlDB.Close() })
	if err := db.AutoMigrate(&model.DramaCast{}); err != nil {
		t.Fatal(err)
	}
	cast := model.DramaCast{ID: "cast", ProjectID: "project", Kind: "character", Name: "旧版本", Revision: 1}
	if err := db.Create(&cast).Error; err != nil {
		t.Fatal(err)
	}
	repo := New(db)
	locked := make(chan struct{})
	release := make(chan struct{})
	saved := make(chan error, 1)
	go func() {
		saved <- repo.Transaction(func(tx *Repository) error {
			current, err := tx.DramaCastForUpdate("project", "cast")
			if err != nil {
				close(locked)
				return err
			}
			close(locked)
			<-release
			applied, err := tx.UpdateDramaCastRevision("cast", current.Revision, map[string]any{"name": "工作区版本", "revision": current.Revision + 1})
			if err == nil && !applied {
				return fmt.Errorf("checked revision changed before workspace write")
			}
			return err
		})
	}()
	<-locked
	blocked := db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Exec("SET LOCAL lock_timeout = '100ms'").Error; err != nil {
			return err
		}
		return tx.Model(&model.DramaCast{}).Where("id = ?", "cast").Update("image_status", model.DramaMediaQueued).Error
	})
	close(release)
	if err := <-saved; err != nil {
		t.Fatal(err)
	}
	if blocked == nil || !strings.Contains(blocked.Error(), "lock timeout") {
		t.Fatalf("concurrent media update crossed checked cast revision: %v", blocked)
	}
	current, err := repo.DramaCast("project", "cast")
	if err != nil || current.Name != "工作区版本" || current.ImageStatus == model.DramaMediaQueued {
		t.Fatalf("unexpected stored cast: %+v %v", current, err)
	}
}
