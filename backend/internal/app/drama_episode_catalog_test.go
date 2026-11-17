package app

import (
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"yingce/backend/internal/model"
	"yingce/backend/internal/production"

	"gorm.io/gorm"
)

func TestDramaGuidedCatalogAlwaysCreatesAllImportedEpisodes(t *testing.T) {
	svc, fake := newDramaTestService(t)
	chapters := make([]DramaChapterInput, 9)
	for i := range chapters {
		chapters[i] = DramaChapterInput{Title: fmt.Sprintf("第%d集", i+1), Text: fmt.Sprintf("第%d集完整正文", i+1)}
	}
	summary, err := svc.CreateDrama("usr-drama", CreateDramaRequest{Name: "全部剧集", Guided: true, SourceFormat: production.SourceScript, Settings: DramaSettings{Models: fakeDramaModels}, Chapters: chapters, SelectedChapters: []int{0, 1}})
	if err != nil {
		t.Fatal(err)
	}
	if len(summary.Episodes) != 9 || summary.Production.ReservedChapterCount != 0 || summary.Production.ChapterCount != 9 || summary.Production.PlanCursor != 9 {
		t.Fatalf("import must create every real episode independently of selected chapters: %+v", summary)
	}
	replaced, err := svc.UpdateDramaGuideSource("usr-drama", summary.Project.ID, UpdateDramaGuideSourceRequest{ExpectedRevision: summary.Production.Revision, Chapters: chapters, SelectedChapters: []int{0}})
	if err != nil || len(replaced.Episodes) != 9 || replaced.Production.ReservedChapterCount != 0 {
		t.Fatalf("source replacement must also retain the complete catalog: %+v %v", replaced, err)
	}
	withoutSelection, err := svc.UpdateDramaGuideSource("usr-drama", summary.Project.ID, UpdateDramaGuideSourceRequest{ExpectedRevision: replaced.Production.Revision, Chapters: chapters})
	if err != nil || len(withoutSelection.Episodes) != 9 {
		t.Fatalf("replacing source cannot require selecting chapters: %+v %v", withoutSelection, err)
	}
	if len(fake.requests) != 0 {
		t.Fatal("creating the catalog must not invoke models")
	}
}

func dramaLegacyEpisodeCatalogFixture(t *testing.T) (*Service, *fakeDramaBackend, DramaSummary, []model.ProjectUnit) {
	t.Helper()
	svc, fake := newDramaTestService(t)
	input := make([]DramaChapterInput, 9)
	for i := range input {
		input[i] = DramaChapterInput{Title: fmt.Sprintf("原文第%d集", i+1), Text: fmt.Sprintf("第%d集：萧炎走进萧家大厅。", i+1)}
	}
	summary := createGuidedDrama(t, svc, input...)
	chapters, _ := svc.repo.DramaChapters(summary.Project.ID)
	keep := []string{summary.Episodes[0].ID, summary.Episodes[3].ID}
	if err := fake.db.Where("project_id = ? AND id NOT IN ?", summary.Project.ID, keep).Delete(&model.DramaEpisode{}).Error; err != nil {
		t.Fatal(err)
	}
	if err := fake.db.Model(&model.DramaEpisode{}).Where("id = ?", keep[1]).UpdateColumn("number", 2).Error; err != nil {
		t.Fatal(err)
	}
	if err := fake.db.Model(&model.ProjectUnit{}).Where("project_id = ? AND id NOT IN ?", summary.Project.ID, []string{chapters[0].ID, chapters[3].ID}).UpdateColumn("status", model.ProjectUnitStatusReserved).Error; err != nil {
		t.Fatal(err)
	}
	if err := fake.db.Model(&model.DramaProduction{}).Where("project_id = ?", summary.Project.ID).Updates(map[string]any{"guide_step": model.DramaGuideStory, "stage": model.DramaStageProduce, "status": model.DramaStatusRunning, "plan_cursor": 2, "plan_done": true}).Error; err != nil {
		t.Fatal(err)
	}
	summary.Episodes = []DramaEpisodeRow{summary.Episodes[0], summary.Episodes[3]}
	summary.Episodes[1].Number = 2
	return svc, fake, summary, chapters
}

