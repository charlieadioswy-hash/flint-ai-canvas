package app

import (
	"reflect"
	"strings"
	"testing"

	"yingce/backend/internal/model"
	"yingce/backend/internal/production"
)

func saveDramaEpisodeStyle(t *testing.T, svc *Service, projectID, episodeID, name, prompt string) DramaEpisodeStyle {
	t.Helper()
	current, err := svc.DramaEpisodeStyle("usr-drama", projectID, episodeID)
	if err != nil {
		t.Fatal(err)
	}
	current.Settings.StyleName, current.Settings.StylePrompt = name, prompt
	view, err := svc.UpdateDramaEpisodeStyle("usr-drama", projectID, episodeID, UpdateDramaEpisodeStyleRequest{
		ExpectedRevision: &current.Revision, ExpectedEpisodeRevision: &current.EpisodeRevision, Settings: &current.Settings,
	})
	if err != nil {
		t.Fatal(err)
	}
	if view.Revision != current.Revision+1 || view.EpisodeRevision != current.EpisodeRevision {
		t.Fatalf("style save must advance control version only: before=%+v after=%+v", current, view)
	}
	return view
}

func TestDramaEpisodeStyleSnapshotsFirstSettingsAndIsolatesEpisodeEdits(t *testing.T) {
	svc, fake, projectID, detail := dramaStudioFixture(t)
	episodes, _ := svc.repo.DramaEpisodes(projectID)
	p, _ := svc.repo.DramaProduction(projectID)
	if _, err := svc.UpdateDramaWorkflowStyle("usr-drama", projectID, UpdateDramaWorkflowStyleRequest{ExpectedRevision: &p.Revision, StyleName: "全剧初始默认", StylePrompt: "全剧初始默认画风"}); err != nil {
		t.Fatal(err)
	}
	initial, err := svc.DramaEpisodeStyle("usr-drama", projectID, detail.Episode.ID)
	if err != nil {
		t.Fatalf("initial settings: %+v %v", initial, err)
	}
	requests := len(fake.requests)
	saveDramaEpisodeStyle(t, svc, projectID, detail.Episode.ID, "本集独立风格", "只修改当前集的风格")
	p, _ = svc.repo.DramaProduction(projectID)
	if _, err := svc.UpdateDramaWorkflowStyle("usr-drama", projectID, UpdateDramaWorkflowStyleRequest{ExpectedRevision: &p.Revision, StyleName: "全剧新默认", StylePrompt: "全剧新默认画风"}); err != nil {
		t.Fatal(err)
	}
	first, _ := svc.DramaEpisodeStyle("usr-drama", projectID, detail.Episode.ID)
	second, _ := svc.DramaEpisodeStyle("usr-drama", projectID, episodes[1].ID)
	if first.Settings.StyleName != "本集独立风格" || first.Settings.StylePrompt != "只修改当前集的风格" {
		t.Fatalf("episode settings were overwritten: %+v", first)
	}
	if second.Settings.StylePrompt != initial.Settings.StylePrompt {
		t.Fatalf("untouched episode followed a later project edit: %+v", second)
	}
	saveDramaEpisodeStyle(t, svc, projectID, episodes[1].ID, "第二集水彩", "第二集独立水彩画风")
	first = saveDramaEpisodeStyle(t, svc, projectID, detail.Episode.ID, "", "")
	second, _ = svc.DramaEpisodeStyle("usr-drama", projectID, episodes[1].ID)
	if first.Settings.StyleName != "" || first.Settings.StylePrompt != "" || second.Settings.StylePrompt != "第二集独立水彩画风" {
		t.Fatalf("empty style reset crossed episode scope: first=%+v second=%+v", first, second)
	}
	if len(fake.requests) != requests {
		t.Fatal("saving style generated a task")
	}
}

