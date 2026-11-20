package app

import (
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"yingce/backend/internal/model"
	"yingce/backend/internal/production"
)

type initialAssetsTestPayload struct {
	InitialAssets      bool     `json:"initialAssets"`
	SourceChapterIDs   []string `json:"sourceChapterIds"`
	SourceEpisodeIDs   []string `json:"sourceEpisodeIds"`
	ReferenceChapterID string   `json:"referenceChapterId"`
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

func TestDramaInitialAssetsKeepReferenceAssetsAtProjectScope(t *testing.T) {
	svc, fake := newDramaTestService(t)
	const reference = "人物小传\n秦子文\n年龄：26岁\n性格：冷静谨慎\n王小莉\n年龄：28岁\n梗概提到旧宅和银钥匙。"
	draft, err := svc.CreateDrama("usr-drama", CreateDramaRequest{Name: "剧本含前置资料", Guided: true, SourceFormat: "script", ReferenceText: reference, Settings: DramaSettings{Models: fakeDramaModels}, Chapters: []DramaChapterInput{
		{Title: "第1集", Text: "第一集独有正文：秦子武走过。"},
		{Title: "第2集", Text: "所选第二集正文：秦子文在大厅拿起手电。"},
	}})
	if err != nil || len(draft.Episodes) != 2 {
		t.Fatalf("reference must not create a numbered episode: %+v %v", draft.Episodes, err)
	}
	projectID := draft.Project.ID
	assets, err := svc.ConfirmDramaGuide("usr-drama", projectID, ConfirmDramaGuideRequest{ExpectedStep: model.DramaGuideConfiguring, ExpectedRevision: draft.Production.Revision, EpisodeID: draft.Episodes[1].ID})
	if err != nil {
		t.Fatal(err)
	}
	job := initialAssetsTestJob(t, svc, projectID)
	payload := decodeInitialAssetsTestPayload(t, job)
	referenceRow, err := svc.repo.DramaSourceReference(projectID)
	if err != nil || referenceRow == nil || payload.ReferenceChapterID != referenceRow.ID || !reflect.DeepEqual(payload.SourceEpisodeIDs, []string{assets.Episodes[1].ID}) {
		t.Fatalf("reference must be persisted apart from the selected episode: %+v %+v %v", payload, referenceRow, err)
	}
	const result = `{"characters":[{"name":"秦子文","sourceDefinition":"秦子文\n年龄：26岁\n性格：冷静谨慎","sourceChapterIndex":0}],"props":[{"name":"手电"}],"scenes":[{"name":"大厅"}],"referenceAssets":{"characters":[{"name":"王小莉","sourceDefinition":"王小莉\n年龄：28岁","sourceChapterIndex":0}],"props":[{"name":"银钥匙"}],"scenes":[{"name":"旧宅"}]}}`
	svc.dramaTaskHook = func(userID string, req CreateTaskRequest, timeline *renderProject) (*model.Task, error) {
		task, err := fake.submit(userID, req, timeline)
		if err != nil || !strings.Contains(req.Prompt, "【作品参考资料】") {
			return task, err
		}
		encoded, err := json.Marshal(map[string]string{"mode": "text", "text": result})
		if err != nil {
			return nil, err
		}
		task.ResultJSON = string(encoded)
		return task, fake.db.Model(task).UpdateColumn("result_json", task.ResultJSON).Error
	}
	runDramaTicks(t, svc, projectID, 6)
	if len(fake.requests) != 1 || !strings.Contains(fake.requests[0].Prompt, reference) || !strings.Contains(fake.requests[0].Prompt, "所选第二集正文") || strings.Contains(fake.requests[0].Prompt, "第一集独有正文") {
		t.Fatalf("initial extraction did not receive only the selected episode and reference: %+v", fake.requests)
	}
	selected, err := svc.repo.DramaEpisode(projectID, assets.Episodes[1].ID)
	if err != nil || !reflect.DeepEqual(payload.SourceChapterIDs, decodeStringList(selected.ChapterIDsJSON)) {
		t.Fatalf("the selected episode source changed: %+v %v", selected, err)
	}
	linked := map[string]bool{}
	for _, id := range decodeStringList(selected.AssetIDsJSON) {
		linked[id] = true
	}
	casts, err := svc.repo.DramaCasts(projectID)
	if err != nil || len(casts) != 6 || len(linked) != 3 {
		t.Fatalf("expected three episode assets plus three reference assets: %+v %+v %v", casts, linked, err)
	}
	for _, cast := range casts {
		switch cast.Name {
		case "王小莉", "银钥匙", "旧宅":
			if linked[cast.ID] || cast.ImageStatus != model.DramaMediaDraft {
				t.Fatalf("reference-only asset entered episode membership or automatic imagery: %+v", cast)
			}
		case "秦子文":
			if !linked[cast.ID] || cast.Description != "秦子文\n年龄：26岁\n性格：冷静谨慎" {
				t.Fatalf("formal cast must retain the exact reference definition: %+v", cast)
			}
		default:
			if !linked[cast.ID] {
				t.Fatalf("formal asset missing from episode membership: %+v", cast)
			}
		}
	}
	if row := episodeCompletionRow(t, svc, projectID, selected.ID); !row.AssetsReady {
		t.Fatalf("the separate reference interfered with episode readiness evidence: %+v", row)
	}
	next := guideSummary(t, svc, projectID)
	_, err = svc.ConfirmDramaGuide("usr-drama", projectID, ConfirmDramaGuideRequest{ExpectedStep: model.DramaGuideAssets, ExpectedRevision: next.Production.Revision, EpisodeID: selected.ID})
	if err != nil {
		t.Fatal(err)
	}
	runDramaTicks(t, svc, projectID, 6)
	for _, req := range fake.requests[1:] {
		if _, body, ok := strings.Cut(req.Prompt, "【对应原文】"); ok {
			if !strings.Contains(body, "所选第二集正文") || strings.Contains(body, "人物小传") || strings.Contains(body, "第一集独有正文") {
				t.Fatalf("storyboard received unrelated source: %s", body)
			}
			return
		}
	}
	t.Fatal("storyboard did not submit")
}

func TestDramaInitialAssetsWithReferenceKeepsFullEpisodeAndRejectsEmptyResult(t *testing.T) {
	svc, fake := newDramaTestService(t)
	const episodeTail = "苏岚在走廊尽头掏出玉佩。"
	const referenceTail = "王小莉经营旧宅。"
	chapters := make([]DramaChapterInput, 4)
	for i := range chapters {
		head := fmt.Sprintf("第 %d 章正文。", i+1)
		body := head + strings.Repeat("字", dramaEpisodeSourceRunes/len(chapters)-len([]rune(head)))
		chapters[i] = DramaChapterInput{Title: fmt.Sprintf("第 %d 章", i+1), Text: body}
	}
	chapters[3].Text = strings.Repeat("字", dramaEpisodeSourceRunes/len(chapters)-len([]rune(episodeTail))) + episodeTail
	reference := strings.Repeat("资", production.ScriptSourceChapterRunes-len([]rune(referenceTail))) + referenceTail
	draft, err := svc.CreateDrama("usr-drama", CreateDramaRequest{
		Name: "带长篇参考资料的作品", Guided: true, SourceFormat: production.SourceNovel, ReferenceText: reference, Chapters: chapters,
		Settings: DramaSettings{Models: fakeDramaModels, EpisodeMode: DramaEpisodeModeChapter, ChaptersPerEpisode: len(chapters)},
	})
	if err != nil || len(draft.Episodes) != 1 {
		t.Fatalf("expected one episode at the legal source limit: %+v %v", draft, err)
	}
	projectID := draft.Project.ID
	assets, err := svc.ConfirmDramaGuide("usr-drama", projectID, ConfirmDramaGuideRequest{
		ExpectedStep: model.DramaGuideConfiguring, ExpectedRevision: draft.Production.Revision, EpisodeID: draft.Episodes[0].ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	const emptyResult = `{"characters":[],"scenes":[],"props":[],"referenceAssets":{"characters":[],"scenes":[],"props":[]}}`
	encoded, err := json.Marshal(map[string]string{"mode": "text", "text": emptyResult})
	if err != nil {
		t.Fatal(err)
	}
	svc.dramaTaskHook = func(userID string, req CreateTaskRequest, timeline *renderProject) (*model.Task, error) {
		task, err := fake.submit(userID, req, timeline)
		if err != nil {
			return nil, err
		}
		task.ResultJSON = string(encoded)
		return task, fake.db.Model(task).UpdateColumn("result_json", task.ResultJSON).Error
	}
	runDramaTicks(t, svc, projectID, 6)
	if len(fake.requests) != 1 {
		t.Fatalf("expected one initial extraction request, got %d", len(fake.requests))
	}
	prompt := fake.requests[0].Prompt
	for _, source := range chapters {
		if !strings.Contains(prompt, source.Text) {
			t.Fatalf("initial extraction omitted part of %s", source.Title)
		}
	}
	if !strings.Contains(prompt, reference) {
		t.Fatal("initial extraction omitted part of the reference")
	}
	failure := initialAssetsTestJob(t, svc, projectID)
	if failure.Status != model.DramaJobFailed || !strings.Contains(failure.Error, "没有识别到角色、场景或道具") {
		t.Fatalf("empty result should fail extraction: %+v", failure)
	}
	if row := episodeCompletionRow(t, svc, projectID, assets.Episodes[0].ID); row.AssetsReady {
		t.Fatal("an empty extraction result must not mark the episode assets ready")
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

func TestDramaInitialAssetsWithReferenceRetriesUnusableResult(t *testing.T) {
	const ordinaryAssets = `"characters":[{"name":"苏岚"}],"scenes":[{"name":"大厅"}],"props":[{"name":"钥匙"}]`
	const referenceAssets = `"referenceAssets":{"characters":[],"scenes":[{"name":"旧宅"}],"props":[]}`
	const validResult = `{` + ordinaryAssets + `,` + referenceAssets + `}`
	for _, test := range []struct {
		name, result, reason string
		keepsReference       bool
		legacyMessage        string
	}{
		{name: "两组均空", result: `{"characters":[],"scenes":[],"props":[],"referenceAssets":{"characters":[],"scenes":[],"props":[]}}`, reason: "没有识别到角色、场景或道具"},
		{name: "缺少资料组", result: `{` + ordinaryAssets + `}`, reason: "未返回参考资料"},
		{name: "仅资料组有资产", result: `{"characters":[],"scenes":[],"props":[],` + referenceAssets + `}`, reason: "未识别到正式正文中的资产", keepsReference: true},
		{name: "历史双空结果", result: `{"characters":[],"scenes":[],"props":[],"referenceAssets":{"characters":[],"scenes":[],"props":[]}}`, reason: "没有识别到角色、场景或道具", legacyMessage: "作品圣经没有识别到角色、场景或道具"},
	} {
		t.Run(test.name, func(t *testing.T) {
			svc, fake := newDramaTestService(t)
			const userID = "usr-drama"
			draft, err := svc.CreateDrama(userID, CreateDramaRequest{
				Name: "资料与正文", Guided: true, SourceFormat: production.SourceScript, ReferenceText: "场景设定：旧宅。",
				Settings: DramaSettings{Models: fakeDramaModels},
				Chapters: []DramaChapterInput{{Title: "第1集", Text: "苏岚在大厅里拿起钥匙。"}},
			})
			if err != nil {
				t.Fatal(err)
			}
			projectID := draft.Project.ID
			assets, err := svc.ConfirmDramaGuide(userID, projectID, ConfirmDramaGuideRequest{
				ExpectedStep: model.DramaGuideConfiguring, ExpectedRevision: draft.Production.Revision,
			})
			if err != nil {
				t.Fatal(err)
			}
			episodeID := assets.Episodes[0].ID
			queued := initialAssetsTestJob(t, svc, projectID)
			response := test.result
			svc.dramaTaskHook = func(userID string, req CreateTaskRequest, timeline *renderProject) (*model.Task, error) {
				task, err := fake.submit(userID, req, timeline)
				if err != nil {
					return nil, err
				}
				encoded, err := json.Marshal(map[string]string{"mode": "text", "text": response})
				if err != nil {
					return nil, err
				}
				task.ResultJSON = string(encoded)
				return task, fake.db.Model(task).UpdateColumn("result_json", task.ResultJSON).Error
			}

			runDramaTicks(t, svc, projectID, 4)
			failed := initialAssetsTestJob(t, svc, projectID)
			if failed.Status != model.DramaJobFailed || !failed.ResultUnusable() || !strings.Contains(failed.Error, test.reason) {
				t.Fatalf("expected unusable extraction result: %+v", failed)
			}
			guide := guideSummary(t, svc, projectID)
			if guide.Guide.CanConfirm || guide.Production.Stage != model.DramaStageBible || episodeCompletionRow(t, svc, projectID, episodeID).AssetsReady {
				t.Fatalf("an unusable result advanced the guide: %+v", guide.Guide)
			}
			casts, err := svc.repo.DramaCasts(projectID)
			if err != nil {
				t.Fatal(err)
			}
			if test.keepsReference && (len(casts) != 1 || casts[0].Name != "旧宅" || casts[0].ImageStatus != model.DramaMediaDraft) ||
				!test.keepsReference && len(casts) != 0 {
				t.Fatalf("unexpected project assets after failed extraction: %+v", casts)
			}
			if test.legacyMessage != "" {
				// 历史作业只记录解析错误，不带不可用结果的标记。
				failed.PayloadJSON = queued.PayloadJSON
				failed.Error = "结果处理失败（保留原任务，重试不重复生成）：作品圣经解析失败：" + test.legacyMessage
				if err := svc.repo.SaveDramaJob(&failed); err != nil {
					t.Fatal(err)
				}
			}

			response = validResult
			retry, err := svc.RetryDramaProjectText(userID, projectID)
			if err != nil || retry["jobs"] != 1 {
				t.Fatalf("retry initial assets: %+v %v", retry, err)
			}
			runDramaTicks(t, svc, projectID, 4)
			saved := initialAssetsTestJob(t, svc, projectID)
			if saved.Status != model.DramaJobSucceeded || saved.ID != queued.ID || saved.TaskID == failed.TaskID ||
				saved.TaskID == "" || len(fake.requests) != 2 || !reflect.DeepEqual(decodeInitialAssetsTestPayload(t, saved), decodeInitialAssetsTestPayload(t, queued)) {
				t.Fatalf("retry must regenerate once using the original scope: %+v %v", saved, fake.byKind)
			}
			originalTask, err := svc.repo.Task(failed.TaskID)
			if err != nil || originalTask.Status != model.TaskStatusSucceeded {
				t.Fatalf("original task must remain in history: %+v %v", originalTask, err)
			}
			episode, err := svc.repo.DramaEpisode(projectID, episodeID)
			if err != nil || len(decodeStringList(episode.AssetIDsJSON)) != 3 || !episodeCompletionRow(t, svc, projectID, episodeID).AssetsReady {
				t.Fatalf("valid retry must link only the three formal assets: %+v %v", episode, err)
			}
			casts, err = svc.repo.DramaCasts(projectID)
			if err != nil || len(casts) != 4 {
				t.Fatalf("valid retry must keep a single copy of each asset: %+v %v", casts, err)
			}
		})
	}
}

func TestDramaInitialAssetsRequireFormalAssetsAndRecoverCharacterDefinition(t *testing.T) {
	for _, tc := range []struct {
		mode   string
		guided bool
	}{{"guided", true}, {"automatic", false}} {
		t.Run(tc.mode, func(t *testing.T) {
			svc, fake := newDramaTestService(t)
			const userID = "usr-drama"
			const definition = "苏岚：短发，戴金边眼镜。"
			const otherDefinition = "陈晨：身穿蓝色制服。"
			summary, err := svc.CreateDrama(userID, CreateDramaRequest{
				Name: "资料角色重试", Guided: tc.guided, Start: !tc.guided, SourceFormat: "script",
				ReferenceText: "人物小传\n" + definition + "\n" + otherDefinition + "\n背景：北城老宅。",
				Settings:      DramaSettings{MediaMode: DramaMediaManual, Models: fakeDramaModels},
				Chapters:      []DramaChapterInput{{Title: "第一集", Text: "苏岚在值班室等陈晨。"}},
			})
			if err != nil {
				t.Fatal(err)
			}
			projectID := summary.Project.ID
			if tc.guided {
				summary, err = svc.ConfirmDramaGuide(userID, projectID, ConfirmDramaGuideRequest{ExpectedStep: model.DramaGuideConfiguring, ExpectedRevision: summary.Production.Revision})
				if err != nil {
					t.Fatal(err)
				}
			}
			response := `{"characters":[],"scenes":[],"props":[],"referenceAssets":{"characters":[{"name":"苏岚","description":"值班室住户"},{"name":"陈晨","description":"值班人员"}],"scenes":[{"name":"老宅"}],"props":[]}}`
			svc.dramaTaskHook = func(userID string, req CreateTaskRequest, timeline *renderProject) (*model.Task, error) {
				task, err := fake.submit(userID, req, timeline)
				if err != nil || !strings.Contains(req.Prompt, "【作品参考资料】") {
					return task, err
				}
				encoded, err := json.Marshal(map[string]string{"mode": "text", "text": response})
				if err != nil {
					return nil, err
				}
				task.ResultJSON = string(encoded)
				return task, fake.db.Model(task).UpdateColumn("result_json", task.ResultJSON).Error
			}
			runDramaTicks(t, svc, projectID, 4)
			job := initialAssetsTestJob(t, svc, projectID)
			p, err := svc.repo.DramaProduction(projectID)
			if err != nil || p.Stage != model.DramaStageBible || job.Status != model.DramaJobFailed || !job.ResultUnusable() || fake.byKind["script"] != 0 || episodeCompletionRow(t, svc, projectID, summary.Episodes[0].ID).AssetsReady {
				t.Fatalf("reference-only result advanced production: job=%+v production=%+v requests=%v err=%v", job, p, fake.byKind, err)
			}
			casts, err := svc.repo.DramaCasts(projectID)
			if err != nil || len(casts) != 3 {
				t.Fatalf("missing reference assets: %+v %v", casts, err)
			}
			ids := map[string]string{}
			for _, cast := range casts {
				ids[cast.Name] = cast.ID
			}
			manual := "人工核定的角色描述"
			if _, err := svc.UpdateDramaCast(userID, projectID, ids["陈晨"], UpdateDramaCastRequest{ExpectedRevision: &p.Revision, Description: &manual}); err != nil {
				t.Fatal(err)
			}
			response = `{"characters":[{"name":"苏岚","appearance":"短发","sourceDefinition":"` + definition + `","sourceChapterIndex":0},{"name":"陈晨","sourceDefinition":"` + otherDefinition + `","sourceChapterIndex":0}],"scenes":[],"props":[],"referenceAssets":{"characters":[],"scenes":[],"props":[]}}`
			if tc.guided {
				_, err = svc.RetryDramaProjectText(userID, projectID)
			} else {
				_, err = svc.RetryFailedDrama(userID, projectID)
			}
			if err != nil {
				t.Fatal(err)
			}
			runDramaTicks(t, svc, projectID, 2)
			completed := initialAssetsTestJob(t, svc, projectID)
			if completed.Status != model.DramaJobSucceeded || completed.ID != job.ID || completed.TaskID == job.TaskID || !episodeCompletionRow(t, svc, projectID, summary.Episodes[0].ID).AssetsReady {
				t.Fatalf("valid retry did not advance the original job: %+v", completed)
			}
			casts, err = svc.repo.DramaCasts(projectID)
			if err != nil || len(casts) != 3 {
				t.Fatalf("retry changed the number of casts: %+v %v", casts, err)
			}
			for _, cast := range casts {
				if cast.ID != ids[cast.Name] {
					t.Fatalf("retry replaced original cast: %+v", cast)
				}
				switch cast.Name {
				case "苏岚":
					if cast.Description != definition || cast.Appearance != "短发" || !strings.Contains(cast.DefinitionJSON, definition) || cast.ImageStatus == model.DramaMediaDraft || cast.Revision < 1 {
						t.Fatalf("verified definition was not adopted: %+v", cast)
					}
				case "陈晨":
					if cast.Description != manual {
						t.Fatalf("retry overwrote the user's edit: %+v", cast)
					}
				case "老宅":
					if cast.ImageStatus != model.DramaMediaDraft {
						t.Fatalf("reference-only asset entered automatic production: %+v", cast)
					}
				}
			}
		})
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
		if row := episodeCompletionRow(t, svc, projectID, episode.ID); !row.AssetsReady || row.StoryboardReady {
			t.Fatalf("paid legacy extraction did not unlock the original episode: %+v", row)
		}
	}
	current := guideSummary(t, svc, projectID)
	newEpisode, err := svc.AddDramaEpisode("usr-drama", projectID, AddDramaEpisodeRequest{
		ExpectedRevision: &current.Production.Revision, Text: "在旧提取完成后新增的全新章节。", CreateDraft: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if row := episodeCompletionRow(t, svc, projectID, newEpisode.Episode.ID); row.AssetsReady {
		t.Fatalf("later episode inherited unrelated legacy extraction: %+v", row)
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
