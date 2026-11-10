package repository

import (
	"errors"
	"testing"
	"time"

	"yingce/backend/internal/database"
	"yingce/backend/internal/model"

	"gorm.io/gorm"
)

func TestDramaProductionWriteLockSerializesSQLiteInstances(t *testing.T) {
	directory := t.TempDir()
	open := func() (*Repository, *gorm.DB) {
		t.Helper()
		db, err := database.Open(database.Config{DataDir: directory})
		if err != nil {
			t.Fatal(err)
		}
		if err := database.ConfigurePool(db); err != nil {
			t.Fatal(err)
		}
		sqlDB, err := db.DB()
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = sqlDB.Close() })
		return New(db), db
	}
	first, db := open()
	second, _ := open()
	if err := db.AutoMigrate(&model.DramaProduction{}); err != nil {
		t.Fatal(err)
	}
	original := model.DramaProduction{ProjectID: "project", Revision: 7, GuideStep: model.DramaGuideStory}
	if err := db.Create(&original).Error; err != nil {
		t.Fatal(err)
	}

	locked, release := make(chan struct{}), make(chan struct{})
	firstDone, secondDone := make(chan error, 1), make(chan error, 1)
	go func() {
		firstDone <- first.Transaction(func(tx *Repository) error {
			row, err := tx.DramaProductionForUpdate(original.ProjectID)
			if err != nil {
				return err
			}
			close(locked)
			<-release
			return tx.UpdateDramaGuideIf(row.ProjectID, row.Revision, row.GuideStep, map[string]any{})
		})
	}()
	select {
	case <-locked:
	case err := <-firstDone:
		t.Fatalf("first transaction: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("first transaction did not acquire the production")
	}
	go func() {
		secondDone <- second.Transaction(func(tx *Repository) error {
			row, err := tx.DramaProductionForUpdate(original.ProjectID)
			if err != nil {
				return err
			}
			return tx.UpdateDramaGuideIf(row.ProjectID, row.Revision, row.GuideStep, map[string]any{})
		})
	}()
	var premature bool
	select {
	case err := <-secondDone:
		premature = true
		t.Errorf("competing writer escaped the production lock: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	close(release)
	if err := <-firstDone; err != nil {
		t.Fatalf("first transaction must not fail upgrading its read snapshot: %v", err)
	}
	if !premature {
		if err := <-secondDone; err != nil {
			t.Fatalf("competing transaction must wait and commit: %v", err)
		}
	}
	row, err := first.DramaProduction(original.ProjectID)
	if err != nil || row.Revision != 9 {
		t.Fatalf("both independent instances must advance the latest revision exactly once: row=%+v err=%v", row, err)
	}
	if err := first.Transaction(func(tx *Repository) error {
		_, err := tx.DramaProductionForUpdate("missing")
		return err
	}); !errors.Is(err, gorm.ErrRecordNotFound) {
		t.Fatalf("missing production must keep not-found semantics: %v", err)
	}
}
