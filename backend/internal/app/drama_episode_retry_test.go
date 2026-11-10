package app

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"yingce/backend/internal/model"
)

func seedDramaScriptRetry(t *testing.T, fixture dramaGuideRevisionFixture, text, jobError string) (model.DramaEpisode, model.Task, model.DramaJob) {
	t.Helper()
	episode, err := fixture.svc.repo.DramaEpisode(fixture.summary.Project.ID, fixture.shot.EpisodeID)
	if err != nil {
		t.Fatal(err)
	}
	episode.Stage, episode.Error = model.DramaEpisodeScript, jobError
	if err := fixture.fake.db.Save(episode).Error; err != nil {
		t.Fatal(err)
	}
	if err := fixture.svc.repo.UpdateDramaProduction(episode.ProjectID, map[string]any{"stage": model.DramaStageProduce, "status": model.DramaStatusRunning, "plan_done": true}); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(map[string]string{"mode": "text", "text": text})
	payload, _ := json.Marshal(dramaRevisionPayload{Revision: episode.Revision})
	task := model.Task{ID: newID(), UserID: "usr-drama", ProjectID: episode.ProjectID, Type: "canvas_text", Status: model.TaskStatusSucceeded, ResultJSON: string(raw)}
	job := model.DramaJob{ID: newID(), ProjectID: episode.ProjectID, EpisodeID: episode.ID, Kind: model.DramaJobScript, Status: model.DramaJobFailed, TaskID: task.ID, PayloadJSON: string(payload), Error: jobError}
	for _, row := range []any{&task, &job} {
		if err := fixture.fake.db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	return *episode, task, job
}

func TestDramaEpisodeRetryRegeneratesInvalidScriptResults(t *testing.T) {
	for _, text := range []string{`{"shots":[{"action":"缺少根闭合"}]`, `{"shots":[]}`, `{"shots":"字段类型错误"}`, `{"shots":[{"action":"草稿"}]} {"episode":{"synopsis":"梗概"}} {"shots":[{"action":"另一个版本"}]}`} {
		t.Run(text, func(t *testing.T) {
			fixture := newDramaGuideRevisionFixture(t, model.DramaGuideStory)
			episode, task, job := seedDramaScriptRetry(t, fixture, text, "模拟失败")
			productionRow, _ := fixture.svc.repo.DramaProduction(episode.ProjectID)
			run := &dramaRun{s: fixture.svc, project: &fixture.summary.Project, production: productionRow, settings: parseDramaSettings(productionRow.SettingsJSON)}
			job.Status = model.DramaJobRunning
			if err := fixture.svc.repo.SaveDramaJob(&job); err != nil {
				t.Fatal(err)
			}
			if err := run.syncRunningJob(&job); err != nil {
				t.Fatal(err)
			}
			if job.Status != model.DramaJobFailed || !strings.Contains(job.Error, "请重试本集剧本") || strings.Contains(job.Error, "重试不重复生成") {
				t.Fatalf("invalid provider result must offer regeneration instead of replay: %+v", job)
			}
			beforeRevision := productionRow.Revision
			result, err := fixture.svc.RetryFailedDramaEpisode("usr-drama", episode.ProjectID, episode.ID)
			if err != nil || result["jobs"] != 1 {
				t.Fatalf("retry invalid script: %+v %v", result, err)
			}
			if err := fixture.fake.db.First(&job, "id = ?", job.ID).Error; err != nil {
				t.Fatal(err)
			}
			if job.Status != model.DramaJobQueued || job.TaskID != "" {
				t.Fatalf("invalid result must release task binding for a fresh generation: %+v", job)
			}
			shots, _ := fixture.svc.repo.DramaShots(episode.ID)
			if len(shots) != 1 || shots[0].ID != fixture.shot.ID {
				t.Fatalf("retry must retain saved shots until a replacement succeeds: %+v", shots)
			}
			again, err := fixture.svc.RetryFailedDramaEpisode("usr-drama", episode.ProjectID, episode.ID)
			current, _ := fixture.svc.repo.DramaProduction(episode.ProjectID)
			if err != nil || again["jobs"] != 0 || current.Revision != beforeRevision+1 {
				t.Fatalf("repeated click must not requeue or advance the guide twice: %+v %+v %v", again, current, err)
			}
			runDramaTicks(t, fixture.svc, episode.ProjectID, 3)
			if err := fixture.fake.db.First(&job, "id = ?", job.ID).Error; err != nil {
				t.Fatal(err)
			}
			if job.Status != model.DramaJobSucceeded || job.TaskID == task.ID || fixture.fake.byKind[model.DramaJobScript] != 1 {
				t.Fatalf("retry must generate one usable replacement: %+v calls=%v", job, fixture.fake.byKind)
			}
			stored, err := fixture.svc.repo.Task(task.ID)
			if err != nil || stored.ResultJSON != task.ResultJSON {
				t.Fatalf("original invalid task must remain unmodified history: %+v %v", stored, err)
			}
			if fixture.fake.byKind["image"]+fixture.fake.byKind["video"]+fixture.fake.byKind["render"] != 0 {
				t.Fatalf("text recovery must not generate media: %v", fixture.fake.byKind)
			}
		})
	}
}

func TestDramaEpisodeRetryReplaysPersistedScriptWithoutGeneratingAgain(t *testing.T) {
	fixture := newDramaGuideRevisionFixture(t, model.DramaGuideStory)
	episode, task, job := seedDramaScriptRetry(t, fixture, `{"shots":[{"scene":"原场景","action":"少年推门","durationSeconds":3}]}`, "结果处理失败（保留原任务，重试不重复生成）：database is locked")
	job.CostMicrocredits = 70
	recordDramaAttempt(&job, task.ID, string(task.Status), "", 70)
	if err := fixture.svc.repo.SaveDramaJob(&job); err != nil {
		t.Fatal(err)
	}
	if err := fixture.svc.repo.UpdateDramaProduction(episode.ProjectID, map[string]any{"spent_microcredits": 70}); err != nil {
		t.Fatal(err)
	}
	result, err := fixture.svc.RetryFailedDramaEpisode("usr-drama", episode.ProjectID, episode.ID)
	if err != nil || result["jobs"] != 1 {
		t.Fatalf("retry valid paid script: %+v %v", result, err)
	}
	current, _ := fixture.svc.repo.DramaEpisode(episode.ProjectID, episode.ID)
	if current.Revision != episode.Revision || current.Error != "" {
		t.Fatalf("clearing failure must retain the result's matching revision: %+v", current)
	}
	runDramaTicks(t, fixture.svc, episode.ProjectID, 1)
	if err := fixture.fake.db.First(&job, "id = ?", job.ID).Error; err != nil {
		t.Fatal(err)
	}
	productionRow, _ := fixture.svc.repo.DramaProduction(episode.ProjectID)
	var attempts []DramaJobAttempt
	_ = json.Unmarshal([]byte(job.AttemptsJSON), &attempts)
	if job.Status != model.DramaJobSucceeded || job.TaskID != task.ID || fixture.fake.byKind[model.DramaJobScript] != 0 || len(attempts) != 1 || productionRow.SpentMicrocredits != 70 {
		t.Fatalf("replay must retain original generation and its single charge: %+v attempts=%+v calls=%v production=%+v", job, attempts, fixture.fake.byKind, productionRow)
	}
	shots, _ := fixture.svc.repo.DramaShots(episode.ID)
	if len(shots) != 1 || shots[0].Action != "少年推门" {
		t.Fatalf("original result must be applied: %+v", shots)
	}
}

func TestDramaEpisodeRetryRegeneratesFailedProviderTask(t *testing.T) {
	fixture := newDramaGuideRevisionFixture(t, model.DramaGuideStory)
	episode, task, job := seedDramaScriptRetry(t, fixture, "", "上游超时")
	if err := fixture.fake.db.Model(&model.Task{}).Where("id = ?", task.ID).Updates(map[string]any{"status": model.TaskStatusFailed, "error": "上游超时"}).Error; err != nil {
		t.Fatal(err)
	}
	result, err := fixture.svc.RetryFailedDramaEpisode("usr-drama", episode.ProjectID, episode.ID)
	if err != nil || result["jobs"] != 1 {
		t.Fatalf("retry failed provider task: %+v %v", result, err)
	}
	runDramaTicks(t, fixture.svc, episode.ProjectID, 2)
	var original model.DramaJob
	if err := fixture.fake.db.First(&original, "id = ?", job.ID).Error; err != nil {
		t.Fatal(err)
	}
	current, _ := fixture.svc.repo.DramaEpisode(episode.ProjectID, episode.ID)
	if original.Status != model.DramaJobFailed || original.TaskID != task.ID || current.Error != "" || current.Stage == model.DramaEpisodeScript || fixture.fake.byKind[model.DramaJobScript] != 1 {
		t.Fatalf("provider failure must schedule one new task while retaining failed history: %+v %+v calls=%v", original, current, fixture.fake.byKind)
	}
}

func TestDramaEpisodeRetryOnlyTouchesLatestCurrentTextSlots(t *testing.T) {
	fixture := newDramaGuideRevisionFixture(t, model.DramaGuideStory)
	episode, _, currentScript := seedDramaScriptRetry(t, fixture, `{"shots":[]}`, "分镜脚本解析失败：分镜脚本没有可用镜头")
	otherEpisode := model.DramaEpisode{ID: newID(), ProjectID: episode.ProjectID, Number: 2, Stage: model.DramaEpisodeScript, Revision: 5, Error: "其他集失败"}
	otherSegment := model.DramaSegment{ID: newID(), ProjectID: episode.ProjectID, EpisodeID: otherEpisode.ID, SegmentIndex: 0, Revision: 2, PromptStatus: model.DramaMediaFailed, PromptError: "其他段失败", VideoStatus: model.DramaMediaFailed, VideoError: "其他视频失败"}
	oldPayload, _ := json.Marshal(dramaRevisionPayload{Revision: episode.Revision - 1})
	segmentPayload, _ := json.Marshal(dramaRevisionPayload{Revision: fixture.segment.Revision})
	otherPayload, _ := json.Marshal(dramaRevisionPayload{Revision: otherEpisode.Revision})
	oldScript := model.DramaJob{ID: newID(), ProjectID: episode.ProjectID, EpisodeID: episode.ID, Kind: model.DramaJobScript, Status: model.DramaJobFailed, PayloadJSON: string(oldPayload), Error: "分镜脚本解析失败：旧版本", CreatedAt: time.Now().Add(-time.Hour)}
	otherScript := model.DramaJob{ID: newID(), ProjectID: episode.ProjectID, EpisodeID: otherEpisode.ID, Kind: model.DramaJobScript, Status: model.DramaJobFailed, PayloadJSON: string(otherPayload), Error: "分镜脚本解析失败：其他集"}
	prompt := model.DramaJob{ID: newID(), ProjectID: episode.ProjectID, EpisodeID: episode.ID, ShotID: fixture.segment.ID, Kind: model.DramaJobSegmentPrompt, Status: model.DramaJobFailed, PayloadJSON: string(segmentPayload), Error: "上游失败"}
	oldPrompt := prompt
	oldPrompt.ID, oldPrompt.CreatedAt = newID(), time.Now().Add(-time.Hour)
	oldPrompt.Error = "模型没有返回可解析的 JSON"
	video := model.DramaJob{ID: newID(), ProjectID: episode.ProjectID, EpisodeID: episode.ID, ShotID: fixture.segment.ID, Kind: model.DramaJobSegmentVideo, Status: model.DramaJobFailed, Error: "视频失败"}
	for _, row := range []any{&otherEpisode, &otherSegment, &oldScript, &otherScript, &prompt, &oldPrompt, &video} {
		if err := fixture.fake.db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err := fixture.fake.db.Model(&model.DramaSegment{}).Where("id = ?", fixture.segment.ID).Updates(map[string]any{"prompt_status": model.DramaMediaFailed, "prompt_error": "上游失败", "video_status": model.DramaMediaFailed, "video_error": "视频失败"}).Error; err != nil {
		t.Fatal(err)
	}
	if err := fixture.fake.db.Model(&model.DramaCast{}).Where("id = ?", fixture.cast.ID).Update("image_status", model.DramaMediaFailed).Error; err != nil {
		t.Fatal(err)
	}
	result, err := fixture.svc.RetryFailedDramaEpisode("usr-drama", episode.ProjectID, episode.ID)
	if err != nil || result["jobs"] != 2 {
		t.Fatalf("retry current script and failed prompt: %+v %v", result, err)
	}
	for _, original := range []model.DramaJob{oldScript, oldPrompt, otherScript, video} {
		var stored model.DramaJob
		if err := fixture.fake.db.First(&stored, "id = ?", original.ID).Error; err != nil || stored.Status != original.Status || stored.Error != original.Error {
			t.Fatalf("unrelated and historical jobs must not revive: %+v %v", stored, err)
		}
	}
	segment, _ := fixture.svc.repo.DramaSegment(episode.ProjectID, fixture.segment.ID)
	cast, _ := fixture.svc.repo.DramaCast(episode.ProjectID, fixture.cast.ID)
	unchangedEpisode, _ := fixture.svc.repo.DramaEpisode(episode.ProjectID, otherEpisode.ID)
	unchangedSegment, _ := fixture.svc.repo.DramaSegment(episode.ProjectID, otherSegment.ID)
	if segment.Revision != fixture.segment.Revision || segment.PromptStatus != "" || segment.VideoPromptOverride != fixture.segment.VideoPromptOverride || segment.VideoStatus != model.DramaMediaFailed || segment.VideoError != "视频失败" || cast.ImageStatus != model.DramaMediaFailed || unchangedEpisode.Error != otherEpisode.Error || unchangedSegment.PromptError != otherSegment.PromptError {
		t.Fatalf("scoped text retry must preserve manual text, other episodes, and media: %+v %+v %+v %+v", segment, cast, unchangedEpisode, unchangedSegment)
	}
	if err := fixture.fake.db.First(&currentScript, "id = ?", currentScript.ID).Error; err != nil || currentScript.Status != model.DramaJobQueued {
		t.Fatalf("current invalid script must be the only revived script: %+v %v", currentScript, err)
	}
	if len(fixture.fake.requests) != 0 {
		t.Fatal("retry API itself must not run generation synchronously")
	}
}

func TestDramaEpisodeRetryRejectsWrongScopeAndGuideStage(t *testing.T) {
	fixture := newDramaGuideRevisionFixture(t, model.DramaGuideStory)
	projectID, episodeID := fixture.summary.Project.ID, fixture.shot.EpisodeID
	for _, args := range []struct{ user, episode string }{{"someone", episodeID}, {"usr-drama", ""}, {"usr-drama", "  "}, {"usr-drama", "missing"}} {
		if _, err := fixture.svc.RetryFailedDramaEpisode(args.user, projectID, args.episode); err == nil {
			t.Fatalf("must reject unauthorized or invalid episode: %+v", args)
		}
	}
	other := model.DramaEpisode{ID: newID(), ProjectID: "other-project", Number: 1}
	if err := fixture.fake.db.Create(&other).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.svc.RetryFailedDramaEpisode("usr-drama", projectID, other.ID); err == nil {
		t.Fatal("episode must belong to the requested project")
	}
	for _, step := range []string{model.DramaGuideConfiguring, model.DramaGuideAssets} {
		if err := fixture.fake.db.Model(&model.DramaProduction{}).Where("project_id = ?", projectID).Update("guide_step", step).Error; err != nil {
			t.Fatal(err)
		}
		if _, err := fixture.svc.RetryFailedDramaEpisode("usr-drama", projectID, episodeID); err == nil {
			t.Fatalf("cannot restart story text in guide stage %s", step)
		}
	}
}

func TestDramaEpisodeRetrySkipsStaleOrSupersededFailures(t *testing.T) {
	for _, latestStatus := range []string{"stale-revision", model.DramaJobSucceeded, model.DramaJobQueued, model.DramaJobRunning} {
		t.Run(latestStatus, func(t *testing.T) {
			fixture := newDramaGuideRevisionFixture(t, model.DramaGuideStory)
			episode, _, job := seedDramaScriptRetry(t, fixture, `{"shots":[]}`, "分镜脚本解析失败：分镜脚本没有可用镜头")
			if latestStatus == "stale-revision" {
				payload, _ := json.Marshal(dramaRevisionPayload{Revision: episode.Revision - 1})
				job.PayloadJSON = string(payload)
				if err := fixture.svc.repo.SaveDramaJob(&job); err != nil {
					t.Fatal(err)
				}
			} else {
				latest := job
				latest.ID, latest.Status, latest.CreatedAt = newID(), latestStatus, time.Now().Add(time.Minute)
				if err := fixture.fake.db.Create(&latest).Error; err != nil {
					t.Fatal(err)
				}
			}
			before, _ := fixture.svc.repo.DramaProduction(episode.ProjectID)
			result, err := fixture.svc.RetryFailedDramaEpisode("usr-drama", episode.ProjectID, episode.ID)
			productionRow, _ := fixture.svc.repo.DramaProduction(episode.ProjectID)
			current, _ := fixture.svc.repo.DramaEpisode(episode.ProjectID, episode.ID)
			if err != nil || result["jobs"] != 0 || productionRow.Revision != before.Revision || current.Error != episode.Error {
				t.Fatalf("obsolete failures must not revive or clear the current slot: %+v %+v %+v %v", result, productionRow, current, err)
			}
		})
	}
}
