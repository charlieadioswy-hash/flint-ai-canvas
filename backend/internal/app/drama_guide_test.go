package app

import (
	"encoding/json"
	"errors"
	"net/http"
	"testing"

	"yingce/backend/internal/model"
	"yingce/backend/internal/production"
	"yingce/backend/internal/repository"
)

func createGuidedDrama(t *testing.T, svc *Service, chapters ...DramaChapterInput) DramaSummary {
	t.Helper()
	settings := DramaSettings{ReviewMode: DramaReviewAuto, MediaMode: DramaMediaAuto, Concurrency: 16, Models: fakeDramaModels, EpisodeMode: DramaEpisodeModeChapter, ChaptersPerEpisode: 1}
	summary, err := svc.CreateDrama("usr-drama", CreateDramaRequest{Name: "引导作品", Guided: true, Start: true, Brief: "一个少年与命运抗争的故事", Settings: settings, Chapters: chapters})
	if err != nil {
		t.Fatal(err)
	}
	return summary
}

func confirmGuide(t *testing.T, svc *Service, summary DramaSummary) DramaSummary {
	t.Helper()
	next, err := svc.ConfirmDramaGuide("usr-drama", summary.Project.ID, ConfirmDramaGuideRequest{ExpectedStep: summary.Production.GuideStep, ExpectedRevision: summary.Production.Revision})
	if err != nil {
		t.Fatal(err)
	}
	return next
}

func guideSummary(t *testing.T, svc *Service, projectID string) DramaSummary {
	t.Helper()
	summary, err := svc.DramaSummary("usr-drama", projectID)
	if err != nil {
		t.Fatal(err)
	}
	return summary
}

func requireGuideConflict(t *testing.T, err error) {
	t.Helper()
	var appErr *AppError
	if !errors.As(err, &appErr) || appErr.Status != http.StatusConflict {
		t.Fatalf("want guide conflict, got %v", err)
	}
}

func TestDramaGuideBriefToWorkbenchWithoutMedia(t *testing.T) {
	svc, fake := newDramaTestService(t)
	draft := createGuidedDrama(t, svc)
	projectID := draft.Project.ID
	if draft.Production.Status != model.DramaStatusDraft || draft.Guide == nil || draft.Guide.CanConfirm || draft.Production.Settings.MediaMode != DramaMediaManual {
		t.Fatalf("brief-only project must remain a manual draft: %+v", draft.Production)
	}
	if _, err := svc.SetDramaRunning("usr-drama", projectID, true); err == nil {
		t.Fatal("continue must not bypass configuration confirmation")
	}
	runDramaTicks(t, svc, projectID, 3)
	if len(fake.requests) != 0 {
		t.Fatalf("draft must not dispatch work: %v", fake.byKind)
	}
	withSource, err := svc.UpdateDramaGuideSource("usr-drama", projectID, UpdateDramaGuideSourceRequest{ExpectedRevision: draft.Production.Revision, Chapters: []DramaChapterInput{{Title: "退婚", Text: "萧炎遭遇退婚。"}, {Title: "立誓", Text: "少年立下三年之约。"}}})
	if err != nil {
		t.Fatal(err)
	}
	if !withSource.Guide.CanConfirm || withSource.Production.Revision != draft.Production.Revision+1 {
		t.Fatalf("saving source must advance the shared revision once: %+v", withSource)
	}
	assets := confirmGuide(t, svc, withSource)
	runDramaTicks(t, svc, projectID, 8)
	assets = guideSummary(t, svc, projectID)
	if assets.Production.GuideStep != model.DramaGuideAssets || !assets.Guide.CanConfirm || fake.byKind["bible"] != 1 || fake.byKind["script"] != 0 || fake.byKind["image"] != 0 {
		t.Fatalf("asset confirmation must hold all downstream work: %+v %v", assets.Guide, fake.byKind)
	}
	if assets.Production.Revision <= withSource.Production.Revision+1 {
		t.Fatal("applying generated asset text must invalidate old proposals")
	}
	story := confirmGuide(t, svc, assets)
	runDramaTicks(t, svc, projectID, 20)
	story = guideSummary(t, svc, projectID)
	if story.Guide == nil || !story.Guide.CanConfirm || fake.byKind["script"] != 2 || fake.byKind["segment_prompt"] == 0 {
		t.Fatalf("all scripts and prompts must be ready for final confirmation: %+v %v", story.Guide, fake.byKind)
	}
	completed := confirmGuide(t, svc, story)
	runDramaTicks(t, svc, projectID, 4)
	if completed.Production.GuideStep != model.DramaGuideCompleted || completed.Production.AssetsReleased || completed.Production.SampleApproved {
		t.Fatalf("finishing guidance must not release media or approve a sample: %+v", completed.Production)
	}
	for _, episode := range completed.Episodes {
		row, err := svc.repo.DramaEpisode(projectID, episode.ID)
		if err != nil || !row.Approved || row.MediaReleased || row.Stage != model.DramaEpisodeReview {
			t.Fatalf("workbench entry must keep media held: %+v %v", row, err)
		}
	}
	if fake.byKind["image"]+fake.byKind["video"]+fake.byKind["render"] != 0 {
		t.Fatalf("zero images must still complete the guide without paid media: %v", fake.byKind)
	}
	_, err = svc.ConfirmDramaGuide("usr-drama", projectID, ConfirmDramaGuideRequest{ExpectedStep: model.DramaGuideStory, ExpectedRevision: story.Production.Revision})
	requireGuideConflict(t, err)
}

