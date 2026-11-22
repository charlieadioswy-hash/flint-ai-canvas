package app

import (
	"reflect"
	"testing"

	"yingce/backend/internal/model"
	"yingce/backend/internal/production"
)

func TestDramaEpisodeSettingsSaveKeepsModelsTemplatesAndParametersLocal(t *testing.T) {
	svc, fake, projectID, detail := dramaStudioFixture(t)
	view, _ := svc.DramaEpisodeStyle("usr-drama", projectID, detail.Episode.ID)
	before, _ := svc.repo.DramaProduction(projectID)
	episodes, _ := svc.repo.DramaEpisodes(projectID)
	other, _ := svc.DramaEpisodeStyle("usr-drama", projectID, episodes[1].ID)
	drawing := dramaDrawingTestConfiguration(t, fake)
	next := applyDramaDrawingConfiguration(view.Settings, &drawing)
	next.StyleName, next.StylePrompt, next.Language = "本集水彩", "本集水彩说明", "粤语"
	next.AspectRatio, next.EpisodeSeconds, next.ReferenceLimit = "16:9", 180, 2
	next.Storyboard.Pacing, next.Storyboard.TargetShotCount = "fast", 12
	next.Concurrency, next.ReviewMode, next.MediaMode = 1, DramaReviewAuto, DramaMediaAuto
	next.EpisodeMode, next.ChaptersPerEpisode = DramaEpisodeModeAuto, 4
	saved, err := svc.UpdateDramaEpisodeStyle("usr-drama", projectID, detail.Episode.ID, UpdateDramaEpisodeStyleRequest{ExpectedRevision: &view.Revision, ExpectedEpisodeRevision: &view.EpisodeRevision, Settings: &next})
	if err != nil {
		t.Fatal(err)
	}
	loaded, err := svc.DramaEpisodeStyle("usr-drama", projectID, detail.Episode.ID)
	if err != nil || !reflect.DeepEqual(saved.Settings, loaded.Settings) {
		t.Fatalf("complete settings did not round-trip: %v", err)
	}
	expected := dramaProjectControls(next.normalized(), parseDramaSettings(before.SettingsJSON))
	if !reflect.DeepEqual(loaded.Settings, expected) {
		t.Fatalf("models, templates or parameters were lost: got %+v want %+v", loaded.Settings, expected)
	}
	after, _ := svc.repo.DramaProduction(projectID)
	otherAfter, _ := svc.DramaEpisodeStyle("usr-drama", projectID, episodes[1].ID)
	if after.SettingsJSON != before.SettingsJSON || after.InitialSettingsJSON != before.InitialSettingsJSON || !reflect.DeepEqual(other.Settings, otherAfter.Settings) {
		t.Fatal("episode settings changed production defaults or another episode")
	}
}

func TestDramaEpisodeSettingsNewEpisodesCopyFirstConfiguration(t *testing.T) {
	svc, _ := newDramaTestService(t)
	settings := DramaSettings{Models: fakeDramaModels, MediaMode: DramaMediaManual, EpisodeMode: DramaEpisodeModeChapter, ChaptersPerEpisode: 1}
	settings.StyleName, settings.StylePrompt = "首次画风", "只作为首次配置"
	settings.AspectRatio, settings.Language = "16:9", "粤语"
	created, err := svc.CreateDrama("usr-drama", CreateDramaRequest{Name: "初值作品", Settings: settings, SelectedChapters: []int{0}, Chapters: []DramaChapterInput{{Text: "首集正文"}, {Text: "预留章节正文"}}})
	if err != nil {
		t.Fatal(err)
	}
	p, _ := svc.repo.DramaProduction(created.Project.ID)
	initial := parseDramaSettings(p.InitialSettingsJSON)
	changed := initial
	changed.StyleName, changed.StylePrompt, changed.Language = "后来默认", "后来默认说明", "英语"
	if err := svc.repo.UpdateDramaProduction(p.ProjectID, map[string]any{"settings_json": encodeDramaSettings(changed)}); err != nil {
		t.Fatal(err)
	}
	p, _ = svc.repo.DramaProduction(p.ProjectID)
	added, err := svc.AddDramaEpisode("usr-drama", p.ProjectID, AddDramaEpisodeRequest{ExpectedRevision: &p.Revision, Text: "后面追加集正文", SourceFormat: production.SourceScript})
	if err != nil {
		t.Fatal(err)
	}
	if added.Episode.SettingsJSON != p.InitialSettingsJSON {
		t.Fatal("appended episode copied later defaults")
	}
	p, _ = svc.repo.DramaProduction(p.ProjectID)
	chapters, _ := svc.repo.DramaChapterOutline(p.ProjectID)
	var reserved string
	for _, chapter := range chapters {
		if chapter.Status == model.ProjectUnitStatusReserved {
			reserved = chapter.ID
		}
	}
	produced, err := svc.ProduceDramaChapters("usr-drama", p.ProjectID, ProduceDramaChaptersRequest{ExpectedRevision: &p.Revision, ChapterIDs: []string{reserved}})
	if err != nil {
		t.Fatal(err)
	}
	row, _ := svc.repo.DramaEpisode(p.ProjectID, produced.EpisodeIDs[0])
	if row.SettingsJSON != p.InitialSettingsJSON {
		t.Fatal("reserved chapter copied later defaults")
	}
}

