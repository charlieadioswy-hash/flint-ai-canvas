package app

import (
	"encoding/json"
	"strings"
	"testing"

	"yingce/backend/internal/model"
)

func dramaCastImageRetryFixture(t *testing.T, kind string, multiple bool) (*Service, *fakeDramaBackend, model.DramaCast, model.Task, model.DramaJob) {
	t.Helper()
	svc, fake := newDramaTestService(t)
	seedDramaStudioBatchImagePrice(t, fake)
	projectID := newDramaMaterialProject(t, svc, "参考图结果重试")
	cast := createDramaMaterial(t, svc, projectID, kind, "当前素材")
	cast.ImageResourceID = fake.resourceSized("usr-drama", "image", "image/png", 1920, 1080)
	cast.ImageStatus = model.DramaMediaRunning
	if err := fake.db.Save(&cast).Error; err != nil {
		t.Fatal(err)
	}
	if err := svc.repo.UpdateDramaProduction(projectID, map[string]any{"stage": model.DramaStageProduce, "guide_step": model.DramaGuideAssets, "status": model.DramaStatusRunning}); err != nil {
		t.Fatal(err)
	}
	images := []any{map[string]any{"resourceId": fake.resourceSized("usr-drama", "image", "image/png", 1920, 1080)}}
	if multiple {
		images = append(images, map[string]any{"resourceId": fake.resourceSized("usr-drama", "image", "image/png", 1920, 1080)})
	}
	result, _ := json.Marshal(map[string]any{"images": images})
	payload, _ := json.Marshal(map[string]any{"revision": cast.Revision, "retainedConfig": "keep"})
	task := model.Task{ID: "original-output", ProjectID: projectID, UserID: "usr-drama", Type: "canvas_image", Status: model.TaskStatusSucceeded, ResultJSON: string(result)}
	job := model.DramaJob{ID: "original-image-job", ProjectID: projectID, Kind: model.DramaJobCastImage, CastID: cast.ID, TaskID: task.ID, Status: model.DramaJobRunning, PayloadJSON: string(payload)}
	for _, row := range []any{&task, &job} {
		if err := fake.db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	return svc, fake, cast, task, job
}

func TestDramaCastImageGlobalRetryRegeneratesUnusableResult(t *testing.T) {
	for _, kind := range []string{"character", "scene"} {
		t.Run(kind, func(t *testing.T) {
			svc, fake, cast, task, job := dramaCastImageRetryFixture(t, kind, true)
			project, production, _ := svc.dramaForUser("usr-drama", cast.ProjectID)
			run := dramaRun{s: svc, project: project, production: production, settings: parseDramaSettings(production.SettingsJSON)}
			if err := run.syncRunningJob(&job); err != nil || job.Status != model.DramaJobFailed || !strings.Contains(job.Error, "一张完整图片") {
				t.Fatalf("multiple-image result not rejected: %+v %v", job, err)
			}
			saved, err := svc.repo.DramaJob(cast.ProjectID, job.ID)
			var payload struct {
				Revision       int64  `json:"revision"`
				RetainedConfig string `json:"retainedConfig"`
			}
			if err != nil || !saved.ResultUnusable() || json.Unmarshal([]byte(saved.PayloadJSON), &payload) != nil || payload.Revision != cast.Revision || payload.RetainedConfig != "keep" {
				t.Fatalf("unusable task classification lost version/config: %+v %v", saved, err)
			}
			// 重复点击全局重试也只能创建一次新生成，原失败作业继续保留原任务。
			for i := 0; i < 2; i++ {
				if _, err := svc.RetryFailedDrama("usr-drama", cast.ProjectID); err != nil {
					t.Fatal(err)
				}
			}
			queued, _ := svc.repo.DramaCast(cast.ProjectID, cast.ID)
			if queued.ImageStatus != model.DramaMediaQueued || queued.ImageResourceID != cast.ImageResourceID {
				t.Fatalf("retry replaced old image before a valid result: %+v", queued)
			}
			runDramaTicks(t, svc, cast.ProjectID, 4)
			current, err := svc.repo.DramaCast(cast.ProjectID, cast.ID)
			saved, jobErr := svc.repo.DramaJob(cast.ProjectID, job.ID)
			stored, taskErr := svc.repo.Task(task.ID)
			takes, takeErr := svc.repo.DramaTakes(cast.ProjectID, cast.ID, "cast", 100)
			if err != nil || jobErr != nil || taskErr != nil || takeErr != nil || current.ImageStatus != model.DramaMediaReady || current.ImageResourceID == cast.ImageResourceID || len(fake.requests) != 1 || fake.byKind["image"] != 1 || saved.Status != model.DramaJobFailed || saved.TaskID != task.ID || stored.Status != model.TaskStatusSucceeded || stored.ResultJSON != task.ResultJSON || len(takes) != 1 || takes[0].TaskID == task.ID || takes[0].ResourceID != current.ImageResourceID {
				t.Fatalf("global retry must generate/adopt once while retaining failed history: cast=%+v job=%+v task=%+v takes=%+v calls=%v errors=%v/%v/%v/%v", current, saved, stored, takes, fake.byKind, err, jobErr, taskErr, takeErr)
			}
			if _, err := svc.RetryFailedDrama("usr-drama", cast.ProjectID); err != nil {
				t.Fatal(err)
			}
			runDramaTicks(t, svc, cast.ProjectID, 2)
			again, _ := svc.repo.DramaCast(cast.ProjectID, cast.ID)
			if len(fake.requests) != 1 || again.ImageResourceID != current.ImageResourceID || again.ImageStatus != model.DramaMediaReady {
				t.Fatalf("historical invalid result was retried or replaced the new image: %+v calls=%v", again, fake.byKind)
			}
		})
	}
}

func TestDramaCastImageGlobalRetryReplaysUsableResultWithoutGeneration(t *testing.T) {
	for _, kind := range []string{"character", "scene"} {
		t.Run(kind, func(t *testing.T) {
			svc, fake, cast, task, job := dramaCastImageRetryFixture(t, kind, false)
			job.Status, job.Error = model.DramaJobFailed, "结果登记暂时失败"
			// 失效标记属于具体任务，不能把旧任务的分类套用到本次可用结果。
			if err := job.MarkResultUnusable("an-older-task"); err != nil {
				t.Fatal(err)
			}
			if err := svc.repo.SaveDramaJob(&job); err != nil {
				t.Fatal(err)
			}
			if err := fake.db.Model(&model.DramaCast{}).Where("id = ?", cast.ID).Update("image_status", model.DramaMediaFailed).Error; err != nil {
				t.Fatal(err)
			}
			for i := 0; i < 2; i++ {
				if _, err := svc.RetryFailedDrama("usr-drama", cast.ProjectID); err != nil {
					t.Fatal(err)
				}
			}
			runDramaTicks(t, svc, cast.ProjectID, 3)
			current, castErr := svc.repo.DramaCast(cast.ProjectID, cast.ID)
			saved, jobErr := svc.repo.DramaJob(cast.ProjectID, job.ID)
			stored, taskErr := svc.repo.Task(task.ID)
			takes, takeErr := svc.repo.DramaTakes(cast.ProjectID, cast.ID, "cast", 100)
			resourceID, _ := dramaCastImageResource(&task)
			if castErr != nil || jobErr != nil || taskErr != nil || takeErr != nil || saved.Status != model.DramaJobSucceeded || saved.TaskID != task.ID || current.ImageStatus != model.DramaMediaReady || current.ImageResourceID != resourceID || len(fake.requests) != 0 || stored.ResultJSON != task.ResultJSON || len(takes) != 1 || takes[0].TaskID != task.ID {
				t.Fatalf("usable paid result must replay without a second generation: cast=%+v job=%+v takes=%+v calls=%v errors=%v/%v/%v/%v", current, saved, takes, fake.byKind, castErr, jobErr, taskErr, takeErr)
			}
		})
	}
}
