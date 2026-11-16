package app

import (
	"testing"

	"yingce/backend/internal/model"

	"gorm.io/gorm"
)

func TestDramaSettingsVersionedSaveUsesCurrentRevision(t *testing.T) {
	for _, step := range []string{"", model.DramaGuideConfiguring, model.DramaGuideCompleted} {
		t.Run("step-"+step, func(t *testing.T) {
			fixture := newDramaGuideRevisionFixture(t, step)
			projectID, revision := fixture.summary.Project.ID, fixture.summary.Production.Revision
			settings := fixture.summary.Production.Settings
			settings.Language = "英语"
			updated, err := fixture.svc.UpdateDramaSettings("usr-drama", projectID, UpdateDramaSettingsRequest{ExpectedRevision: &revision, Settings: &settings})
			if err != nil || updated.Production.Settings.Language != settings.Language || updated.Production.Revision != revision+1 || updated.Production.GuideStep != step {
				t.Fatalf("versioned settings save = %+v, %v", updated, err)
			}
			settings.Language = "过期语言"
			budget := int64(100)
			_, err = fixture.svc.UpdateDramaSettings("usr-drama", projectID, UpdateDramaSettingsRequest{ExpectedRevision: &revision, Settings: &settings, BudgetMicrocredits: &budget})
			requireGuideConflict(t, err)
			stored, err := fixture.svc.repo.DramaProduction(projectID)
			if err != nil || stored.Revision != revision+1 || parseDramaSettings(stored.SettingsJSON).Language != "英语" || stored.BudgetMicrocredits != fixture.summary.Production.BudgetMicrocredits {
				t.Fatalf("stale settings or budget overwrote the current snapshot: %+v, %v", stored, err)
			}
			if len(fixture.fake.requests) != 0 {
				t.Fatal("saving settings must not submit generation")
			}
		})
	}
}

func TestDramaSettingsVersionedSaveRechecksRevisionInsideTransaction(t *testing.T) {
	for _, step := range []string{"", model.DramaGuideConfiguring, model.DramaGuideCompleted} {
		t.Run("step-"+step, func(t *testing.T) {
			fixture := newDramaGuideRevisionFixture(t, step)
			projectID, revision := fixture.summary.Project.ID, fixture.summary.Production.Revision
			remote := fixture.summary.Production.Settings
			remote.Language = "另一页面保存的配置"
			changed := false
			callback := "test:change-settings-before-lock"
			if err := fixture.fake.db.Callback().Query().After("gorm:query").Register(callback, func(tx *gorm.DB) {
				if changed || tx.Statement.Table != "drama_productions" {
					return
				}
				changed = true
				if err := fixture.svc.repo.UpdateDramaProduction(projectID, map[string]any{"settings_json": encodeDramaSettings(remote)}); err != nil {
					t.Fatal(err)
				}
			}); err != nil {
				t.Fatal(err)
			}
			defer fixture.fake.db.Callback().Query().Remove(callback)
			local := fixture.summary.Production.Settings
			local.Language = "旧页面的自动保存"
			_, err := fixture.svc.UpdateDramaSettings("usr-drama", projectID, UpdateDramaSettingsRequest{ExpectedRevision: &revision, Settings: &local})
			requireGuideConflict(t, err)
			stored, err := fixture.svc.repo.DramaProduction(projectID)
			if err != nil || !changed || stored.Revision != revision+1 || parseDramaSettings(stored.SettingsJSON).Language != remote.Language {
				t.Fatalf("late settings write overwrote the concurrent save: %+v, changed=%v, error=%v", stored, changed, err)
			}
		})
	}
}

func TestDramaSettingsVersionedSaveKeepsActiveGuideGateAndBudget(t *testing.T) {
	for _, step := range []string{model.DramaGuideAssets, model.DramaGuideStory} {
		t.Run(step, func(t *testing.T) {
			fixture := newDramaGuideRevisionFixture(t, step)
			projectID, revision := fixture.summary.Project.ID, fixture.summary.Production.Revision
			settings := fixture.summary.Production.Settings
			settings.Language = "不应绕过当前步骤"
			if _, err := fixture.svc.UpdateDramaSettings("usr-drama", projectID, UpdateDramaSettingsRequest{ExpectedRevision: &revision, Settings: &settings}); err == nil {
				t.Fatal("full settings update bypassed the active guide")
			}
			budget := int64(200)
			updated, err := fixture.svc.UpdateDramaSettings("usr-drama", projectID, UpdateDramaSettingsRequest{BudgetMicrocredits: &budget})
			if err != nil || updated.Production.BudgetMicrocredits != budget || updated.Production.Revision != revision+1 || updated.Production.Settings.Language != fixture.summary.Production.Settings.Language {
				t.Fatalf("budget-only behavior changed: %+v, %v", updated, err)
			}
		})
	}
}
