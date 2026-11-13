package app

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"yingce/backend/internal/model"
)

func newDramaExtractionSource(t *testing.T, step, status string) (*Service, *fakeDramaBackend, DramaSummary) {
	t.Helper()
	svc, fake := newDramaTestService(t)
	summary := createGuidedDrama(t, svc, DramaChapterInput{Title: "第一集", Text: "范围外甲：萧炎在家。"}, DramaChapterInput{Title: "第二集", Text: "选中乙：纳兰嫣然来到大厅退婚。"}, DramaChapterInput{Title: "预留集", Text: "预留丙：不属于本次制作。"})
	if err := fake.db.Model(&model.DramaProduction{}).Where("project_id = ?", summary.Project.ID).Updates(map[string]any{
		"guide_step": step, "stage": model.DramaStageProduce, "status": status, "bible_json": `{"logline":"保留全局设定","tone":"冷静"}`,
	}).Error; err != nil {
		t.Fatal(err)
	}
	chapters, err := svc.repo.DramaChapters(summary.Project.ID)
	if err != nil || len(chapters) != 3 {
		t.Fatalf("chapters: %+v %v", chapters, err)
	}
	if err := fake.db.Model(&model.ProjectUnit{}).Where("id = ?", chapters[2].ID).Update("status", model.ProjectUnitStatusReserved).Error; err != nil {
		t.Fatal(err)
	}
	return svc, fake, summary
}

func TestDramaAssetExtractionScopesAndPreservesExistingAssets(t *testing.T) {
	for _, kind := range []string{"character", "scene", "prop"} {
		t.Run(kind, func(t *testing.T) {
			svc, fake, source := newDramaExtractionSource(t, model.DramaGuideAssets, model.DramaStatusPaused)
			projectID := source.Project.ID
			name := map[string]string{"character": "炎帝", "scene": "萧家大厅", "prop": "退婚书"}[kind]
			manual := model.DramaCast{ID: newID(), ProjectID: projectID, Kind: kind, Name: name, AliasesJSON: `["萧炎"]`, Description: "人工定义，不能覆盖", Appearance: "人工外观", ImageResourceID: "keep-image", ImageStatus: model.DramaMediaReady, Revision: 7}
			other := model.DramaCast{ID: newID(), ProjectID: projectID, Kind: "scene", Name: "人工保留场景", Description: "未出现在本次结果也应保留", Revision: 2}
			for _, row := range []any{&manual, &other, &model.DramaTake{ID: newID(), ProjectID: projectID, OwnerID: manual.ID, Kind: "cast", ResourceID: "keep-image", Version: 1}} {
				if err := fake.db.Create(row).Error; err != nil {
					t.Fatal(err)
				}
			}
			before, _ := svc.repo.DramaCast(projectID, manual.ID)
			productionBefore, _ := svc.repo.DramaProduction(projectID)
			result, err := svc.ExtractDramaAssets("usr-drama", projectID, ExtractDramaAssetsRequest{ExpectedRevision: source.Production.Revision, Kind: kind, EpisodeIDs: []string{source.Episodes[1].ID}})
			if err != nil {
				t.Fatal(err)
			}
			if result.Revision != source.Production.Revision+1 || result.Job.AssetKind != kind || len(result.Job.SourceChapterIDs) != 1 || !reflect.DeepEqual(result.Job.SourceEpisodeIDs, []string{source.Episodes[1].ID}) {
				t.Fatalf("job must expose exact kind and scope: %+v", result)
			}
			pending, err := svc.repo.RunningDramaProductions(100)
			if err != nil || len(pending) != 1 || pending[0].ProjectID != projectID {
				t.Fatalf("paused project with explicit scope work must be scheduled: %+v %v", pending, err)
			}
			runDramaTicks(t, svc, projectID, 2)
			if len(fake.requests) != 1 || fake.byKind["bible"] != 1 || !strings.Contains(fake.requests[0].Prompt, "选中乙") || strings.Contains(fake.requests[0].Prompt, "范围外甲") || strings.Contains(fake.requests[0].Prompt, "预留丙") {
				t.Fatalf("only selected source may reach the shared Bible model: %+v", fake.requests)
			}
			job, _ := svc.repo.DramaJob(projectID, result.Job.ID)
			if job.Status != model.DramaJobSucceeded {
				t.Fatalf("scoped extraction failed: %+v", job)
			}
			after, _ := svc.repo.DramaCast(projectID, manual.ID)
			if !reflect.DeepEqual(before, after) {
				t.Fatalf("existing manual definition/image must remain unchanged: before=%+v after=%+v", before, after)
			}
			var takes int64
			if err := fake.db.Model(&model.DramaTake{}).Where("owner_id = ?", manual.ID).Count(&takes).Error; err != nil || takes != 1 {
				t.Fatalf("image history must remain: %d %v", takes, err)
			}
			casts, err := svc.repo.DramaCasts(projectID)
			if err != nil {
				t.Fatal(err)
			}
			for _, cast := range casts {
				if cast.ID == manual.ID || cast.ID == other.ID {
					continue
				}
				if cast.Kind != kind || cast.ImageStatus != model.DramaMediaDraft || cast.ImageResourceID != "" {
					t.Fatalf("only missing requested-kind text assets may be added: %+v", cast)
				}
			}
			if kind == "character" && len(casts) != 3 || kind != "character" && len(casts) != 2 {
				t.Fatalf("must dedupe same name/alias and retain unrelated assets: %+v", casts)
			}
			productionAfter, _ := svc.repo.DramaProduction(projectID)
			if productionAfter.Status != productionBefore.Status || productionAfter.Stage != productionBefore.Stage || productionAfter.BibleJSON != productionBefore.BibleJSON || productionAfter.GuideStep != productionBefore.GuideStep || productionAfter.Revision != result.Revision+1 {
				t.Fatalf("scope result must not advance the global workflow: before=%+v after=%+v", productionBefore, productionAfter)
			}
			// 同一范围重新查漏不会创建第二套资产，也不会启动图片、分镜或视频。
			_, err = svc.ExtractDramaAssets("usr-drama", projectID, ExtractDramaAssetsRequest{ExpectedRevision: productionAfter.Revision, Kind: kind, EpisodeIDs: []string{source.Episodes[1].ID}})
			if err != nil {
				t.Fatal(err)
			}
			runDramaTicks(t, svc, projectID, 2)
			again, _ := svc.repo.DramaCasts(projectID)
			if len(again) != len(casts) || len(fake.requests) != 2 || fake.byKind["image"] != 0 || fake.byKind["script"] != 0 || fake.byKind["video"] != 0 {
				t.Fatalf("repeat is incremental text only: casts=%+v requests=%v", again, fake.byKind)
			}
		})
	}
}