func TestDramaEpisodeStyleSavePreservesExistingTextMediaAndVersions(t *testing.T) {
	svc, fake, projectID, detail := dramaStudioFixture(t)
	if err := fake.db.Model(&model.DramaEpisode{}).Where("id = ?", detail.Episode.ID).Updates(map[string]any{"final_resource_id": "existing-final", "final_stale": false}).Error; err != nil {
		t.Fatal(err)
	}
	if err := fake.db.Model(&model.DramaSegment{}).Where("id = ?", detail.Segments[0].ID).Updates(map[string]any{"video_prompt_override": "用户确认的完整旧画风提示词", "video_resource_id": "existing-video", "video_status": model.DramaMediaReady}).Error; err != nil {
		t.Fatal(err)
	}
	media := model.DramaShotMedia{ID: "style-existing-media", ProjectID: projectID, EpisodeID: detail.Episode.ID, ShotID: detail.Shots[0].ID, Kind: "image", Status: model.DramaMediaReady, ResourceID: "existing-image", ScriptHash: dramaShotScriptHash(detail.Shots[0]), ConfigJSON: `{"prompt":"已保存完整图片提示词"}`}
	if err := fake.db.Create(&media).Error; err != nil {
		t.Fatal(err)
	}
	beforeMedia, _ := svc.repo.DramaShotMedia(projectID, detail.Shots[0].ID, "image")
	beforeEpisode, _ := svc.repo.DramaEpisode(projectID, detail.Episode.ID)
	beforeShots, _ := svc.repo.DramaShots(detail.Episode.ID)
	beforeSegments, _ := svc.repo.DramaSegments(detail.Episode.ID)
	beforeCasts, _ := svc.repo.DramaCasts(projectID)
	beforeJobs, _ := svc.repo.DramaJobsByStatus(projectID, model.DramaJobQueued, model.DramaJobRunning)
	requests := len(fake.requests)
	saveDramaEpisodeStyle(t, svc, projectID, detail.Episode.ID, "本集油画", "本集独立油画风格")
	afterEpisode, _ := svc.repo.DramaEpisode(projectID, detail.Episode.ID)
	afterShots, _ := svc.repo.DramaShots(detail.Episode.ID)
	afterSegments, _ := svc.repo.DramaSegments(detail.Episode.ID)
	afterCasts, _ := svc.repo.DramaCasts(projectID)
	afterJobs, _ := svc.repo.DramaJobsByStatus(projectID, model.DramaJobQueued, model.DramaJobRunning)
	afterMedia, err := svc.repo.DramaShotMedia(projectID, detail.Shots[0].ID, "image")
	if err != nil {
		t.Fatal(err)
	}
	afterEpisode.SettingsJSON = beforeEpisode.SettingsJSON
	afterEpisode.UpdatedAt = beforeEpisode.UpdatedAt
	if !reflect.DeepEqual(beforeEpisode, afterEpisode) || !reflect.DeepEqual(beforeShots, afterShots) || !reflect.DeepEqual(beforeSegments, afterSegments) || !reflect.DeepEqual(beforeCasts, afterCasts) || !reflect.DeepEqual(beforeJobs, afterJobs) || !reflect.DeepEqual(beforeMedia, afterMedia) || len(fake.requests) != requests {
		t.Fatal("style save changed content, media, content revisions, shared assets or queued work")
	}
}

func TestDramaEpisodeStyleRejectsStaleInvalidOrForeignWrites(t *testing.T) {
	svc, _, projectID, detail := dramaStudioFixture(t)
	view, _ := svc.DramaEpisodeStyle("usr-drama", projectID, detail.Episode.ID)
	valid := UpdateDramaEpisodeStyleRequest{ExpectedRevision: &view.Revision, ExpectedEpisodeRevision: &view.EpisodeRevision, Settings: &view.Settings}
	stale := int64(-1)
	for _, tc := range []struct {
		name, user, episode string
		mutate              func(*UpdateDramaEpisodeStyleRequest)
	}{
		{name: "foreign user", user: "other", episode: detail.Episode.ID},
		{name: "foreign episode", user: "usr-drama", episode: "missing-episode"},
		{name: "missing production version", user: "usr-drama", episode: detail.Episode.ID, mutate: func(req *UpdateDramaEpisodeStyleRequest) { req.ExpectedRevision = nil }},
		{name: "missing episode version", user: "usr-drama", episode: detail.Episode.ID, mutate: func(req *UpdateDramaEpisodeStyleRequest) { req.ExpectedEpisodeRevision = nil }},
		{name: "missing settings", user: "usr-drama", episode: detail.Episode.ID, mutate: func(req *UpdateDramaEpisodeStyleRequest) { req.Settings = nil }},
		{name: "oversized prompt", user: "usr-drama", episode: detail.Episode.ID, mutate: func(req *UpdateDramaEpisodeStyleRequest) {
			req.Settings.StylePrompt = strings.Repeat("中", production.MaxStylePromptRunes+1)
		}},
		{name: "invalid version", user: "usr-drama", episode: detail.Episode.ID, mutate: func(req *UpdateDramaEpisodeStyleRequest) { req.ExpectedRevision = &stale }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := valid
			settings := *valid.Settings
			req.Settings = &settings
			if tc.mutate != nil {
				tc.mutate(&req)
			}
			if _, err := svc.UpdateDramaEpisodeStyle(tc.user, projectID, tc.episode, req); err == nil {
				t.Fatal("invalid style write accepted")
			}
		})
	}
	for _, field := range []string{"production", "episode"} {
		req := valid
		wrong := view.Revision + 1
		if field == "production" {
			req.ExpectedRevision = &wrong
		} else {
			wrong = view.EpisodeRevision + 1
			req.ExpectedEpisodeRevision = &wrong
		}
		if _, err := svc.UpdateDramaEpisodeStyle("usr-drama", projectID, detail.Episode.ID, req); !isAppErrorStatus(err, 409) {
			t.Fatalf("stale %s version: %v", field, err)
		}
	}
	after, _ := svc.DramaEpisodeStyle("usr-drama", projectID, detail.Episode.ID)
	if !reflect.DeepEqual(view, after) {
		t.Fatalf("rejected writes changed state: before=%+v after=%+v", view, after)
	}
	if _, err := svc.DramaEpisodeStyle("other", projectID, detail.Episode.ID); err == nil {
		t.Fatal("foreign owner read accepted")
	}
}