func TestDramaGuideSourceReplacementRebuildsUnstartedEpisodes(t *testing.T) {
	svc, _ := newDramaTestService(t)
	draft := createGuidedDrama(t, svc, DramaChapterInput{Title: "旧章节", Text: "旧正文"})
	oldEpisodeID := draft.Episodes[0].ID
	next, err := svc.UpdateDramaGuideSource("usr-drama", draft.Project.ID, UpdateDramaGuideSourceRequest{ExpectedRevision: draft.Production.Revision, SourceFormat: production.SourceScript, Chapters: []DramaChapterInput{{Title: "新一集", Text: "甲：你好。"}, {Title: "新二集", Text: "乙：再见。"}}})
	if err != nil {
		t.Fatal(err)
	}
	if len(next.Episodes) != 2 || next.Production.Revision != draft.Production.Revision+1 || next.Episodes[0].ID == oldEpisodeID {
		t.Fatalf("source replacement must remove draft episode references: %+v", next)
	}
	for _, episode := range next.Episodes {
		row, err := svc.repo.DramaEpisode(draft.Project.ID, episode.ID)
		if err != nil || row.SourceFormat != production.SourceScript || len(decodeStringList(row.ChapterIDsJSON)) != 1 {
			t.Fatalf("replacement episodes must reference the replacement script: %+v %v", row, err)
		}
		if _, err := svc.repo.DramaChaptersByIDs(draft.Project.ID, decodeStringList(row.ChapterIDsJSON)); err != nil {
			t.Fatal(err)
		}
	}
	_, err = svc.UpdateDramaGuideSource("usr-drama", draft.Project.ID, UpdateDramaGuideSourceRequest{ExpectedRevision: draft.Production.Revision, Chapters: []DramaChapterInput{{Text: "过期正文"}}})
	requireGuideConflict(t, err)
}