func TestDramaAssetExtractionRejectsUnavailableOrInvalidScopes(t *testing.T) {
	svc, fake, source := newDramaExtractionSource(t, model.DramaGuideCompleted, model.DramaStatusCompleted)
	chapters, _ := svc.repo.DramaGuideSourceChapters(source.Project.ID)
	valid := ExtractDramaAssetsRequest{ExpectedRevision: source.Production.Revision, Kind: "scene"}
	for _, tc := range []struct {
		name string
		req  ExtractDramaAssetsRequest
	}{
		{"unknown-kind", ExtractDramaAssetsRequest{ExpectedRevision: valid.ExpectedRevision, Kind: "asset"}},
		{"stale-revision", ExtractDramaAssetsRequest{ExpectedRevision: valid.ExpectedRevision - 1, Kind: "scene"}},
		{"empty-episodes", ExtractDramaAssetsRequest{ExpectedRevision: valid.ExpectedRevision, Kind: "scene", EpisodeIDs: []string{}}},
		{"empty-chapters", ExtractDramaAssetsRequest{ExpectedRevision: valid.ExpectedRevision, Kind: "scene", ChapterIDs: []string{}}},
		{"both-scopes", ExtractDramaAssetsRequest{ExpectedRevision: valid.ExpectedRevision, Kind: "scene", EpisodeIDs: []string{source.Episodes[0].ID}, ChapterIDs: []string{chapters[0].ID}}},
		{"reserved-chapter", ExtractDramaAssetsRequest{ExpectedRevision: valid.ExpectedRevision, Kind: "scene", ChapterIDs: []string{chapters[2].ID}}},
		{"reserved-episode", ExtractDramaAssetsRequest{ExpectedRevision: valid.ExpectedRevision, Kind: "scene", EpisodeIDs: []string{source.Episodes[2].ID}}},
		{"foreign-episode", ExtractDramaAssetsRequest{ExpectedRevision: valid.ExpectedRevision, Kind: "scene", EpisodeIDs: []string{"foreign-episode"}}},
		{"foreign-chapter", ExtractDramaAssetsRequest{ExpectedRevision: valid.ExpectedRevision, Kind: "scene", ChapterIDs: []string{"foreign-chapter"}}},
		{"duplicate-episodes", ExtractDramaAssetsRequest{ExpectedRevision: valid.ExpectedRevision, Kind: "scene", EpisodeIDs: []string{source.Episodes[0].ID, source.Episodes[0].ID}}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := svc.ExtractDramaAssets("usr-drama", source.Project.ID, tc.req); err == nil {
				t.Fatalf("accepted invalid extraction scope: %+v", tc.req)
			}
		})
	}
	if _, err := svc.ExtractDramaAssets("other-user", source.Project.ID, valid); err == nil {
		t.Fatal("must reject another user's project")
	}
	var count int64
	if err := fake.db.Model(&model.DramaJob{}).Where("project_id = ?", source.Project.ID).Count(&count).Error; err != nil || count != 0 {
		t.Fatalf("rejected scopes must not queue work: %d %v", count, err)
	}
	p, _ := svc.repo.DramaProduction(source.Project.ID)
	if p.Revision != valid.ExpectedRevision || p.Status != model.DramaStatusCompleted || len(fake.requests) != 0 {
		t.Fatalf("rejected request changed production: %+v", p)
	}
	result, err := svc.ExtractDramaAssets("usr-drama", source.Project.ID, valid)
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Job.SourceChapterIDs) != 2 || len(result.Job.SourceEpisodeIDs) != 0 {
		t.Fatalf("omitted range must snapshot current selected chapters: %+v", result)
	}
	_, err = svc.ExtractDramaAssets("usr-drama", source.Project.ID, ExtractDramaAssetsRequest{ExpectedRevision: result.Revision, Kind: "character"})
	requireGuideConflict(t, err)
	runDramaTicks(t, svc, source.Project.ID, 2)
	p, _ = svc.repo.DramaProduction(source.Project.ID)
	if p.Status != model.DramaStatusCompleted || p.GuideStep != model.DramaGuideCompleted || p.Revision != result.Revision+1 {
		t.Fatalf("completed production must stay completed: %+v", p)
	}
}