func TestDramaLongStylePromptRoundTripsAcrossScopes(t *testing.T) {
	svc, _, projectID, detail := dramaStudioFixture(t)
	for _, prompt := range []string{strings.Repeat("水", 1400) + "完整系统预设末尾", strings.Repeat("🎨", production.MaxStylePromptRunes)} {
		p, _ := svc.repo.DramaProduction(projectID)
		summary, err := svc.UpdateDramaWorkflowStyle("usr-drama", projectID, UpdateDramaWorkflowStyleRequest{ExpectedRevision: &p.Revision, StyleName: "完整默认", StylePrompt: prompt})
		if err != nil || summary.Production.Settings.StylePrompt != prompt {
			t.Fatalf("project style was rejected or truncated: %v", err)
		}
		casts, _ := svc.repo.DramaCasts(projectID)
		preview, err := svc.PreviewDramaCastImagePrompt("usr-drama", projectID, casts[0].ID, DramaCastImagePromptRequest{})
		if err != nil || !strings.Contains(preview, prompt) {
			t.Fatalf("asset image prompt truncated the saved default style: %v", err)
		}
		saved := saveDramaEpisodeStyle(t, svc, projectID, detail.Episode.ID, "完整本集", prompt)
		loaded, err := svc.DramaEpisodeStyle("usr-drama", projectID, detail.Episode.ID)
		if err != nil || saved.Settings.StylePrompt != prompt || loaded.Settings.StylePrompt != prompt {
			t.Fatalf("episode style was rejected or truncated: %v", err)
		}
	}
}

func TestDramaStylePromptLimitAppliesToCreationAndSettings(t *testing.T) {
	svc, _ := newDramaTestService(t)
	settings := DramaSettings{Models: fakeDramaModels, MediaMode: DramaMediaManual, EpisodeMode: DramaEpisodeModeChapter, ChaptersPerEpisode: 1}
	settings.StylePrompt = strings.Repeat("水", 1400) + "完整创建风格末尾"
	input := CreateDramaRequest{Name: "完整长风格", Settings: settings, Chapters: []DramaChapterInput{{Text: "少年走入庭院。"}}}
	created, err := svc.CreateDrama("usr-drama", input)
	if err != nil || created.Production.Settings.StylePrompt != settings.StylePrompt {
		t.Fatalf("creation truncated a valid long style: %v", err)
	}
	settings.StylePrompt = strings.Repeat("🎨", production.MaxStylePromptRunes)
	saved, err := svc.UpdateDramaSettings("usr-drama", created.Project.ID, UpdateDramaSettingsRequest{Settings: &settings})
	if err != nil || saved.Production.Settings.StylePrompt != settings.StylePrompt {
		t.Fatalf("settings save truncated a valid long style: %v", err)
	}
	settings.StylePrompt += "超"
	input.Settings = settings
	if _, err := svc.CreateDrama("usr-drama", input); !isAppErrorStatus(err, 400) || !strings.Contains(err.Error(), "10000") {
		t.Fatalf("creation must reject oversized style before normalization: %v", err)
	}
	if _, err := svc.UpdateDramaSettings("usr-drama", created.Project.ID, UpdateDramaSettingsRequest{Settings: &settings}); !isAppErrorStatus(err, 400) || !strings.Contains(err.Error(), "10000") {
		t.Fatalf("settings must reject oversized style before normalization: %v", err)
	}
	loaded, err := svc.DramaSummary("usr-drama", created.Project.ID)
	if err != nil || loaded.Production.Revision != saved.Production.Revision || loaded.Production.Settings.StylePrompt != saved.Production.Settings.StylePrompt {
		t.Fatalf("rejected oversized style changed saved settings: %v", err)
	}
}

