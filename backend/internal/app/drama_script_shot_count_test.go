package app

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"yingce/backend/internal/model"
	"yingce/backend/internal/production"
)

func TestDramaScriptShotCountUsesEpisodeMode(t *testing.T) {
	for _, tc := range []struct {
		name        string
		mode        string
		format      string
		count       int
		imported    bool
		wantFailure bool
	}{
		{name: "smart retains all 29 shots for a 27-shot reference", mode: "smart", count: 29},
		{name: "saved count without mode is only a reference", count: 29},
		{name: "fixed rejects mismatched count", mode: "fixed", count: 29, wantFailure: true},
		{name: "fixed accepts requested count", mode: "fixed", count: 27},
		{name: "import preserves original count despite fixed setting", mode: "fixed", count: 29, imported: true},
		{name: "AI transcription preserves source storyboard count", mode: "fixed", format: production.SourceStoryboard, count: 29},
	} {
		t.Run(tc.name, func(t *testing.T) {
			svc, fake := newDramaTestService(t)
			projectID := newDramaMaterialProject(t, svc, "镜头数模式")
			project, p, err := svc.dramaForUser("usr-drama", projectID)
			if err != nil {
				t.Fatal(err)
			}
			settings := parseDramaSettings(p.SettingsJSON)
			settings.Storyboard.ShotCountMode = tc.mode
			settings.Storyboard.TargetShotCount = 27
			raw, err := json.Marshal(settings)
			if err != nil {
				t.Fatal(err)
			}
			if tc.mode == "" && strings.Contains(string(raw), "shotCountMode") {
				t.Fatal("legacy fixture must omit the mode field")
			}
			episode := model.DramaEpisode{ID: newID(), ProjectID: projectID, Number: 1, Stage: model.DramaEpisodeScript, SourceFormat: tc.format, SettingsJSON: string(raw), Revision: 1}
			if err := fake.db.Create(&episode).Error; err != nil {
				t.Fatal(err)
			}
			shots := make([]production.ScriptShot, tc.count)
			for i := range shots {
				shots[i] = production.ScriptShot{Scene: "原场景", Speaker: "旁白", Dialogue: fmt.Sprintf("原文台词%d", i+1), Action: fmt.Sprintf("原镜头%d", i+1), DurationSeconds: 3}
			}
			run := &dramaRun{s: svc, project: project, production: p, settings: parseDramaSettings(p.SettingsJSON)}
			job := &model.DramaJob{EpisodeID: episode.ID, PayloadJSON: encodeDramaRevision(episode.Revision), TaskID: "shot-count-result"}
			if tc.imported {
				err = run.applyScriptShots(&episode, shots, nil, production.ScriptEpisode{}, true)
			} else {
				text, _ := json.Marshal(map[string]any{"shots": shots})
				body, _ := json.Marshal(map[string]string{"text": string(text)})
				err = run.applyScript(job, &model.Task{ID: job.TaskID, ResultJSON: string(body)})
			}
			stored, readErr := svc.repo.DramaShots(episode.ID)
			if readErr != nil {
				t.Fatal(readErr)
			}
			if tc.wantFailure {
				var issue *dramaResultIssue
				if !errors.As(err, &issue) || !job.ResultUnusable() || len(stored) != 0 {
					t.Fatalf("fixed mismatch must reject the result before writing shots and mark it unusable: err=%v, job=%+v, shots=%d", err, job, len(stored))
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			current, err := svc.repo.DramaEpisode(projectID, episode.ID)
			if err != nil || len(stored) != tc.count || current.ShotCount != tc.count || current.Stage != model.DramaEpisodePrompts {
				t.Fatalf("all returned shots must be stored and advance the episode: shots=%d episode=%+v err=%v", len(stored), current, err)
			}
			for i := range shots {
				if stored[i].Action != shots[i].Action || stored[i].Dialogue != shots[i].Dialogue {
					t.Fatalf("shot %d was rewritten or truncated: %+v", i+1, stored[i])
				}
			}
			if len(fake.requests) != 0 {
				t.Fatal("applying an existing result must not call a model")
			}
		})
	}
}

func TestDramaFixedShotCountRetryGeneratesFreshResult(t *testing.T) {
	fixture := newDramaGuideRevisionFixture(t, model.DramaGuideStory)
	episode, task, job := seedDramaScriptRetry(t, fixture, `{"shots":[{"scene":"原场景","action":"镜头一"},{"scene":"原场景","action":"镜头二"},{"scene":"原场景","action":"镜头三"}]}`, "待核对结果")
	p, err := fixture.svc.repo.DramaProduction(episode.ProjectID)
	if err != nil {
		t.Fatal(err)
	}
	settings := parseDramaSettings(p.SettingsJSON)
	settings.Storyboard.ShotCountMode, settings.Storyboard.TargetShotCount = "fixed", 2
	if err := fixture.fake.db.Model(&model.DramaEpisode{}).Where("id = ?", episode.ID).Update("settings_json", encodeDramaSettings(settings)).Error; err != nil {
		t.Fatal(err)
	}
	job.Status = model.DramaJobRunning
	if err := fixture.svc.repo.SaveDramaJob(&job); err != nil {
		t.Fatal(err)
	}
	run := &dramaRun{s: fixture.svc, project: &fixture.summary.Project, production: p, settings: parseDramaSettings(p.SettingsJSON)}
	if err := run.syncRunningJob(&job); err != nil {
		t.Fatal(err)
	}
	if job.Status != model.DramaJobFailed || !job.ResultUnusable() || strings.Contains(job.Error, "重试不重复生成") {
		t.Fatalf("fixed mismatch must remain a result error rather than a replayable persistence error: %+v", job)
	}
	result, err := fixture.svc.RetryFailedDramaEpisode("usr-drama", episode.ProjectID, episode.ID)
	if err != nil || result["jobs"] != 1 {
		t.Fatalf("retry mismatched fixed result: %+v %v", result, err)
	}
	runDramaTicks(t, fixture.svc, episode.ProjectID, 3)
	if err := fixture.fake.db.First(&job, "id = ?", job.ID).Error; err != nil {
		t.Fatal(err)
	}
	if job.Status != model.DramaJobFailed || job.TaskID != task.ID || !job.ResultUnusable() {
		t.Fatalf("the rejected task must remain unchanged as history: %+v", job)
	}
	if fixture.fake.byKind[model.DramaJobScript] != 1 {
		t.Fatalf("retry must submit one fresh script rather than replay the rejected result: %v", fixture.fake.byKind)
	}
	shots, err := fixture.svc.repo.DramaShots(episode.ID)
	if err != nil || len(shots) != 2 || shots[0].ID == fixture.shot.ID {
		t.Fatalf("the fresh correctly sized result must replace the prior shots: %+v %v", shots, err)
	}
	storedTask, err := fixture.svc.repo.Task(task.ID)
	if err != nil || storedTask.ResultJSON != task.ResultJSON {
		t.Fatalf("the original model result must stay available in history: %+v %v", storedTask, err)
	}
}

func TestDramaSmartShotCountRetryReusesOriginalResult(t *testing.T) {
	fixture := newDramaGuideRevisionFixture(t, model.DramaGuideStory)
	shots := make([]production.ScriptShot, 29)
	for i := range shots {
		shots[i] = production.ScriptShot{Scene: "原场景", Action: fmt.Sprintf("原镜头%d", i+1), DurationSeconds: 3}
	}
	text, _ := json.Marshal(map[string]any{"shots": shots})
	episode, task, job := seedDramaScriptRetry(t, fixture, string(text), "结果处理失败（保留原任务，重试不重复生成）：模型返回 29 镜，未满足指定的 27 镜；请调整镜头数或重试")
	p, err := fixture.svc.repo.DramaProduction(episode.ProjectID)
	if err != nil {
		t.Fatal(err)
	}
	settings := parseDramaSettings(p.SettingsJSON)
	settings.Storyboard.ShotCountMode, settings.Storyboard.TargetShotCount = "", 27
	raw, _ := json.Marshal(settings)
	if strings.Contains(string(raw), "shotCountMode") {
		t.Fatal("production regression must use a saved reference without a mode field")
	}
	if err := fixture.fake.db.Model(&model.DramaEpisode{}).Where("id = ?", episode.ID).Update("settings_json", string(raw)).Error; err != nil {
		t.Fatal(err)
	}
	result, err := fixture.svc.RetryFailedDramaEpisode("usr-drama", episode.ProjectID, episode.ID)
	if err != nil || result["jobs"] != 1 {
		t.Fatalf("retry existing count failure: %+v %v", result, err)
	}
	runDramaTicks(t, fixture.svc, episode.ProjectID, 1)
	if err := fixture.fake.db.First(&job, "id = ?", job.ID).Error; err != nil {
		t.Fatal(err)
	}
	if job.Status != model.DramaJobSucceeded || job.TaskID != task.ID || fixture.fake.byKind[model.DramaJobScript] != 0 {
		t.Fatalf("recovery must apply the original task without generating another script: job=%+v calls=%v", job, fixture.fake.byKind)
	}
	stored, err := fixture.svc.repo.DramaShots(episode.ID)
	if err != nil || len(stored) != len(shots) {
		t.Fatalf("all 29 original shots must be recovered: count=%d err=%v", len(stored), err)
	}
	for i := range stored {
		if stored[i].Action != shots[i].Action {
			t.Fatalf("recovery rewrote original shot %d: %+v", i+1, stored[i])
		}
	}
}