func TestDramaEpisodeSettingsGuideFinalizesInitialValuesWithoutOverwritingEdits(t *testing.T) {
	svc, _ := newDramaTestService(t)
	draft := createGuidedDrama(t, svc, DramaChapterInput{Text: "少年在庭院里见到老师。"})
	settings := draft.Production.Settings
	settings.StyleName, settings.StylePrompt, settings.Language = "最终首次画风", "配置阶段最终风格", "粤语"
	assets, err := svc.ConfirmDramaGuide("usr-drama", draft.Project.ID, ConfirmDramaGuideRequest{ExpectedStep: model.DramaGuideConfiguring, ExpectedRevision: draft.Production.Revision, Settings: &settings})
	if err != nil {
		t.Fatal(err)
	}
	row, _ := svc.repo.DramaEpisode(draft.Project.ID, assets.Episodes[0].ID)
	p, _ := svc.repo.DramaProduction(draft.Project.ID)
	if row.SettingsJSON != p.InitialSettingsJSON || parseDramaSettings(row.SettingsJSON).StylePrompt != settings.StylePrompt {
		t.Fatal("configuring confirmation retained the draft configuration")
	}
	runDramaTicks(t, svc, draft.Project.ID, 8)
	assets = guideSummary(t, svc, draft.Project.ID)
	local, _ := svc.DramaEpisodeStyle("usr-drama", draft.Project.ID, row.ID)
	local.Settings.Storyboard.TargetShotCount = 17
	local.Settings.StylePrompt = "本集自己的风格"
	saved, err := svc.UpdateDramaEpisodeStyle("usr-drama", draft.Project.ID, row.ID, UpdateDramaEpisodeStyleRequest{ExpectedRevision: &local.Revision, ExpectedEpisodeRevision: &local.EpisodeRevision, Settings: &local.Settings})
	if err != nil {
		t.Fatal(err)
	}
	settings = assets.Production.Settings
	settings.Storyboard.TargetShotCount = 9
	settings.AspectRatio = "16:9"
	if _, err := svc.ConfirmDramaGuide("usr-drama", draft.Project.ID, ConfirmDramaGuideRequest{ExpectedStep: model.DramaGuideAssets, ExpectedRevision: saved.Revision, Settings: &settings}); err != nil {
		t.Fatal(err)
	}
	final, _ := svc.DramaEpisodeStyle("usr-drama", draft.Project.ID, row.ID)
	p, _ = svc.repo.DramaProduction(draft.Project.ID)
	initial := parseDramaSettings(p.InitialSettingsJSON)
	if initial.Storyboard.TargetShotCount != 9 || initial.AspectRatio != "16:9" || final.Settings.Storyboard.TargetShotCount != 17 || final.Settings.StylePrompt != "本集自己的风格" || final.Settings.AspectRatio != "16:9" {
		t.Fatalf("guide finalization overwrote local edits or missed untouched initial fields: initial=%+v final=%+v", initial, final.Settings)
	}
}

func TestDramaEpisodeSettingsDeferredPlanningCopiesFirstConfiguration(t *testing.T) {
	for _, mode := range []string{DramaEpisodeModeAuto, DramaEpisodeModeChapter} {
		t.Run(mode, func(t *testing.T) {
			svc, _ := newDramaTestService(t)
			settings := DramaSettings{Models: fakeDramaModels, MediaMode: DramaMediaManual, EpisodeMode: DramaEpisodeModeAuto}
			settings.StyleName, settings.StylePrompt = "首次默认", "保留第一次配置"
			created, err := svc.CreateDrama("usr-drama", CreateDramaRequest{Name: "等待规划", Start: true, Settings: settings, Chapters: []DramaChapterInput{{Text: "少年在庭院见到老师。"}, {Text: "少年和老师一起走到山上。"}}})
			if err != nil {
				t.Fatal(err)
			}
			p, _ := svc.repo.DramaProduction(created.Project.ID)
			changed := parseDramaSettings(p.SettingsJSON)
			changed.StyleName, changed.StylePrompt = "后来默认", "不能传给新规划的集"
			changed.EpisodeMode, changed.ChaptersPerEpisode = mode, 1
			if err := svc.repo.UpdateDramaProduction(p.ProjectID, map[string]any{"settings_json": encodeDramaSettings(changed)}); err != nil {
				t.Fatal(err)
			}
			runDramaTicks(t, svc, p.ProjectID, 16)
			episodes, err := svc.repo.DramaEpisodes(p.ProjectID)
			if err != nil || len(episodes) == 0 {
				t.Fatalf("deferred planning did not create episodes: %v", err)
			}
			for _, episode := range episodes {
				if episode.SettingsJSON != p.InitialSettingsJSON {
					t.Fatalf("%s created an episode from later defaults", mode)
				}
			}
		})
	}
}