func TestDramaEpisodeStyleRejectsActiveTextJobs(t *testing.T) {
	for _, kind := range []string{model.DramaJobScript, model.DramaJobSegmentPrompt} {
		for _, status := range []string{model.DramaJobQueued, model.DramaJobRunning} {
			t.Run(kind+"/"+status, func(t *testing.T) {
				svc, fake, projectID, detail := dramaStudioFixture(t)
				view, _ := svc.DramaEpisodeStyle("usr-drama", projectID, detail.Episode.ID)
				job := model.DramaJob{ID: "style-active-text", ProjectID: projectID, EpisodeID: detail.Episode.ID, Kind: kind, Status: status}
				if err := fake.db.Create(&job).Error; err != nil {
					t.Fatal(err)
				}
				_, err := svc.UpdateDramaEpisodeStyle("usr-drama", projectID, detail.Episode.ID, UpdateDramaEpisodeStyleRequest{ExpectedRevision: &view.Revision, ExpectedEpisodeRevision: &view.EpisodeRevision, Settings: &view.Settings})
				if !isAppErrorStatus(err, 409) {
					t.Fatalf("active text task accepted style edit: %v", err)
				}
				after, _ := svc.DramaEpisodeStyle("usr-drama", projectID, detail.Episode.ID)
				if !reflect.DeepEqual(view, after) {
					t.Fatal("blocked style save changed state")
				}
			})
		}
	}
}

func TestDramaEpisodeStyleReachesExplicitScriptAndSegmentPromptWriting(t *testing.T) {
	for _, mode := range []string{"initial", "edited"} {
		t.Run(mode, func(t *testing.T) {
			svc, fake, projectID, detail := dramaStudioFixture(t)
			p, _ := svc.repo.DramaProduction(projectID)
			settings := parseDramaSettings(p.SettingsJSON)
			settings.StyleName, settings.StylePrompt = "作品默认", "全剧默认风格独有标记"
			if err := svc.repo.UpdateDramaProduction(projectID, map[string]any{"settings_json": encodeDramaSettings(settings), "bible_json": `{"visualRules":"全剧旧画面规则独有标记"}`}); err != nil {
				t.Fatal(err)
			}
			if mode == "edited" {
				const suffix = "本集水彩独有标记"
				// 上限内的末尾约束必须同时进入分镜和段提示词，不能被其中一个入口静默截掉。
				prompt := strings.Repeat("水", production.MaxStylePromptRunes-len([]rune(suffix))) + suffix
				saveDramaEpisodeStyle(t, svc, projectID, detail.Episode.ID, "本集水彩", prompt)
			} else {
				if err := fake.db.Model(&model.DramaEpisode{}).Where("id = ?", detail.Episode.ID).Update("settings_json", encodeDramaSettings(settings)).Error; err != nil {
					t.Fatal(err)
				}
			}
			if err := fake.db.Model(&model.DramaEpisode{}).Where("id = ?", detail.Episode.ID).Update("stage", model.DramaEpisodeScript).Error; err != nil {
				t.Fatal(err)
			}
			p, _ = svc.repo.DramaProduction(projectID)
			project, _ := svc.repo.ProjectForUser("usr-drama", projectID)
			run := &dramaRun{s: svc, project: project, production: p, settings: parseDramaSettings(p.SettingsJSON), meta: parseDramaBibleMeta(p.BibleJSON)}
			if err := run.loadCasts(); err != nil {
				t.Fatal(err)
			}
			script, skip, err := run.submitScript(&model.DramaJob{ID: "style-script", ProjectID: projectID, EpisodeID: detail.Episode.ID, Kind: model.DramaJobScript})
			if err != nil || skip || script == nil {
				t.Fatalf("script submission: %+v %v %v", script, skip, err)
			}
			if err := fake.db.Model(&model.DramaSegment{}).Where("id = ?", detail.Segments[0].ID).Update("prompt_status", "").Error; err != nil {
				t.Fatal(err)
			}
			prompt, skip, err := run.submitSegmentPrompt(&model.DramaJob{ID: "style-segment-prompt", ProjectID: projectID, EpisodeID: detail.Episode.ID, ShotID: detail.Segments[0].ID, Kind: model.DramaJobSegmentPrompt})
			if err != nil || skip || prompt == nil {
				t.Fatalf("segment prompt submission: %+v %v %v", prompt, skip, err)
			}
			for _, task := range []*model.Task{script, prompt} {
				if mode == "edited" {
					if !strings.Contains(task.Prompt, "本集水彩独有标记") || !strings.Contains(task.Prompt, "保持本集视觉风格统一") || strings.Contains(task.Prompt, "全剧默认风格独有标记") || strings.Contains(task.Prompt, "全剧旧画面规则独有标记") {
						t.Fatalf("independent episode used global style or rules: %s", task.Prompt)
					}
				} else if !strings.Contains(task.Prompt, "全剧默认风格独有标记") || !strings.Contains(task.Prompt, "全剧旧画面规则独有标记") {
					t.Fatalf("inherited style/rules missing: %s", task.Prompt)
				}
			}
		})
	}
}