func TestDramaAssetExtractionRetryRetainsScopeAndDoesNotCompleteInitialBible(t *testing.T) {
	svc, fake, source := newDramaExtractionSource(t, model.DramaGuideAssets, model.DramaStatusPaused)
	chapters, _ := svc.repo.DramaChapters(source.Project.ID)
	payload, _ := json.Marshal(dramaAssetExtractionPayload{Scope: dramaAssetExtractionScope, AssetKind: "scene", SourceChapterIDs: []string{chapters[1].ID}, SourceEpisodeIDs: []string{source.Episodes[1].ID}})
	raw, _ := json.Marshal(map[string]string{"text": `{"scenes":[{"name":"截断`})
	task := model.Task{ID: newID(), UserID: "usr-drama", ProjectID: source.Project.ID, Type: "canvas_text", Status: model.TaskStatusSucceeded, ResultJSON: string(raw)}
	job := model.DramaJob{ID: newID(), ProjectID: source.Project.ID, Kind: model.DramaJobBible, Status: model.DramaJobFailed, TaskID: task.ID, PayloadJSON: string(payload), Error: "作品圣经解析失败：模型没有返回可解析的 JSON"}
	for _, row := range []any{&task, &job} {
		if err := fake.db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err := fake.db.Model(&model.DramaProduction{}).Where("project_id = ?", source.Project.ID).Update("stage", model.DramaStageBible).Error; err != nil {
		t.Fatal(err)
	}
	if err := svc.repo.RetryDramaResultJobs(source.Project.ID); err != nil {
		t.Fatal(err)
	}
	reopened, _ := svc.repo.DramaJob(source.Project.ID, job.ID)
	if reopened.Status != model.DramaJobQueued || reopened.TaskID != "" || reopened.PayloadJSON != job.PayloadJSON {
		t.Fatalf("retry must keep exact kind/source scope: %+v", reopened)
	}
	runDramaTicks(t, svc, source.Project.ID, 2)
	p, _ := svc.repo.DramaProduction(source.Project.ID)
	if p.Stage != model.DramaStageBible || p.BibleJSON != `{"logline":"保留全局设定","tone":"冷静"}` {
		t.Fatalf("type-only success must not complete initial all-kind Bible: %+v", p)
	}
	ready, _, err := dramaGuideReadiness(svc.repo, p)
	if err != nil || ready {
		t.Fatalf("partial type extraction must not mark global asset step ready: ready=%v error=%v", ready, err)
	}
	if len(fake.requests) != 1 || !strings.Contains(fake.requests[0].Prompt, "选中乙") || strings.Contains(fake.requests[0].Prompt, "范围外甲") {
		t.Fatalf("retried request lost its source scope: %+v", fake.requests)
	}
}

func TestDramaAssetExtractionHonorsBudgetWithoutResumingProduction(t *testing.T) {
	svc, fake, source := newDramaExtractionSource(t, model.DramaGuideCompleted, model.DramaStatusCompleted)
	seedDramaBillingOrder(t, fake.db, source.Project.ID, "scope-budget", model.BillingOrder{AmountMicrocredits: 100, ActualAmountMicrocredits: 100, Status: model.BillingStatusSettled})
	if err := fake.db.Model(&model.DramaProduction{}).Where("project_id = ?", source.Project.ID).Update("budget_microcredits", 100).Error; err != nil {
		t.Fatal(err)
	}
	result, err := svc.ExtractDramaAssets("usr-drama", source.Project.ID, ExtractDramaAssetsRequest{ExpectedRevision: source.Production.Revision, Kind: "scene"})
	if err != nil {
		t.Fatal(err)
	}
	runDramaTicks(t, svc, source.Project.ID, 1)
	p, _ := svc.repo.DramaProduction(source.Project.ID)
	job, _ := svc.repo.DramaJob(source.Project.ID, result.Job.ID)
	wait, err := svc.dramaDispatchWaits(p)
	if err != nil {
		t.Fatal(err)
	}
	if p.Status != model.DramaStatusCompleted || job.Status != model.DramaJobQueued || wait(dramaJobView(*job)) != dramaBudgetPauseReason || len(fake.requests) != 0 {
		t.Fatalf("budget must block scoped work without changing production: p=%+v job=%+v wait=%q", p, job, wait(dramaJobView(*job)))
	}
	if err := fake.db.Model(&model.DramaProduction{}).Where("project_id = ?", source.Project.ID).Update("budget_microcredits", 200).Error; err != nil {
		t.Fatal(err)
	}
	runDramaTicks(t, svc, source.Project.ID, 2)
	p, _ = svc.repo.DramaProduction(source.Project.ID)
	job, _ = svc.repo.DramaJob(source.Project.ID, result.Job.ID)
	if p.Status != model.DramaStatusCompleted || job.Status != model.DramaJobSucceeded || len(fake.requests) != 1 {
		t.Fatalf("increased budget must only resume scope request: p=%+v job=%+v requests=%v", p, job, fake.byKind)
	}
}

func TestDramaAssetExtractionExplicitEmptyResultPreservesCatalog(t *testing.T) {
	for kind, key := range map[string]string{"character": "characters", "scene": "scenes", "prop": "props"} {
		t.Run(kind, func(t *testing.T) {
			svc, fake, source := newDramaExtractionSource(t, model.DramaGuideAssets, model.DramaStatusPaused)
			chapters, _ := svc.repo.DramaChapters(source.Project.ID)
			manual := model.DramaCast{ID: newID(), ProjectID: source.Project.ID, Kind: kind, Name: "人工保留", Description: "查漏零项也不能删除", ImageStatus: model.DramaMediaReady, ImageResourceID: "keep-image"}
			payload, _ := json.Marshal(dramaAssetExtractionPayload{Scope: dramaAssetExtractionScope, AssetKind: kind, SourceChapterIDs: []string{chapters[0].ID}})
			result, _ := json.Marshal(map[string]string{"text": `{"` + key + `":[]}`})
			task := model.Task{ID: newID(), UserID: "usr-drama", ProjectID: source.Project.ID, Status: model.TaskStatusSucceeded, ResultJSON: string(result)}
			job := model.DramaJob{ID: newID(), ProjectID: source.Project.ID, Kind: model.DramaJobBible, Status: model.DramaJobRunning, TaskID: task.ID, PayloadJSON: string(payload)}
			for _, row := range []any{&manual, &task, &job} {
				if err := fake.db.Create(row).Error; err != nil {
					t.Fatal(err)
				}
			}
			before, _ := svc.repo.DramaCasts(source.Project.ID)
			runDramaTicks(t, svc, source.Project.ID, 1)
			after, _ := svc.repo.DramaCasts(source.Project.ID)
			stored, _ := svc.repo.DramaJob(source.Project.ID, job.ID)
			if stored.Status != model.DramaJobSucceeded || !reflect.DeepEqual(before, after) || len(fake.requests) != 0 {
				t.Fatalf("explicit empty %s must succeed without changing catalog: job=%+v before=%+v after=%+v", kind, stored, before, after)
			}
		})
	}
}