func TestDramaEpisodeCatalogBackfillsInSourceOrderWithoutOverwritingWork(t *testing.T) {
	svc, fake, before, chapters := dramaLegacyEpisodeCatalogFixture(t)
	projectID := before.Project.ID
	secondID := before.Episodes[1].ID
	image, video := fake.resource("usr-drama", "image", "image/png"), fake.resource("usr-drama", "video", "video/mp4")
	cast := model.DramaCast{ID: "catalog-cast", ProjectID: projectID, Kind: "character", Name: "萧炎", ImageResourceID: image, ImageStatus: model.DramaMediaReady, Revision: 6}
	shot := model.DramaShot{ID: "catalog-shot", ProjectID: projectID, EpisodeID: secondID, SegmentIndex: 0, Position: 0, Action: "保留的镜头", DurationMs: 4000}
	segment := model.DramaSegment{ID: "catalog-segment", ProjectID: projectID, EpisodeID: secondID, SegmentIndex: 0, VideoStatus: model.DramaMediaReady, VideoResourceID: video, VideoPrompt: "保留的提示词", PromptStatus: model.DramaMediaReady}
	job := model.DramaJob{ID: "catalog-job", ProjectID: projectID, EpisodeID: secondID, Kind: model.DramaJobSegmentVideo, Status: model.DramaJobRunning, Label: "第 2 集 第 1 段视频", TaskID: "catalog-task"}
	for _, row := range []any{&cast, &shot, &segment, &job} {
		if err := fake.db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	originalCast, _ := svc.repo.DramaCast(projectID, cast.ID)
	if err := fake.db.Model(&model.DramaEpisode{}).Where("id = ?", secondID).Updates(map[string]any{"title": "作者自己的标题", "revision": 11, "stage": model.DramaEpisodeDone, "shot_count": 1, "final_resource_id": video, "asset_ids_json": `["catalog-cast"]`}).Error; err != nil {
		t.Fatal(err)
	}
	original, _ := svc.repo.DramaEpisode(projectID, secondID)
	p, _ := svc.repo.DramaProduction(projectID)
	after, err := svc.DramaSummary("usr-drama", projectID)
	if err != nil {
		t.Fatal(err)
	}
	if len(after.Episodes) != 9 || after.Production.Revision != p.Revision+1 || after.Production.ReservedChapterCount != 0 || after.Production.PlanCursor != 9 {
		t.Fatalf("legacy source must become a persisted complete catalog: %+v", after)
	}
	for i, row := range after.Episodes {
		episode, _ := svc.repo.DramaEpisode(projectID, row.ID)
		if row.Number != i+1 || !reflect.DeepEqual(decodeStringList(episode.ChapterIDsJSON), []string{chapters[i].ID}) {
			t.Fatalf("episode catalog must follow original source order: %+v", episode)
		}
		if i != 0 && i != 3 && row.Stage != model.DramaEpisodeDraft {
			t.Fatalf("backfilled episode cannot enter automatic generation: %+v", row)
		}
	}
	current, _ := svc.repo.DramaEpisode(projectID, secondID)
	original.Number = 4
	if !reflect.DeepEqual(original, current) {
		t.Fatalf("renumbering must retain all existing business state: before=%+v after=%+v", original, current)
	}
	keptCast, _ := svc.repo.DramaCast(projectID, cast.ID)
	keptShots, _ := svc.repo.DramaShots(secondID)
	keptSegments, _ := svc.repo.DramaSegments(secondID)
	keptJob, _ := svc.repo.DramaJob(projectID, job.ID)
	if !reflect.DeepEqual(keptCast, originalCast) || len(keptShots) != 1 || len(keptSegments) != 1 || keptShots[0].Action != shot.Action || keptSegments[0].VideoResourceID != video || keptJob.Label != "第 4 集 第 1 段视频" || keptJob.TaskID != job.TaskID || keptJob.Status != job.Status {
		t.Fatalf("catalog sync changed assets, shots, video or in-flight job identity: cast=%+v original=%+v shots=%+v segments=%+v job=%+v", keptCast, cast, keptShots, keptSegments, keptJob)
	}
	again, err := svc.DramaSummary("usr-drama", projectID)
	if err != nil || !reflect.DeepEqual(after, again) || len(fake.requests) != 0 {
		t.Fatalf("repeated catalog reads must be idempotent and free of model calls: %+v %v", again, err)
	}
	stale := p.Revision
	if _, err := svc.UpdateDramaWorkflowStyle("usr-drama", projectID, UpdateDramaWorkflowStyleRequest{ExpectedRevision: &stale, StyleName: "过期修改", StylePrompt: "不能覆盖当前配置"}); err == nil {
		t.Fatal("backfill must invalidate stale write snapshots")
	}
}

func TestDramaEpisodeCatalogKeepsOversizedGroupsReadableUntilExplicitStart(t *testing.T) {
	svc, fake := newDramaTestService(t)
	input := []DramaChapterInput{{Title: "已开工", Text: "正文"}}
	for range 9 {
		input = append(input, DramaChapterInput{Title: "预留章节", Text: strings.Repeat("长", 5001)})
	}
	settings := DramaSettings{Models: fakeDramaModels, EpisodeMode: DramaEpisodeModeChapter, ChaptersPerEpisode: 12}
	before, err := svc.CreateDrama("usr-drama", CreateDramaRequest{Name: "历史多章作品", Settings: settings, Chapters: input, SelectedChapters: []int{0}})
	if err != nil {
		t.Fatal(err)
	}
	projectID := before.Project.ID
	if err := fake.db.Model(&model.DramaProduction{}).Where("project_id = ?", projectID).UpdateColumn("status", model.DramaStatusPaused).Error; err != nil {
		t.Fatal(err)
	}
	original, err := svc.repo.DramaEpisode(projectID, before.Episodes[0].ID)
	if err != nil {
		t.Fatal(err)
	}
	after := guideSummary(t, svc, projectID)
	if len(after.Episodes) != 2 || after.Production.Revision != before.Production.Revision+1 || after.Production.Status != model.DramaStatusPaused || after.Production.PlanCursor != len(input) || after.Production.ChapterCount != len(input) || after.Production.ReservedChapterCount != 0 {
		t.Fatalf("catalog recovery must keep the original chapter grouping without starting work: %+v", after)
	}
	chapters, err := svc.repo.DramaChapters(projectID)
	if err != nil {
		t.Fatal(err)
	}
	wantedIDs := make([]string, 0, len(chapters)-1)
	for _, chapter := range chapters[1:] {
		wantedIDs = append(wantedIDs, chapter.ID)
		if chapter.SourceText != input[1].Text || chapter.WordCount != 5001 {
			t.Fatal("catalog recovery changed historical source text")
		}
	}
	draft, err := svc.repo.DramaEpisode(projectID, after.Episodes[1].ID)
	if err != nil {
		t.Fatal(err)
	}
	if draft.Stage != model.DramaEpisodeDraft || !reflect.DeepEqual(decodeStringList(draft.ChapterIDsJSON), wantedIDs) {
		t.Fatalf("all contiguous reserved chapters must keep their configured grouping: %+v", draft)
	}
	current, err := svc.repo.DramaEpisode(projectID, original.ID)
	if err != nil || !reflect.DeepEqual(original, current) {
		t.Fatalf("catalog recovery changed existing work: before=%+v after=%+v err=%v", original, current, err)
	}
	if again := guideSummary(t, svc, projectID); !reflect.DeepEqual(after, again) {
		t.Fatal("reading the recovered catalog must be idempotent")
	}
	if _, err := svc.RescriptDramaEpisode("usr-drama", projectID, draft.ID); err == nil {
		t.Fatal("an oversized chapter group must be rejected before explicit generation")
	}
	current, err = svc.repo.DramaEpisode(projectID, draft.ID)
	if err != nil || !reflect.DeepEqual(draft, current) {
		t.Fatalf("rejected generation changed the draft: before=%+v after=%+v err=%v", draft, current, err)
	}
	if again := guideSummary(t, svc, projectID); !reflect.DeepEqual(after, again) || len(fake.requests) != 0 {
		t.Fatal("rejected generation must preserve the paused catalog without invoking models")
	}
}

func TestDramaEpisodeCatalogConcurrentReadsReturnCurrentRevision(t *testing.T) {
	svc, fake, before, _ := dramaLegacyEpisodeCatalogFixture(t)
	hold, err := svc.lockDramaSchedule(before.Project.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer hold()
	// Both readers must load the old production before either can recover the catalog.
	reached := make(chan struct{}, 2)
	const callback = "test:catalog_read_barrier"
	if err := fake.db.Callback().Query().After("gorm:query").Register(callback, func(tx *gorm.DB) {
		if tx.Statement.Table == "drama_episodes" {
			select {
			case reached <- struct{}{}:
			default:
			}
		}
	}); err != nil {
		t.Fatal(err)
	}
	defer fake.db.Callback().Query().Remove(callback)
	type result struct {
		summary DramaSummary
		err     error
	}
	results := make(chan result, 2)
	for range 2 {
		go func() {
			summary, err := svc.DramaSummary("usr-drama", before.Project.ID)
			results <- result{summary: summary, err: err}
		}()
	}
	for range 2 {
		select {
		case <-reached:
		case <-time.After(5 * time.Second):
			t.Fatal("concurrent read did not reach the catalog recovery lock")
		}
	}
	hold()
	first, second := <-results, <-results
	if first.err != nil || second.err != nil {
		t.Fatalf("concurrent catalog reads failed: %v %v", first.err, second.err)
	}
	for _, summary := range []DramaSummary{first.summary, second.summary} {
		if summary.Production.Revision != before.Production.Revision+1 || summary.Production.PlanCursor != 9 || len(summary.Episodes) != 9 {
			t.Fatalf("concurrent reads must return the recovered directory and its current version together: revision=%d cursor=%d episodes=%d", summary.Production.Revision, summary.Production.PlanCursor, len(summary.Episodes))
		}
	}
	if !reflect.DeepEqual(first.summary, second.summary) || len(fake.requests) != 0 {
		t.Fatal("concurrent reads must persist one identical catalog without model calls")
	}
	revision := second.summary.Production.Revision
	if _, err := svc.UpdateDramaWorkflowStyle("usr-drama", before.Project.ID, UpdateDramaWorkflowStyleRequest{ExpectedRevision: &revision, StyleName: "当前风格", StylePrompt: "并发读取后的有效配置"}); err != nil {
		t.Fatalf("the returned catalog version must accept the next CAS edit: %v", err)
	}
}

func TestDramaEpisodeCatalogDraftsDoNotOccupyWindowOrDispatchLegacyJobs(t *testing.T) {
	svc, fake, before, _ := dramaLegacyEpisodeCatalogFixture(t)
	after := guideSummary(t, svc, before.Project.ID)
	if err := fake.db.Model(&model.DramaEpisode{}).Where("project_id = ?", before.Project.ID).UpdateColumn("stage", model.DramaEpisodeDraft).Error; err != nil {
		t.Fatal(err)
	}
	firstID := after.Episodes[0].ID
	if err := fake.db.Model(&model.DramaEpisode{}).Where("id = ?", firstID).UpdateColumn("stage", model.DramaEpisodeQueued).Error; err != nil {
		t.Fatal(err)
	}
	for i, kind := range []string{model.DramaJobScript, model.DramaJobSegmentPrompt, model.DramaJobSegmentVideo, model.DramaJobRender} {
		job := model.DramaJob{ID: fmt.Sprintf("draft-job-%d", i), ProjectID: before.Project.ID, EpisodeID: after.Episodes[1].ID, Kind: kind, Status: model.DramaJobQueued, CreatedAt: time.Now(), UpdatedAt: time.Now()}
		if err := fake.db.Create(&job).Error; err != nil {
			t.Fatal(err)
		}
	}
	dirtySegment := model.DramaSegment{ID: "draft-dirty-segment", ProjectID: before.Project.ID, EpisodeID: after.Episodes[1].ID, SegmentIndex: 0}
	if err := fake.db.Create(&dirtySegment).Error; err != nil {
		t.Fatal(err)
	}
	runDramaTicks(t, svc, before.Project.ID, 1)
	for i := range 4 {
		job, _ := svc.repo.DramaJob(before.Project.ID, fmt.Sprintf("draft-job-%d", i))
		if job.Status != model.DramaJobCanceled {
			t.Fatalf("draft legacy queued work must be cancelled before submission: %+v", job)
		}
	}
	if fake.byKind["script"] != 1 || len(fake.requests) != 1 {
		t.Fatalf("drafts must leave the window free for only the requested episode: %+v", fake.byKind)
	}
	pending, _ := svc.repo.PendingDramaSegments(before.Project.ID)
	for _, segment := range pending {
		if segment.ID == dirtySegment.ID {
			t.Fatal("draft remnants must not automatically schedule prompt generation")
		}
	}
}

func TestDramaEpisodeCatalogDraftsDoNotBlockCompletedScope(t *testing.T) {
	svc, fake, before, _ := dramaLegacyEpisodeCatalogFixture(t)
	after := guideSummary(t, svc, before.Project.ID)
	projectID := before.Project.ID
	if err := fake.db.Model(&model.DramaEpisode{}).Where("project_id = ?", projectID).UpdateColumn("stage", model.DramaEpisodeDraft).Error; err != nil {
		t.Fatal(err)
	}
	p, _ := svc.repo.DramaProduction(projectID)
	if ready, _, err := dramaGuideReadiness(svc.repo, p); err != nil || ready {
		t.Fatalf("an entirely unstarted catalog cannot confirm finished work: ready=%v err=%v", ready, err)
	}
	firstID := after.Episodes[0].ID
	if err := fake.db.Model(&model.DramaEpisode{}).Where("id = ?", firstID).Updates(map[string]any{"stage": model.DramaEpisodeDone, "shot_count": 1}).Error; err != nil {
		t.Fatal(err)
	}
	if err := fake.db.Create(&model.DramaSegment{ID: "finished-segment", ProjectID: projectID, EpisodeID: firstID, SegmentIndex: 0, VideoPrompt: "已完成提示词", PromptStatus: model.DramaMediaReady}).Error; err != nil {
		t.Fatal(err)
	}
	if ready, reason, err := dramaGuideReadiness(svc.repo, p); err != nil || !ready {
		t.Fatalf("unstarted episodes cannot block the completed production scope: ready=%v reason=%s err=%v", ready, reason, err)
	}
	runDramaTicks(t, svc, projectID, 1)
	p, _ = svc.repo.DramaProduction(projectID)
	if p.Status != model.DramaStatusCompleted || len(fake.requests) != 0 {
		t.Fatalf("only the started scope determines production completion: production=%+v requests=%+v", p, fake.requests)
	}
	draftID := after.Episodes[1].ID
	detail, err := svc.RescriptDramaEpisode("usr-drama", projectID, draftID)
	if err != nil || detail.Episode.ID != draftID || detail.Episode.Stage != model.DramaEpisodeScript {
		t.Fatalf("explicit start must reuse the same catalog episode: %+v %v", detail, err)
	}
	if len(fake.requests) != 0 {
		t.Fatal("requesting rescript only queues intent; it cannot call a model inline")
	}
	runDramaTicks(t, svc, projectID, 1)
	if fake.byKind["script"] != 1 {
		t.Fatalf("only the explicitly started episode may generate: %+v", fake.byKind)
	}
}

func TestDramaEpisodeCatalogDeletionDoesNotRecreateTheEpisode(t *testing.T) {
	svc, fake := newDramaTestService(t)
	summary := createGuidedDrama(t, svc, DramaChapterInput{Title: "第一集", Text: "甲"}, DramaChapterInput{Title: "第二集", Text: "乙"}, DramaChapterInput{Title: "第三集", Text: "丙"})
	projectID, deletedID := summary.Project.ID, summary.Episodes[1].ID
	deleted, _ := svc.repo.DramaEpisode(projectID, deletedID)
	if err := fake.db.Model(&model.DramaProduction{}).Where("project_id = ?", projectID).Updates(map[string]any{"guide_step": model.DramaGuideCompleted, "stage": model.DramaStageProduce, "status": model.DramaStatusPaused}).Error; err != nil {
		t.Fatal(err)
	}
	if err := svc.DeleteDramaEpisode("usr-drama", projectID, deletedID, ""); err != nil {
		t.Fatal(err)
	}
	after := guideSummary(t, svc, projectID)
	again := guideSummary(t, svc, projectID)
	if len(after.Episodes) != 2 || !reflect.DeepEqual(after, again) || after.Production.ReservedChapterCount != 0 || after.Production.ChapterCount != 2 {
		t.Fatalf("an intentional deletion cannot be backfilled on refresh: %+v", after)
	}
	chapterIDs := decodeStringList(deleted.ChapterIDsJSON)
	chapter, _ := svc.repo.ProjectUnit(projectID, chapterIDs[0])
	active, _ := svc.repo.DramaChapters(projectID)
	if chapter.Status != model.ProjectUnitStatusRemoved || len(active) != 2 {
		t.Fatalf("deleted episode source must be retained outside the production scope: chapter=%+v active=%+v", chapter, active)
	}
	result, err := svc.ExtractDramaAssets("usr-drama", projectID, ExtractDramaAssetsRequest{ExpectedRevision: after.Production.Revision, Kind: "scene", AllChapters: true})
	if err != nil || len(result.Job.SourceChapterIDs) != 3 {
		t.Fatalf("all-original extraction must retain intentionally removed source text: %+v %v", result, err)
	}
	if len(fake.requests) != 0 {
		t.Fatal("catalog refresh and extraction admission must not call models")
	}
}

func TestDramaDraftCatalogRejectsOversizedSourceBeforeGeneration(t *testing.T) {
	svc, fake, before, chapters := dramaLegacyEpisodeCatalogFixture(t)
	longText := strings.Repeat("长", production.ScriptSourceChapterRunes+1)
	if err := fake.db.Model(&model.ProjectUnit{}).Where("id = ?", chapters[1].ID).Updates(map[string]any{"source_text": longText, "word_count": len([]rune(longText))}).Error; err != nil {
		t.Fatal(err)
	}
	after := guideSummary(t, svc, before.Project.ID)
	if _, err := svc.RescriptDramaEpisode("usr-drama", before.Project.ID, after.Episodes[1].ID); err == nil {
		t.Fatal("oversized historical source must be split before invoking a model")
	}
	episode, _ := svc.repo.DramaEpisode(before.Project.ID, after.Episodes[1].ID)
	if episode.Stage != model.DramaEpisodeDraft || len(fake.requests) != 0 {
		t.Fatalf("rejected start must retain the unstarted episode without model calls: %+v", episode)
	}
}

func TestDramaEpisodeCatalogAlsoRecoversStartedAdvancedProductions(t *testing.T) {
	svc, fake, before, _ := dramaLegacyEpisodeCatalogFixture(t)
	if err := fake.db.Model(&model.DramaProduction{}).Where("project_id = ?", before.Project.ID).UpdateColumn("guide_step", "").Error; err != nil {
		t.Fatal(err)
	}
	after := guideSummary(t, svc, before.Project.ID)
	if len(after.Episodes) != 9 || after.Production.ReservedChapterCount != 0 || len(fake.requests) != 0 {
		t.Fatalf("advanced chapter productions need the same complete persisted catalog: %+v", after)
	}
	if err := svc.DeleteDramaEpisode("usr-drama", before.Project.ID, after.Episodes[1].ID, ""); err != nil {
		t.Fatal(err)
	}
	if again := guideSummary(t, svc, before.Project.ID); len(again.Episodes) != 8 {
		t.Fatal("deleted advanced catalog episodes must not return")
	}
}

func TestDramaLegacyFormDraftStartsEveryOriginalChapterExplicitly(t *testing.T) {
	svc, fake := newDramaTestService(t)
	created, err := svc.CreateDrama("usr-drama", CreateDramaRequest{Name: "旧表单草稿", SourceFormat: production.SourceScript, Settings: DramaSettings{Models: fakeDramaModels}, SelectedChapters: []int{0}, Chapters: []DramaChapterInput{{Title: "第一集", Text: "第一集正文"}, {Title: "第二集", Text: "第二集正文"}}})
	if err != nil {
		t.Fatal(err)
	}
	if len(created.Episodes) != 1 || created.Production.Status != model.DramaStatusDraft {
		t.Fatalf("the legacy unstarted draft fixture must remain unstarted: %+v", created)
	}
	started, err := svc.SetDramaRunning("usr-drama", created.Project.ID, true)
	if err != nil || len(started.Episodes) != 2 || started.Production.ReservedChapterCount != 0 {
		t.Fatalf("explicitly starting an old form draft must include all original chapters: %+v %v", started, err)
	}
	for _, episode := range started.Episodes {
		if episode.Stage != model.DramaEpisodeQueued {
			t.Fatalf("explicit first start must queue all imported episodes: %+v", episode)
		}
	}
	if len(fake.requests) != 0 {
		t.Fatal("start admission cannot call the model inline")
	}
}
