package app

import (
	"encoding/json"
	"strings"
	"testing"

	"yingce/backend/internal/model"
	"yingce/backend/internal/production"
)

func TestDramaCharacterAssetSchemeSubmitsAndAdoptsOneCompositeImage(t *testing.T) {
	for _, scheme := range production.AssetSchemes() {
		t.Run(scheme.Mode, func(t *testing.T) {
			svc, fake := newDramaTestService(t)
			settings := DramaSettings{Models: fakeDramaModels, MediaMode: DramaMediaManual}
			settings.Assets = production.AssetSettings{Mode: scheme.Mode}
			summary, err := svc.CreateDrama("usr-drama", CreateDramaRequest{Name: scheme.Name, Settings: settings, Chapters: []DramaChapterInput{{Title: "第一章", Text: "林逸走进房间。"}}})
			if err != nil {
				t.Fatal(err)
			}
			projectID := summary.Project.ID
			cast := createDramaMaterial(t, svc, projectID, "character", "林逸")
			preview, err := svc.PreviewDramaCastImagePrompt("usr-drama", projectID, cast.ID, DramaCastImagePromptRequest{})
			if err != nil {
				t.Fatal(err)
			}
			cast.ImageStatus = model.DramaMediaQueued
			if err := fake.db.Save(&cast).Error; err != nil {
				t.Fatal(err)
			}
			project, row, err := svc.dramaForUser("usr-drama", projectID)
			if err != nil {
				t.Fatal(err)
			}
			run := dramaRun{s: svc, project: project, production: row, settings: parseDramaSettings(row.SettingsJSON), meta: parseDramaBibleMeta(row.BibleJSON)}
			if run.settings.Assets.Mode != scheme.Mode || run.settings.Assets.CharacterRatio != scheme.Ratio {
				t.Fatalf("saved composition changed: %+v", run.settings.Assets)
			}
			job := &model.DramaJob{ID: newID(), ProjectID: projectID, Kind: model.DramaJobCastImage, CastID: cast.ID, PayloadJSON: encodeDramaRevision(cast.Revision)}
			task, skip, err := run.submitCastImage(job)
			if err != nil || skip || task == nil || len(fake.requests) != 1 {
				t.Fatalf("expected one task: skip=%v requests=%d err=%v", skip, len(fake.requests), err)
			}
			request := fake.requests[0]
			config, _ := request.Input["config"].(map[string]any)
			metadata, _ := request.Input["metadata"].(map[string]any)
			if config["count"] != "1" || metadata["assetMode"] != scheme.Mode || request.Prompt != preview || !strings.Contains(request.Prompt, production.AssetImageOutputContract) {
				t.Fatalf("one-image preview/submission contract changed: %+v", request)
			}
			if err := run.applyCastImage(job, task); err != nil {
				t.Fatal(err)
			}
			takes, err := svc.repo.DramaTakes(projectID, cast.ID, "cast", 100)
			current, castErr := svc.repo.DramaCast(projectID, cast.ID)
			resourceID, resultErr := dramaCastImageResource(task)
			if err != nil || castErr != nil || resultErr != nil || len(takes) != 1 || takes[0].ResourceID != resourceID || current.ImageResourceID != resourceID || current.ImageStatus != model.DramaMediaReady || current.ImageVersion != 1 {
				t.Fatalf("composite image must be one take/current resource: cast=%+v takes=%+v errors=%v/%v/%v", current, takes, err, castErr, resultErr)
			}
			var tasks int64
			if err := fake.db.Model(&model.Task{}).Count(&tasks).Error; err != nil || tasks != 1 {
				t.Fatalf("composition created extra tasks: %d %v", tasks, err)
			}
		})
	}
}

