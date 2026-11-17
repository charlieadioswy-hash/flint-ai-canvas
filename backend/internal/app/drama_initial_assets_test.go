package app

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"yingce/backend/internal/model"
)

type initialAssetsTestPayload struct {
	InitialAssets    bool     `json:"initialAssets"`
	SourceChapterIDs []string `json:"sourceChapterIds"`
	SourceEpisodeIDs []string `json:"sourceEpisodeIds"`
}

func initialAssetsTestJob(t *testing.T, svc *Service, projectID string) model.DramaJob {
	t.Helper()
	jobs, err := svc.repo.RecentDramaJobs(projectID, 20)
	if err != nil {
		t.Fatal(err)
	}
	var bibles []model.DramaJob
	for _, job := range jobs {
		if job.Kind == model.DramaJobBible {
			bibles = append(bibles, job)
		}
	}
	if len(bibles) != 1 {
		t.Fatalf("initial extraction must have exactly one durable job: %+v", bibles)
	}
	return bibles[0]
}

func decodeInitialAssetsTestPayload(t *testing.T, job model.DramaJob) initialAssetsTestPayload {
	t.Helper()
	var payload initialAssetsTestPayload
	if err := json.Unmarshal([]byte(job.PayloadJSON), &payload); err != nil {
		t.Fatal(err)
	}
	if !payload.InitialAssets || len(payload.SourceChapterIDs) == 0 || job.EpisodeID != "" {
		t.Fatalf("initial extraction scope must be durable while keeping the shared Bible slot: %+v %+v", job, payload)
	}
	return payload
}

func TestDramaInitialAssetsFollowSelectedEpisodeAcrossDirectoryReset(t *testing.T) {
	svc, fake := newDramaTestService(t)
	draft := createGuidedDrama(t, svc,
		DramaChapterInput{Title: "第一集", Text: "第一集独有甲：甲走入森林。"},
		DramaChapterInput{Title: "第二集", Text: "当前集独有乙：萧炎与纳兰嫣然在萧家大厅拿起退婚书。"},
		DramaChapterInput{Title: "第三集", Text: "第三集独有丙：丙登上山顶。"},
	)
	projectID, oldID := draft.Project.ID, draft.Episodes[1].ID
	request := ConfirmDramaGuideRequest{ExpectedStep: model.DramaGuideConfiguring, ExpectedRevision: draft.Production.Revision, EpisodeID: oldID}
	invalid := request
	invalid.EpisodeID = "foreign-episode"
	if _, err := svc.ConfirmDramaGuide("usr-drama", projectID, invalid); err == nil {
		t.Fatal("invalid selection must be rejected before resetting the directory")
	}
	before, _ := svc.repo.DramaProduction(projectID)
	if before.Revision != draft.Production.Revision || before.GuideStep != model.DramaGuideConfiguring {
		t.Fatalf("invalid selection changed the workflow: %+v", before)
	}
	assets, err := svc.ConfirmDramaGuide("usr-drama", projectID, request)
	if err != nil {
		t.Fatal(err)
	}
	selected := assets.Episodes[1]
	if selected.Number != 2 || selected.ID == oldID {
		t.Fatalf("fixture must reset IDs while retaining the selected number: %+v", selected)
	}
	job := initialAssetsTestJob(t, svc, projectID)
	payload := decodeInitialAssetsTestPayload(t, job)
	selectedRow, _ := svc.repo.DramaEpisode(projectID, selected.ID)
	if !reflect.DeepEqual(payload.SourceEpisodeIDs, []string{selected.ID}) || !reflect.DeepEqual(payload.SourceChapterIDs, decodeStringList(selectedRow.ChapterIDsJSON)) {
		t.Fatalf("initial scope must point to the replacement selected episode: %+v %+v", payload, selected)
	}
	if scope, err := dramaAssetExtraction(&job); err != nil || scope != nil {
		t.Fatalf("initial scope must not become a per-kind incremental job: %+v %v", scope, err)
	}
	_, err = svc.ConfirmDramaGuide("usr-drama", projectID, request)
	requireGuideConflict(t, err)
	if again := initialAssetsTestJob(t, svc, projectID); again.ID != job.ID || again.PayloadJSON != job.PayloadJSON {
		t.Fatal("repeated confirmation must keep the same initial scope and job")
	}
	runDramaTicks(t, svc, projectID, 6)
	if fake.byKind["bible"] != 1 || len(fake.requests) != 1 {
		t.Fatalf("initial extraction must run once without downstream jobs: %v", fake.byKind)
	}
	prompt := fake.requests[0].Prompt
	if !strings.Contains(prompt, "当前集独有乙") || strings.Contains(prompt, "第一集独有甲") || strings.Contains(prompt, "第三集独有丙") {
		t.Fatalf("initial prompt leaked another episode: %s", prompt)
	}
	casts, err := svc.repo.DramaCasts(projectID)
	if err != nil || len(casts) != 4 {
		t.Fatalf("all three asset kinds must persist: %+v %v", casts, err)
	}
	want := map[string]bool{}
	for _, cast := range casts {
		want[cast.ID] = true
	}
	for _, episode := range assets.Episodes {
		stored, _ := svc.repo.DramaEpisode(projectID, episode.ID)
		ids := decodeStringList(stored.AssetIDsJSON)
		if episode.ID != selected.ID {
			if len(ids) != 0 {
				t.Fatalf("initial extraction linked another episode: %+v", stored)
			}
			continue
		}
		if len(ids) != len(want) {
			t.Fatalf("initial characters, scenes and props must belong to the selected episode: %v", ids)
		}
		for _, id := range ids {
			if !want[id] {
				t.Fatalf("unexpected initial asset membership: %v", ids)
			}
		}
	}
	p, _ := svc.repo.DramaProduction(projectID)
	if p.Stage != model.DramaStageProduce || p.GuideStep != model.DramaGuideAssets || p.BibleJSON == "" {
		t.Fatalf("scoped initial extraction must still complete the initial Bible stage: %+v", p)
	}
}