func TestDramaEpisodeStyleReachesExplicitSegmentResplit(t *testing.T) {
	svc, db, req := sceneSplitFixture(t)
	p, _ := svc.repo.DramaProduction("scene-project")
	settings := parseDramaSettings(p.SettingsJSON)
	settings.StyleName, settings.StylePrompt = "本集水彩", "本集重拆水彩标记"
	if err := db.Model(&model.DramaEpisode{}).Where("id = ?", "scene-episode").Update("settings_json", encodeDramaSettings(settings)).Error; err != nil {
		t.Fatal(err)
	}
	plan, err := svc.prepareDramaSceneSplit(svc.repo, "user", "scene-project", "scene-episode", req)
	if err != nil || !plan.view.Ready || !strings.Contains(plan.request.Prompt, "本集重拆水彩标记") {
		t.Fatalf("resplit ignored independent style: %+v %v", plan.view, err)
	}
}

func TestDramaEpisodeStyleKeepsSavedCompleteVideoPromptAndInvalidatesOldConfirmation(t *testing.T) {
	svc, fake, projectID, detail := dramaStudioFixture(t)
	const saved = "用户已确认的完整视频提示词，继续保留原有画风和全部人工约束"
	if err := fake.db.Model(&model.DramaSegment{}).Where("id = ?", detail.Segments[0].ID).Update("video_prompt_override", saved).Error; err != nil {
		t.Fatal(err)
	}
	preflight, err := svc.PreflightDramaStudioAction("usr-drama", projectID, DramaStudioActionRequest{Action: "segment_video", TargetID: detail.Segments[0].ID})
	if err != nil || !preflight.Ready {
		t.Fatalf("preflight: %+v %v", preflight, err)
	}
	saveDramaEpisodeStyle(t, svc, projectID, detail.Episode.ID, "本集新风格", "只用于后续明确撰写的新风格标记")
	if _, err := svc.ExecuteDramaStudioAction("usr-drama", projectID, confirmedDramaStudioRequest(preflight)); err == nil {
		t.Fatal("style save left old generation confirmation valid")
	}
	preflight, err = svc.PreflightDramaStudioAction("usr-drama", projectID, DramaStudioActionRequest{Action: "segment_video", TargetID: detail.Segments[0].ID})
	if err != nil || !preflight.Ready {
		t.Fatalf("fresh preflight: %+v %v", preflight, err)
	}
	if _, err := svc.ExecuteDramaStudioAction("usr-drama", projectID, confirmedDramaStudioRequest(preflight)); err != nil {
		t.Fatal(err)
	}
	runDramaTicks(t, svc, projectID, 10)
	requests := dramaVideoRequests(fake)
	if len(requests) != 1 || !strings.Contains(requests[0].Prompt, saved) || strings.Contains(requests[0].Prompt, "只用于后续明确撰写的新风格标记") {
		t.Fatalf("explicit generation rewrote saved complete prompt: %+v", requests)
	}
}
