package app

import (
	"testing"

	"yingce/backend/internal/model"
)

func TestDramaEpisodeRetryDuringJobSyncDoesNotDuplicateScript(t *testing.T) {
	for _, test := range []struct {
		name, text, failure string
		generated           int
	}{
		{
			name:      "replay-valid-result",
			text:      `{"shots":[{"scene":"旧车站","action":"少年推门","durationSeconds":3}]}`,
			failure:   "结果处理失败（保留原任务，重试不重复生成）：database is locked",
			generated: 0,
		},
		{
			name:      "regenerate-invalid-result",
			text:      `{"shots":[]}`,
			failure:   "分镜脚本解析失败：分镜脚本没有可用镜头",
			generated: 1,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			fixture := newDramaGuideRevisionFixture(t, model.DramaGuideStory)
			episode, _, _ := seedDramaScriptRetry(t, fixture, test.text, test.failure)
			p, err := fixture.svc.repo.DramaProduction(episode.ProjectID)
			if err != nil {
				t.Fatal(err)
			}
			run := &dramaRun{s: fixture.svc, project: &fixture.summary.Project, production: p, settings: parseDramaSettings(p.SettingsJSON), meta: parseDramaBibleMeta(p.BibleJSON)}
			if err := run.syncJobs(); err != nil {
				t.Fatal(err)
			}
			// 调度已读取活动作业；在其刷新制作版本前，用户恢复失败的原作业。
			result, err := fixture.svc.RetryFailedDramaEpisode("usr-drama", episode.ProjectID, episode.ID)
			if err != nil || result["jobs"] != 1 {
				t.Fatalf("retry: %v %v", result, err)
			}
			current, err := fixture.svc.repo.DramaProduction(episode.ProjectID)
			if err != nil {
				t.Fatal(err)
			}
			run.production.GuideStep, run.production.Revision = current.GuideStep, current.Revision
			run.settings = parseDramaSettings(current.SettingsJSON)
			if err := run.loadCasts(); err != nil {
				t.Fatal(err)
			}
			if err := run.plan(); err != nil {
				t.Fatal(err)
			}
			if err := run.persistJobs(); err != nil {
				t.Fatal(err)
			}
			jobs, err := fixture.svc.repo.DramaJobsByStatus(episode.ProjectID, model.DramaJobQueued, model.DramaJobRunning)
			if err != nil {
				t.Fatal(err)
			}
			active := 0
			for _, job := range jobs {
				if job.Kind == model.DramaJobScript && job.EpisodeID == episode.ID {
					active++
				}
			}
			if active != 1 {
				t.Fatalf("restored script slot must remain unique, got %d active jobs", active)
			}
			if err := run.dispatch(); err != nil {
				t.Fatal(err)
			}
			if actual := fixture.fake.byKind[model.DramaJobScript]; actual != test.generated {
				t.Fatalf("script generation calls = %d, want %d", actual, test.generated)
			}
		})
	}
}