func TestDramaInitialAssetsRetryRetainsSelectedSource(t *testing.T) {
	svc, fake := newDramaTestService(t)
	draft := createGuidedDrama(t, svc,
		DramaChapterInput{Title: "一", Text: "不能进入提示词的甲"},
		DramaChapterInput{Title: "二", Text: "当前选中乙：萧炎在大厅。"},
	)
	assets, err := svc.ConfirmDramaGuide("usr-drama", draft.Project.ID, ConfirmDramaGuideRequest{ExpectedStep: model.DramaGuideConfiguring, ExpectedRevision: draft.Production.Revision, EpisodeID: draft.Episodes[1].ID})
	if err != nil {
		t.Fatal(err)
	}
	job := initialAssetsTestJob(t, svc, draft.Project.ID)
	decodeInitialAssetsTestPayload(t, job)
	fake.fail = func(req CreateTaskRequest) bool { return req.Type == "canvas_text" }
	runDramaTicks(t, svc, draft.Project.ID, 2)
	failed, _ := svc.repo.DramaJob(draft.Project.ID, job.ID)
	if failed.Status != model.DramaJobFailed || failed.PayloadJSON != job.PayloadJSON {
		t.Fatalf("failed initial work must retain its selected source: %+v", failed)
	}
	fake.fail = nil
	result, err := svc.RetryDramaProjectText("usr-drama", draft.Project.ID)
	if err != nil || result["jobs"] != 1 {
		t.Fatalf("retry initial asset extraction: %+v %v", result, err)
	}
	retried := initialAssetsTestJob(t, svc, draft.Project.ID)
	if retried.ID != job.ID || retried.PayloadJSON != job.PayloadJSON {
		t.Fatalf("retry must not broaden or reconstruct source scope: %+v", retried)
	}
	runDramaTicks(t, svc, draft.Project.ID, 6)
	saved, _ := svc.repo.DramaJob(draft.Project.ID, job.ID)
	if saved.Status != model.DramaJobSucceeded || saved.PayloadJSON != job.PayloadJSON || fake.byKind["bible"] != 1 || len(fake.requests) != 1 {
		t.Fatalf("initial retry must generate once using the same job: %+v %v", saved, fake.byKind)
	}
	if strings.Contains(fake.requests[0].Prompt, "不能进入提示词的甲") || !strings.Contains(fake.requests[0].Prompt, "当前选中乙") {
		t.Fatalf("retried initial prompt lost its scope: %s", fake.requests[0].Prompt)
	}
	selected, _ := svc.repo.DramaEpisode(draft.Project.ID, assets.Episodes[1].ID)
	other, _ := svc.repo.DramaEpisode(draft.Project.ID, assets.Episodes[0].ID)
	if len(decodeStringList(selected.AssetIDsJSON)) == 0 || other.AssetIDsJSON != "" {
		t.Fatalf("retry linked outside the selected episode: selected=%+v other=%+v", selected, other)
	}
}