func TestDramaCastImageRejectsMultipleOutputImagesWithoutAdopting(t *testing.T) {
	svc, fake := newDramaTestService(t)
	projectID := newDramaMaterialProject(t, svc, "拒绝拆分设定图")
	cast := createDramaMaterial(t, svc, projectID, "character", "林逸")
	cast.ImageResourceID = fake.resourceSized("usr-drama", "image", "image/png", 1920, 1080)
	cast.ImageStatus = model.DramaMediaRunning
	if err := fake.db.Save(&cast).Error; err != nil {
		t.Fatal(err)
	}
	project, row, _ := svc.dramaForUser("usr-drama", projectID)
	run := dramaRun{s: svc, project: project, production: row, settings: parseDramaSettings(row.SettingsJSON)}
	first := fake.resourceSized("usr-drama", "image", "image/png", 1920, 1080)
	second := fake.resourceSized("usr-drama", "image", "image/png", 1920, 1080)
	result, _ := json.Marshal(map[string]any{"images": []any{map[string]any{"resourceId": first}, map[string]any{"resourceId": second}}})
	task := &model.Task{ID: "split-output", ProjectID: projectID, UserID: "usr-drama", Type: "canvas_image", Status: model.TaskStatusSucceeded, ResultJSON: string(result)}
	job := &model.DramaJob{ID: "split-job", ProjectID: projectID, Kind: model.DramaJobCastImage, CastID: cast.ID, TaskID: task.ID, Status: model.DramaJobRunning, PayloadJSON: encodeDramaRevision(cast.Revision)}
	for _, row := range []any{task, job} {
		if err := fake.db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err := run.syncRunningJob(job); err != nil || job.Status != model.DramaJobFailed || !strings.Contains(job.Error, "一张完整图片") || strings.Contains(job.Error, "结果处理失败") {
		t.Fatalf("invalid output must fail the job as a result issue: %+v %v", job, err)
	}
	after, _ := svc.repo.DramaCast(projectID, cast.ID)
	takes, _ := svc.repo.DramaTakes(projectID, cast.ID, "cast", 100)
	if after.ImageResourceID != cast.ImageResourceID || after.ImageVersion != cast.ImageVersion || after.ImageStatus != model.DramaMediaFailed || len(takes) != 0 {
		t.Fatalf("bad composition replaced current image: %+v %+v", after, takes)
	}
	stored, err := svc.repo.Task(task.ID)
	if err != nil || stored.Status != model.TaskStatusSucceeded || stored.ResultJSON != task.ResultJSON {
		t.Fatalf("paid provider result must stay available: %+v %v", stored, err)
	}
	if _, err := svc.RegenerateDramaCast("usr-drama", projectID, cast.ID, false); err != nil {
		t.Fatal(err)
	}
	retry, _ := svc.repo.DramaCast(projectID, cast.ID)
	if retry.ImageStatus != model.DramaMediaQueued || retry.ImageResourceID != cast.ImageResourceID {
		t.Fatalf("failed composition cannot be explicitly queued again: %+v", retry)
	}
}

func TestDramaCastViewsRejectMultipleImagesAndAllowExplicitRetry(t *testing.T) {
	svc, db, view := castViewsFixture(t)
	task, err := svc.ExecuteDramaCastView("user", "view-project", "view-cast", view.ID, confirmedCastView(t, svc, view.ID, "split-first"))
	if err != nil {
		t.Fatal(err)
	}
	result := `{"images":[{"resourceId":"split-first"},{"resourceId":"split-second"}]}`
	if err := db.Model(&model.Task{}).Where("id = ?", task.ID).Updates(map[string]any{"status": model.TaskStatusSucceeded, "result_json": result}).Error; err != nil {
		t.Fatal(err)
	}
	stored, _ := svc.repo.Task(task.ID)
	if handled, err := svc.RegisterDramaCastViewTaskOutput(*stored); !handled || err == nil || !strings.Contains(err.Error(), "一张完整图片") {
		t.Fatalf("split view output accepted: handled=%v %v", handled, err)
	}
	after, err := svc.DramaCastView("user", "view-project", "view-cast", view.ID)
	if err != nil || after.ResourceID != "" || len(after.Takes) != 1 || after.Takes[0].ResourceID != "" {
		t.Fatalf("split view was adopted: %+v %v", after, err)
	}
	stored, _ = svc.repo.Task(task.ID)
	if stored.Status != model.TaskStatusSucceeded || stored.ResultJSON != result {
		t.Fatal("provider results were discarded")
	}
	retry, err := svc.ExecuteDramaCastView("user", "view-project", "view-cast", view.ID, confirmedCastView(t, svc, view.ID, "split-retry"))
	if err != nil || retry.ID == task.ID {
		t.Fatalf("explicit retry blocked or replayed invalid output: %+v %v", retry, err)
	}
	completeCastView(t, svc, db, retry.ID, "complete-composite")
	after, err = svc.DramaCastView("user", "view-project", "view-cast", view.ID)
	if err != nil || after.ResourceID != "complete-composite" {
		t.Fatalf("valid retry did not activate: %+v %v", after, err)
	}
}

func TestDramaCastImageResourceRequiresOnePersistedImage(t *testing.T) {
	for _, raw := range []string{`{}`, `{"images":[]}`, `{"images":[{"url":"https://example.com/not-persisted.png"}]}`, `{"images":[{"resourceId":"first"},{"resourceId":"second"}]}`} {
		if _, err := dramaCastImageResource(&model.Task{Type: "canvas_image", ResultJSON: raw}); err == nil {
			t.Fatalf("invalid result accepted: %s", raw)
		}
	}
	for _, raw := range []string{`{"images":[{"resourceId":"one"}]}`, `{"images":[{"storageKey":"resource:one"}]}`, `{"images":[{"url":"/api/resources/one/file"}]}`} {
		if id, err := dramaCastImageResource(&model.Task{Type: "canvas_image", ResultJSON: raw}); err != nil || id != "one" {
			t.Fatalf("single persisted result lost: %s => %q %v", raw, id, err)
		}
	}
}

func TestDramaCastImagePromptUsesChangedTemplateAndPreservesExplicitOverride(t *testing.T) {
	svc, fake := newDramaTestService(t)
	projectID := newDramaMaterialProject(t, svc, "切换绘图模板")
	cast := createDramaMaterial(t, svc, projectID, "character", "林逸")
	_, row, err := svc.dramaForUser("usr-drama", projectID)
	if err != nil {
		t.Fatal(err)
	}
	settings := parseDramaSettings(row.SettingsJSON)
	settings.Assets = production.AssetSettings{Mode: production.AssetModeHeadshotFullbody}
	if _, err := svc.UpdateDramaSettings("usr-drama", projectID, UpdateDramaSettingsRequest{ExpectedRevision: &row.Revision, Settings: &settings}); err != nil {
		t.Fatal(err)
	}
	saved, _ := svc.repo.DramaCast(projectID, cast.ID)
	if saved.ImagePrompt != "" {
		t.Fatal("template selection must not cache generated prompts into the cast")
	}
	preview, err := svc.PreviewDramaCastImagePrompt("usr-drama", projectID, cast.ID, DramaCastImagePromptRequest{})
	if err != nil || !strings.Contains(preview, "大头照+全身照复合设定图") || strings.Contains(preview, "单特写+三视图复合设定图") {
		t.Fatalf("rebuild did not use the newly saved template: %s %v", preview, err)
	}
	custom := "用户明确要求：只画单人侧面，灰色背景"
	if _, err := svc.UpdateDramaCast("usr-drama", projectID, cast.ID, UpdateDramaCastRequest{ImagePrompt: &custom}); err != nil {
		t.Fatal(err)
	}
	project, row, _ := svc.dramaForUser("usr-drama", projectID)
	saved, _ = svc.repo.DramaCast(projectID, cast.ID)
	actual := buildDramaCastImagePrompt(parseDramaSettings(row.SettingsJSON), parseDramaBibleMeta(row.BibleJSON), *saved)
	if !strings.Contains(actual, custom) || strings.Contains(actual, "大头照+全身照复合设定图") {
		t.Fatalf("manual complete prompt was silently rewritten: %s", actual)
	}
	rebuilt, err := svc.PreviewDramaCastImagePrompt("usr-drama", projectID, cast.ID, DramaCastImagePromptRequest{})
	saved, _ = svc.repo.DramaCast(projectID, cast.ID)
	if err != nil || rebuilt != preview || saved.ImagePrompt != custom || len(fake.requests) != 0 {
		t.Fatalf("rebuild must be explicit, deterministic and free of writes/model calls: %v", err)
	}
	if _, err := svc.UpdateDramaCast("usr-drama", projectID, cast.ID, UpdateDramaCastRequest{ImagePrompt: &rebuilt}); err != nil {
		t.Fatal(err)
	}
	saved, _ = svc.repo.DramaCast(projectID, cast.ID)
	saved.ImageStatus = model.DramaMediaQueued
	if err := fake.db.Save(saved).Error; err != nil {
		t.Fatal(err)
	}
	run := dramaRun{s: svc, project: project, production: row, settings: parseDramaSettings(row.SettingsJSON), meta: parseDramaBibleMeta(row.BibleJSON)}
	if _, skip, err := run.submitCastImage(&model.DramaJob{ID: newID(), ProjectID: projectID, Kind: model.DramaJobCastImage, CastID: cast.ID}); err != nil || skip || len(fake.requests) != 1 || fake.requests[0].Prompt != rebuilt {
		t.Fatalf("confirmed rebuilt template did not reach the one-image task: skip=%v %v", skip, err)
	}
}