func TestDramaEpisodeSettingsDeletePreservesQueuedImageContext(t *testing.T) {
	svc, fake, projectID, detail := dramaStudioFixture(t)
	casts, _ := svc.repo.DramaCasts(projectID)
	castID := casts[0].ID
	if err := fake.db.Model(&model.DramaCast{}).Where("id = ?", castID).Updates(map[string]any{"image_episode_id": detail.Episode.ID, "image_status": model.DramaMediaQueued}).Error; err != nil {
		t.Fatal(err)
	}
	if err := svc.DeleteDramaEpisode("usr-drama", projectID, detail.Episode.ID, model.DramaEpisodeDefaultTitle(detail.Episode.Number)); !isAppErrorStatus(err, 409) {
		t.Fatalf("deleting an image request's configuration was allowed: %v", err)
	}
	if err := fake.db.Model(&model.DramaCast{}).Where("id = ?", castID).Update("image_status", model.DramaMediaReady).Error; err != nil {
		t.Fatal(err)
	}
	if err := svc.DeleteDramaEpisode("usr-drama", projectID, detail.Episode.ID, model.DramaEpisodeDefaultTitle(detail.Episode.Number)); err != nil {
		t.Fatal(err)
	}
	cast, err := svc.repo.DramaCast(projectID, castID)
	if err != nil || cast.ImageEpisodeID != "" {
		t.Fatalf("deleted episode left an orphan image context: %+v %v", cast, err)
	}
}

func TestDramaEpisodeSettingsRejectQueuedAndRunningMedia(t *testing.T) {
	for _, kind := range []string{"job", "segment", "shot", "storyboard", "cast"} {
		for _, status := range []string{model.DramaMediaQueued, model.DramaMediaRunning} {
			t.Run(kind+"/"+status, func(t *testing.T) {
				svc, fake, projectID, detail := dramaStudioFixture(t)
				view, _ := svc.DramaEpisodeStyle("usr-drama", projectID, detail.Episode.ID)
				var err error
				switch kind {
				case "job":
					err = fake.db.Create(&model.DramaJob{ID: "busy-video", ProjectID: projectID, EpisodeID: detail.Episode.ID, Kind: model.DramaJobSegmentVideo, Status: status}).Error
				case "segment":
					err = fake.db.Model(&model.DramaSegment{}).Where("id = ?", detail.Segments[0].ID).Update("video_status", status).Error
				case "shot":
					err = fake.db.Create(&model.DramaShotMedia{ID: "busy-shot", ProjectID: projectID, EpisodeID: detail.Episode.ID, ShotID: detail.Shots[0].ID, Kind: "image", Status: status}).Error
				case "storyboard":
					task := model.Task{ID: "busy-board-task", ProjectID: projectID, UserID: "usr-drama", Type: "canvas_image", Status: model.TaskStatus(status)}
					if err := fake.db.Create(&task).Error; err != nil {
						t.Fatal(err)
					}
					err = fake.db.Create(&model.DramaStoryboardBoard{ID: "busy-board", ProjectID: projectID, EpisodeID: detail.Episode.ID, TaskID: task.ID, Status: status}).Error
				case "cast":
					casts, _ := svc.repo.DramaCasts(projectID)
					err = fake.db.Model(&model.DramaCast{}).Where("id = ?", casts[0].ID).Updates(map[string]any{"image_episode_id": detail.Episode.ID, "image_status": status}).Error
				}
				if err != nil {
					t.Fatal(err)
				}
				next := view.Settings
				next.StylePrompt = "本次不应保存"
				if _, err := svc.UpdateDramaEpisodeStyle("usr-drama", projectID, detail.Episode.ID, UpdateDramaEpisodeStyleRequest{ExpectedRevision: &view.Revision, ExpectedEpisodeRevision: &view.EpisodeRevision, Settings: &next}); !isAppErrorStatus(err, 409) {
					t.Fatalf("media in progress accepted a configuration change: %v", err)
				}
				after, _ := svc.DramaEpisodeStyle("usr-drama", projectID, detail.Episode.ID)
				if !reflect.DeepEqual(view, after) {
					t.Fatal("blocked media configuration save changed state")
				}
			})
		}
	}
}