func TestDramaGuideTextEditsRejectBusyAndStaleVersions(t *testing.T) {
	svc, fake := newDramaTestService(t)
	draft := createGuidedDrama(t, svc, DramaChapterInput{Title: "一", Text: "正文"})
	assets := confirmGuide(t, svc, draft)
	runDramaTicks(t, svc, draft.Project.ID, 1)
	chapters, err := svc.repo.DramaChapters(draft.Project.ID)
	if err != nil {
		t.Fatal(err)
	}
	text := "修改后的正文"
	_, err = svc.UpdateDramaChapter("usr-drama", draft.Project.ID, chapters[0].ID, UpdateDramaChapterRequest{ExpectedRevision: &assets.Production.Revision, Text: &text})
	requireGuideConflict(t, err)
	runDramaTicks(t, svc, draft.Project.ID, 4)
	assets = guideSummary(t, svc, draft.Project.ID)
	casts, err := svc.DramaCasts("usr-drama", draft.Project.ID)
	if err != nil || len(casts) == 0 {
		t.Fatalf("load assets: %v", err)
	}
	story := confirmGuide(t, svc, assets)
	appearance := "银发、蓝色长袍"
	_, err = svc.UpdateDramaCast("usr-drama", draft.Project.ID, casts[0].ID, UpdateDramaCastRequest{ExpectedRevision: &assets.Production.Revision, Appearance: &appearance})
	requireGuideConflict(t, err)
	_, err = svc.UpdateDramaCast("usr-drama", draft.Project.ID, casts[0].ID, UpdateDramaCastRequest{ExpectedRevision: &story.Production.Revision, Appearance: &appearance})
	if err != nil {
		t.Fatal(err)
	}
	after := guideSummary(t, svc, draft.Project.ID)
	if after.Production.GuideStep != model.DramaGuideAssets || after.Production.Revision != story.Production.Revision+1 || fake.byKind["image"] != 0 {
		t.Fatalf("asset change must return to asset review without spending on images: %+v %v", after.Production, fake.byKind)
	}
	if _, err := svc.ReleaseDramaMedia("usr-drama", draft.Project.ID, ReleaseDramaMediaRequest{Target: "all"}); err == nil {
		t.Fatal("media release cannot bypass guide confirmation")
	}
	if _, err := svc.ApproveDramaEpisode("usr-drama", draft.Project.ID, after.Episodes[0].ID); err == nil {
		t.Fatal("legacy approval cannot bypass guide confirmation")
	}
}

func TestDramaGuideDispatchBlocksPreviouslyQueuedDownstreamWork(t *testing.T) {
	svc, fake := newDramaTestService(t)
	draft := createGuidedDrama(t, svc, DramaChapterInput{Title: "一", Text: "正文"})
	assets := confirmGuide(t, svc, draft)
	runDramaTicks(t, svc, draft.Project.ID, 4)
	jobs := []model.DramaJob{
		{ID: newID(), ProjectID: draft.Project.ID, EpisodeID: assets.Episodes[0].ID, Kind: model.DramaJobScript, Status: model.DramaJobQueued, Priority: 2000000},
		{ID: newID(), ProjectID: draft.Project.ID, EpisodeID: assets.Episodes[0].ID, Kind: model.DramaJobSegmentVideo, Status: model.DramaJobQueued, Priority: 2000001},
	}
	if err := fake.db.Create(&jobs).Error; err != nil {
		t.Fatal(err)
	}
	runDramaTicks(t, svc, draft.Project.ID, 3)
	if fake.byKind["script"] != 0 || fake.byKind["video"] != 0 {
		t.Fatalf("dispatch must enforce current guide step on pre-existing work: %v", fake.byKind)
	}
	for _, job := range jobs {
		var stored model.DramaJob
		if err := fake.db.First(&stored, "id = ?", job.ID).Error; err != nil || stored.Status != model.DramaJobCanceled || stored.TaskID != "" {
			t.Fatalf("blocked jobs must be canceled without submission: %+v %v", stored, err)
		}
	}
	current := guideSummary(t, svc, draft.Project.ID)
	if !current.Guide.CanConfirm {
		t.Fatalf("obsolete queued jobs must not block confirmation: %+v", current.Guide)
	}
	confirmGuide(t, svc, current)
	runDramaTicks(t, svc, draft.Project.ID, 12)
	if fake.byKind["script"] != 1 {
		t.Fatalf("confirmation must plan one new script: %v", fake.byKind)
	}
}