func TestDramaInitialAssetsLegacyPaidResultRetainsWholeSource(t *testing.T) {
	svc, fake := newDramaTestService(t)
	draft := createGuidedDrama(t, svc,
		DramaChapterInput{Title: "第一集", Text: "前章人物走过。"},
		DramaChapterInput{Title: "第二集", Text: "中章人物离开。"},
		DramaChapterInput{Title: "第三集", Text: "后章角色：一名老者。"},
	)
	projectID := draft.Project.ID
	raw, _ := json.Marshal(map[string]string{"mode": "text", "text": `{"characters":[{"name":"后章角色","sourceDefinition":"后章角色：一名老者。","sourceChapterIndex":3}],"props":[],"scenes":[]}`})
	task := model.Task{ID: newID(), UserID: "usr-drama", ProjectID: projectID, Type: "canvas_text", Status: model.TaskStatusSucceeded, ResultJSON: string(raw)}
	job := model.DramaJob{ID: newID(), ProjectID: projectID, Kind: model.DramaJobBible, Status: model.DramaJobFailed, TaskID: task.ID, Error: "结果处理失败"}
	for _, row := range []any{&task, &job} {
		if err := fake.db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err := svc.repo.UpdateDramaProduction(projectID, map[string]any{"guide_step": model.DramaGuideAssets, "status": model.DramaStatusPaused, "stage": model.DramaStageBible}); err != nil {
		t.Fatal(err)
	}
	result, err := svc.RetryDramaProjectText("usr-drama", projectID)
	if err != nil || result["jobs"] != 1 {
		t.Fatalf("legacy initial recovery: %+v %v", result, err)
	}
	runDramaTicks(t, svc, projectID, 2)
	saved, _ := svc.repo.DramaJob(projectID, job.ID)
	casts, err := svc.repo.DramaCasts(projectID)
	if err != nil || saved.Status != model.DramaJobSucceeded || saved.TaskID != task.ID || saved.PayloadJSON != "" || len(fake.requests) != 0 || len(casts) != 1 || casts[0].Description != "后章角色：一名老者。" {
		t.Fatalf("legacy paid result must still validate against its original whole-book source: job=%+v casts=%+v error=%v", saved, casts, err)
	}
	for _, episode := range draft.Episodes {
		stored, _ := svc.repo.DramaEpisode(projectID, episode.ID)
		if stored.AssetIDsJSON != "" {
			t.Fatalf("legacy global result must not be reinterpreted as selected-episode work: %+v", stored)
		}
	}
}

func TestDramaInitialAssetsWithoutPlannedEpisodesLocksFirstChapterOnly(t *testing.T) {
	svc, fake := newDramaTestService(t)
	draft, err := svc.CreateDrama("usr-drama", CreateDramaRequest{Name: "尚未分集", Guided: true, Settings: DramaSettings{EpisodeMode: DramaEpisodeModeAuto, Models: fakeDramaModels}, Chapters: []DramaChapterInput{
		{Title: "开篇", Text: "首章限定甲：萧炎站在大厅。"},
		{Title: "后篇", Text: "不得提前提取乙：陌生角色登场。"},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if len(draft.Episodes) != 0 {
		t.Fatal("automatic planning fixture must have no episode directory yet")
	}
	assets := confirmGuide(t, svc, draft)
	job := initialAssetsTestJob(t, svc, draft.Project.ID)
	payload := decodeInitialAssetsTestPayload(t, job)
	chapters, _ := svc.repo.DramaChapters(draft.Project.ID)
	if !reflect.DeepEqual(payload.SourceChapterIDs, []string{chapters[0].ID}) || len(payload.SourceEpisodeIDs) != 0 || len(assets.Episodes) != 0 {
		t.Fatalf("unplanned initial extraction must lock only the first available source: %+v", payload)
	}
	runDramaTicks(t, svc, draft.Project.ID, 6)
	if len(fake.requests) != 1 || fake.byKind["bible"] != 1 || !strings.Contains(fake.requests[0].Prompt, "首章限定甲") || strings.Contains(fake.requests[0].Prompt, "不得提前提取乙") {
		t.Fatalf("unplanned extraction must not fall back to the entire book: %+v", fake.requests)
	}
}

func TestDramaInitialAssetsTraditionalProductionKeepsWholeSource(t *testing.T) {
	svc, fake := newDramaTestService(t)
	summary, err := svc.CreateDrama("usr-drama", CreateDramaRequest{Name: "传统制作", Start: true, Settings: DramaSettings{EpisodeMode: DramaEpisodeModeChapter, ChaptersPerEpisode: 1, MediaMode: DramaMediaManual, Models: fakeDramaModels}, Chapters: []DramaChapterInput{
		{Title: "第一集", Text: "传统全源甲：萧炎走进大厅。"},
		{Title: "第二集", Text: "传统全源乙：纳兰嫣然准备退婚。"},
		{Title: "第三集", Text: "传统全源丙：药老藏在戒指里。"},
	}})
	if err != nil {
		t.Fatal(err)
	}
	runDramaTicks(t, svc, summary.Project.ID, 2)
	if fake.byKind["bible"] != 1 || len(fake.requests) == 0 {
		t.Fatalf("traditional initial Bible must still run: %v", fake.byKind)
	}
	for _, marker := range []string{"传统全源甲", "传统全源乙", "传统全源丙"} {
		if !strings.Contains(fake.requests[0].Prompt, marker) {
			t.Fatalf("traditional initial Bible lost part of its whole-book source: %s", fake.requests[0].Prompt)
		}
	}
	job := initialAssetsTestJob(t, svc, summary.Project.ID)
	if job.PayloadJSON != "" || job.EpisodeID != "" {
		t.Fatalf("traditional initial job must retain the whole-book contract: %+v", job)
	}
}