func TestDramaEpisodeSettingsDraftFinalizesBeforeStarting(t *testing.T) {
	for _, operation := range []string{"settings", "start"} {
		t.Run(operation, func(t *testing.T) {
			svc, _ := newDramaTestService(t)
			settings := DramaSettings{Models: fakeDramaModels, MediaMode: DramaMediaManual, EpisodeMode: DramaEpisodeModeChapter, ChaptersPerEpisode: 1}
			created, err := svc.CreateDrama("usr-drama", CreateDramaRequest{Name: "准备开工", Settings: settings, Chapters: []DramaChapterInput{{Text: "首集正文"}, {Text: "第二集正文"}}})
			if err != nil {
				t.Fatal(err)
			}
			projectID := created.Project.ID
			saveDramaEpisodeStyle(t, svc, projectID, created.Episodes[0].ID, "本集已修改", "本集自己的风格")
			p, _ := svc.repo.DramaProduction(projectID)
			if operation == "settings" {
				next := parseDramaSettings(p.SettingsJSON)
				next.StyleName, next.StylePrompt = "正式默认", "用户正式开工配置"
				next.AspectRatio, next.Language = "16:9", "粤语"
				if _, err := svc.UpdateDramaSettings("usr-drama", projectID, UpdateDramaSettingsRequest{ExpectedRevision: &p.Revision, Settings: &next}); err != nil {
					t.Fatal(err)
				}
			} else {
				if _, err := svc.UpdateDramaWorkflowStyle("usr-drama", projectID, UpdateDramaWorkflowStyleRequest{ExpectedRevision: &p.Revision, StyleName: "正式默认", StylePrompt: "用户正式开工配置"}); err != nil {
					t.Fatal(err)
				}
				if _, err := svc.SetDramaRunning("usr-drama", projectID, true); err != nil {
					t.Fatal(err)
				}
			}
			p, _ = svc.repo.DramaProduction(projectID)
			initial := parseDramaSettings(p.InitialSettingsJSON)
			local, _ := svc.DramaEpisodeStyle("usr-drama", projectID, created.Episodes[0].ID)
			untouched, _ := svc.DramaEpisodeStyle("usr-drama", projectID, created.Episodes[1].ID)
			if initial.StylePrompt != "用户正式开工配置" || local.Settings.StylePrompt != "本集自己的风格" || untouched.Settings.StylePrompt != initial.StylePrompt {
				t.Fatalf("draft finalization lost the final default or local edits: initial=%+v local=%+v untouched=%+v", initial, local.Settings, untouched.Settings)
			}
			if operation == "settings" && (local.Settings.AspectRatio != "16:9" || local.Settings.Language != "粤语") {
				t.Fatal("draft finalization did not merge untouched configuration fields")
			}
		})
	}
}

func TestDramaEpisodeSettingsResumeAllowsMediaRevisionButRejectsChangedConfiguration(t *testing.T) {
	for _, field := range []string{"media_requests_only", "settings_json"} {
		t.Run(field, func(t *testing.T) {
			svc, _ := newDramaTestService(t)
			created, err := svc.CreateDrama("usr-drama", CreateDramaRequest{Name: "待恢复作品", Settings: DramaSettings{Models: fakeDramaModels, MediaMode: DramaMediaManual, EpisodeMode: DramaEpisodeModeChapter, ChaptersPerEpisode: 1}, Chapters: []DramaChapterInput{{Text: "正文"}}})
			if err != nil {
				t.Fatal(err)
			}
			p, _ := svc.repo.DramaProduction(created.Project.ID)
			fields := map[string]any{field: true}
			if field == "settings_json" {
				changed := parseDramaSettings(p.SettingsJSON)
				changed.StylePrompt = "另一个页面刚保存的配置"
				fields[field] = encodeDramaSettings(changed)
			}
			if err := svc.repo.UpdateDramaProduction(p.ProjectID, fields); err != nil {
				t.Fatal(err)
			}
			err = svc.resumeDrama(p)
			if field == "settings_json" {
				if !isAppErrorStatus(err, 409) {
					t.Fatalf("resume overwrote newly saved settings: %v", err)
				}
			} else if err != nil {
				t.Fatalf("media authorization revision prevented resume: %v", err)
			}
		})
	}
}