func TestDramaGuideQueueAndRewindShareSnapshot(t *testing.T) {
	for _, editFirst := range []bool{true, false} {
		name := "enqueue-before-edit"
		if editFirst {
			name = "edit-before-enqueue"
		}
		t.Run(name, func(t *testing.T) {
			svc, fake := newDramaTestService(t)
			draft := createGuidedDrama(t, svc, DramaChapterInput{Text: "正文"})
			confirmGuide(t, svc, draft)
			runDramaTicks(t, svc, draft.Project.ID, 4)
			story := confirmGuide(t, svc, guideSummary(t, svc, draft.Project.ID))
			project, p, err := svc.dramaForUser("usr-drama", draft.Project.ID)
			if err != nil {
				t.Fatal(err)
			}
			run := &dramaRun{s: svc, project: project, production: p, settings: parseDramaSettings(p.SettingsJSON), meta: parseDramaBibleMeta(p.BibleJSON)}
			if err := run.syncJobs(); err != nil {
				t.Fatal(err)
			}
			if err := run.loadCasts(); err != nil {
				t.Fatal(err)
			}
			edit := func() error {
				name := run.casts[0].Name + "改名"
				_, err := svc.UpdateDramaCast("usr-drama", draft.Project.ID, run.casts[0].ID, UpdateDramaCastRequest{ExpectedRevision: &story.Production.Revision, Name: &name})
				return err
			}
			if editFirst {
				if err := edit(); err != nil {
					t.Fatal(err)
				}
			}
			if err := run.plan(); err != nil {
				t.Fatal(err)
			}
			if len(run.newJobs) == 0 {
				t.Fatal("story snapshot must plan text work")
			}
			err = run.persistJobs()
			if editFirst {
				if !errors.Is(err, repository.ErrDramaGuideChanged) {
					t.Fatalf("stale snapshot must not enqueue: %v", err)
				}
				current := guideSummary(t, svc, draft.Project.ID)
				if current.Production.GuideStep != model.DramaGuideAssets || !current.Guide.CanConfirm || current.JobCounts[model.DramaJobQueued] != 0 || fake.byKind["script"] != 0 {
					t.Fatalf("rewind must remain confirmable without stale work: %+v %v", current.Guide, current.JobCounts)
				}
				confirmGuide(t, svc, current)
			} else {
				if err != nil {
					t.Fatal(err)
				}
				requireGuideConflict(t, edit())
			}
			runDramaTicks(t, svc, draft.Project.ID, 12)
			if !guideSummary(t, svc, draft.Project.ID).Guide.CanConfirm || fake.byKind["script"] != 1 {
				t.Fatalf("accepted work must finish exactly once: %v", fake.byKind)
			}
		})
	}
}

func TestDramaGuidePausedQueueDoesNotBlockConfirmation(t *testing.T) {
	svc, fake := newDramaTestService(t)
	draft := createGuidedDrama(t, svc, DramaChapterInput{Text: "正文"})
	confirmGuide(t, svc, draft)
	runDramaTicks(t, svc, draft.Project.ID, 4)
	job := model.DramaJob{ID: newID(), ProjectID: draft.Project.ID, Kind: model.DramaJobScript, Status: model.DramaJobQueued}
	if err := svc.repo.CreateDramaJobs([]model.DramaJob{job}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.SetDramaRunning("usr-drama", draft.Project.ID, false); err != nil {
		t.Fatal(err)
	}
	runDramaTicks(t, svc, draft.Project.ID, 1)
	current := guideSummary(t, svc, draft.Project.ID)
	if current.Production.Status != model.DramaStatusPaused || !current.Guide.CanConfirm || fake.byKind["script"] != 0 {
		t.Fatalf("paused guide must discard obsolete queued work without dispatch: %+v %v", current.Guide, fake.byKind)
	}
}

func TestDramaGuideSingleImageIsOptionalAndDoesNotBlockConfirmation(t *testing.T) {
	svc, fake := newDramaTestService(t)
	draft := createGuidedDrama(t, svc, DramaChapterInput{Title: "一", Text: "正文"})
	confirmGuide(t, svc, draft)
	runDramaTicks(t, svc, draft.Project.ID, 4)
	casts, err := svc.DramaCasts("usr-drama", draft.Project.ID)
	if err != nil || len(casts) < 2 {
		t.Fatalf("load assets: %v", err)
	}
	if _, err := svc.RegenerateDramaCast("usr-drama", draft.Project.ID, casts[0].ID, false); err != nil {
		t.Fatal(err)
	}
	runDramaTicks(t, svc, draft.Project.ID, 1)
	assets := guideSummary(t, svc, draft.Project.ID)
	if !assets.Guide.CanConfirm || fake.byKind["image"] != 1 {
		t.Fatalf("one explicit image may run while asset text can be confirmed: %+v %v", assets.Guide, fake.byKind)
	}
	confirmGuide(t, svc, assets)
	runDramaTicks(t, svc, draft.Project.ID, 20)
	story := guideSummary(t, svc, draft.Project.ID)
	if !story.Guide.CanConfirm || fake.byKind["image"] != 1 || fake.byKind["video"] != 0 {
		t.Fatalf("other assets need no images to finish text guidance: %+v %v", story.Guide, fake.byKind)
	}
	confirmGuide(t, svc, story)
}

func TestDramaGuideConversationBindingIsProjectAndUserScoped(t *testing.T) {
	svc, fake := newDramaTestService(t)
	draft := createGuidedDrama(t, svc)
	for _, row := range []model.CloudAgentExecution{
		{ID: "valid-run", ConversationID: "valid-conv", UserID: "usr-drama", StateJSON: `{"request":{"dramaProjectId":"` + draft.Project.ID + `"}}`},
		{ID: "other-project", ConversationID: "other-project", UserID: "usr-drama", StateJSON: `{"request":{"dramaProjectId":"another"}}`},
		{ID: "other-user", ConversationID: "other-user", UserID: "another-user", StateJSON: `{"request":{"dramaProjectId":"` + draft.Project.ID + `"}}`},
		{ID: "other-conv", ConversationID: "other-conv", UserID: "usr-drama", StateJSON: `{"request":{"dramaProjectId":"` + draft.Project.ID + `"}}`},
	} {
		if err := fake.db.Create(&row).Error; err != nil {
			t.Fatal(err)
		}
	}
	for _, invalid := range []string{"other-project", "other-user", "missing"} {
		if _, err := svc.UpdateDramaSettings("usr-drama", draft.Project.ID, UpdateDramaSettingsRequest{GuideConversationID: &invalid}); err == nil {
			t.Fatalf("must reject conversation %q", invalid)
		}
	}
	valid := "valid-conv"
	bound, err := svc.UpdateDramaSettings("usr-drama", draft.Project.ID, UpdateDramaSettingsRequest{GuideConversationID: &valid})
	if err != nil || bound.Production.GuideConversationID != valid {
		t.Fatalf("bind scoped conversation: %+v %v", bound.Production, err)
	}
	if bound.Production.Revision != draft.Production.Revision {
		t.Fatal("conversation binding must not invalidate a proposal from the first run")
	}
	if _, err := svc.UpdateDramaSettings("usr-drama", draft.Project.ID, UpdateDramaSettingsRequest{GuideConversationID: &valid, ExpectedRevision: &draft.Production.Revision}); err != nil {
		t.Fatalf("rebinding the same conversation must be idempotent: %v", err)
	}
	stale := draft.Production.Revision - 1
	_, err = svc.UpdateDramaSettings("usr-drama", draft.Project.ID, UpdateDramaSettingsRequest{GuideConversationID: &valid, ExpectedRevision: &stale})
	requireGuideConflict(t, err)
	settings := draft.Production.Settings
	settings.Language = "English"
	changed, err := svc.UpdateDramaSettings("usr-drama", draft.Project.ID, UpdateDramaSettingsRequest{Settings: &settings, ExpectedRevision: &draft.Production.Revision})
	if err != nil || changed.Production.Revision != draft.Production.Revision+1 || changed.Production.GuideConversationID != valid {
		t.Fatalf("the first run's content revision must remain usable, and content saves must advance it: %+v %v", changed.Production, err)
	}
	other := "other-conv"
	_, err = svc.UpdateDramaSettings("usr-drama", draft.Project.ID, UpdateDramaSettingsRequest{GuideConversationID: &other})
	requireGuideConflict(t, err)
}

func TestDramaGuideOldImageResultOnlyEntersTakeHistory(t *testing.T) {
	svc, fake := newDramaTestService(t)
	draft := createGuidedDrama(t, svc, DramaChapterInput{Text: "正文"})
	assets := confirmGuide(t, svc, draft)
	runDramaTicks(t, svc, draft.Project.ID, 4)
	casts, err := svc.DramaCasts("usr-drama", draft.Project.ID)
	if err != nil || len(casts) == 0 {
		t.Fatalf("load casts: %v", err)
	}
	cast := casts[0]
	if err := fake.db.Model(&cast).Updates(map[string]any{"image_status": model.DramaMediaRunning}).Error; err != nil {
		t.Fatal(err)
	}
	p := guideSummary(t, svc, draft.Project.ID)
	appearance := "新的外观"
	updated, err := svc.UpdateDramaCast("usr-drama", draft.Project.ID, cast.ID, UpdateDramaCastRequest{ExpectedRevision: &p.Production.Revision, Appearance: &appearance})
	if err != nil || updated.ImageStatus != model.DramaMediaStale {
		t.Fatalf("editing a running image input must mark it stale: %+v %v", updated, err)
	}
	resourceID := fake.resourceSized("usr-drama", "image", "image/png", 1920, 1080)
	result, _ := json.Marshal(map[string]any{"images": []any{map[string]any{"resourceId": resourceID}}})
	project, productionRow, err := svc.dramaForUser("usr-drama", draft.Project.ID)
	if err != nil {
		t.Fatal(err)
	}
	run := &dramaRun{s: svc, project: project, production: productionRow, settings: assets.Production.Settings}
	job := &model.DramaJob{Kind: model.DramaJobCastImage, CastID: cast.ID, PayloadJSON: encodeDramaRevision(cast.Revision)}
	if err := run.applyCastImage(job, &model.Task{ID: "old-image", Type: "canvas_image", ResultJSON: string(result)}); err != nil {
		t.Fatal(err)
	}
	after, err := svc.repo.DramaCast(draft.Project.ID, cast.ID)
	if err != nil || after.ImageResourceID != "" || after.ImageStatus != model.DramaMediaStale {
		t.Fatalf("outdated image must not become the current asset: %+v %v", after, err)
	}
	var takes int64
	if err := fake.db.Model(&model.DramaTake{}).Where("owner_id = ? AND task_id = ?", cast.ID, "old-image").Count(&takes).Error; err != nil || takes != 1 {
		t.Fatalf("paid old result must remain in history: count=%d %v", takes, err)
	}
	if _, err := svc.RegenerateDramaCast("usr-drama", draft.Project.ID, cast.ID, false); err != nil {
		t.Fatal(err)
	}
	if err := run.markRunning(job); err != nil {
		t.Fatal(err)
	}
	if err := run.applyCastImage(job, &model.Task{ID: "old-image", ResultJSON: string(result)}); err != nil {
		t.Fatal(err)
	}
	after, err = svc.repo.DramaCast(draft.Project.ID, cast.ID)
	if err != nil || after.ImageStatus != model.DramaMediaQueued || after.ImageResourceID != "" {
		t.Fatalf("old result must not claim the new image request: %+v %v", after, err)
	}
	job.PayloadJSON = encodeDramaRevision(after.Revision)
	if err := run.markRunning(job); err != nil {
		t.Fatal(err)
	}
	after, err = svc.repo.DramaCast(draft.Project.ID, cast.ID)
	if err != nil || after.ImageStatus != model.DramaMediaRunning {
		t.Fatalf("the current image request must enter running: %+v %v", after, err)
	}
	if err := run.applyCastImage(job, &model.Task{ID: "new-image", ResultJSON: string(result)}); err != nil {
		t.Fatal(err)
	}
	after, err = svc.repo.DramaCast(draft.Project.ID, cast.ID)
	if err != nil || after.ImageStatus != model.DramaMediaReady || after.ImageResourceID != resourceID {
		t.Fatalf("a new image request must still complete: %+v %v", after, err)
	}
}

func TestDramaCastEditsDoNotStrandPendingImages(t *testing.T) {
	name, appearance, voice, locked := "新名称", "新的外观", "轻声", true
	aliases := []string{"新别名"}
	edits := []struct {
		name string
		req  UpdateDramaCastRequest
	}{
		{"name", UpdateDramaCastRequest{Name: &name}},
		{"aliases", UpdateDramaCastRequest{Aliases: &aliases}},
		{"appearance", UpdateDramaCastRequest{Appearance: &appearance}},
		{"voice", UpdateDramaCastRequest{VoiceInstructions: &voice}},
		{"lock", UpdateDramaCastRequest{Locked: &locked}},
	}
	for _, guided := range []bool{true, false} {
		mode := "traditional"
		if guided {
			mode = "guided"
		}
		t.Run(mode, func(t *testing.T) {
			svc, fake := newDramaTestService(t)
			var summary DramaSummary
			if guided {
				draft := createGuidedDrama(t, svc, DramaChapterInput{Text: "正文"})
				confirmGuide(t, svc, draft)
				runDramaTicks(t, svc, draft.Project.ID, 4)
				summary = guideSummary(t, svc, draft.Project.ID)
			} else {
				summary = createTestDramaWithMedia(t, svc, DramaReviewEvery, DramaMediaManual)
			}
			project, p, err := svc.dramaForUser("usr-drama", summary.Project.ID)
			if err != nil {
				t.Fatal(err)
			}
			run := &dramaRun{s: svc, project: project, production: p, settings: parseDramaSettings(p.SettingsJSON)}
			resourceID := fake.resourceSized("usr-drama", "image", "image/png", 1920, 1080)
			result, _ := json.Marshal(map[string]any{"images": []any{map[string]any{"resourceId": resourceID}}})
			for _, status := range []string{model.DramaMediaQueued, model.DramaMediaRunning, model.DramaMediaReady} {
				for _, edit := range edits {
					t.Run(status+"/"+edit.name, func(t *testing.T) {
						cast := model.DramaCast{ID: newID(), ProjectID: project.ID, Kind: "character", Name: "旧名称", Revision: 1, ImageStatus: status, ImageResourceID: "existing-image"}
						if err := svc.repo.CreateDramaCasts([]model.DramaCast{cast}); err != nil {
							t.Fatal(err)
						}
						job := model.DramaJob{ID: newID(), ProjectID: project.ID, CastID: cast.ID, Kind: model.DramaJobCastImage, Status: model.DramaJobQueued, PayloadJSON: encodeDramaRevision(cast.Revision)}
						if err := svc.repo.CreateDramaJobs([]model.DramaJob{job}); err != nil {
							t.Fatal(err)
						}
						current := guideSummary(t, svc, project.ID)
						req := edit.req
						if guided {
							req.ExpectedRevision = &current.Production.Revision
						}
						updated, err := svc.UpdateDramaCast("usr-drama", project.ID, cast.ID, req)
						if err != nil {
							t.Fatal(err)
						}
						wantStatus := model.DramaMediaStale
						if status == model.DramaMediaReady && (!guided || edit.name != "appearance") {
							wantStatus = model.DramaMediaReady
						}
						if updated.ImageStatus != wantStatus || updated.Revision != cast.Revision+1 {
							t.Fatalf("edit must leave a usable image state: %+v", updated)
						}
						var stored model.DramaJob
						if err := fake.db.First(&stored, "id = ?", job.ID).Error; err != nil || stored.Status != model.DramaJobCanceled {
							t.Fatalf("old queued image must not be submitted: %+v %v", stored, err)
						}
						if err := run.applyCastImage(&job, &model.Task{ID: "old-" + cast.ID, ResultJSON: string(result)}); err != nil {
							t.Fatal(err)
						}
						if err := run.failJob(&job, "旧图片任务失败"); err != nil {
							t.Fatal(err)
						}
						after, err := svc.repo.DramaCast(project.ID, cast.ID)
						if err != nil || after.ImageStatus != wantStatus || after.ImageResourceID != "existing-image" {
							t.Fatalf("old image completion must not overwrite the edited slot: %+v %v", after, err)
						}
						var takes int64
						if err := fake.db.Model(&model.DramaTake{}).Where("owner_id = ? AND task_id = ?", cast.ID, "old-"+cast.ID).Count(&takes).Error; err != nil || takes != 1 {
							t.Fatalf("old paid image must remain in history: %d %v", takes, err)
						}
					})
				}
			}
		})
	}
}
