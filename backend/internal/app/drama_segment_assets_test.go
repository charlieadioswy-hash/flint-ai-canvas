package app

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"yingce/backend/internal/model"
)

func TestDramaSegmentAssetUpdateKeepsDraftAndRejectsLateVideo(t *testing.T) {
	svc, fake := newDramaTestService(t)
	summary := createTestDrama(t, svc, DramaReviewAuto)
	projectID := summary.Project.ID
	runDramaTicks(t, svc, projectID, 24)
	summary, _ = svc.DramaSummary("usr-drama", projectID)
	rows, _ := svc.repo.DramaSegments(summary.Episodes[0].ID)
	old := rows[0]
	manual := "纳兰嫣然（参考图2）抬手，说：我今日来，是要退婚。"
	if err := svc.repo.UpdateDramaSegmentFields(old.ID, map[string]any{"video_prompt_override": manual}); err != nil {
		t.Fatal(err)
	}
	staleCasts, _ := svc.repo.DramaCasts(projectID)
	var heroine model.DramaCast
	for _, cast := range staleCasts {
		if cast.Name == "纳兰嫣然" {
			heroine = cast
		}
	}
	image, sample := fake.resource("usr-drama", "image", "image/png"), fake.resource("usr-drama", "audio", "audio/wav")
	if err := svc.repo.UpdateDramaCastFields(heroine.ID, map[string]any{"appearance": "银发，深蓝长袍", "voice_instructions": "低沉沙哑的女声", "image_status": model.DramaMediaReady, "image_resource_id": image, "voice_sample_resource_id": sample}); err != nil {
		t.Fatal(err)
	}
	current, _ := svc.repo.DramaSegment(projectID, old.ID)
	if current.Revision != old.Revision || current.VideoRevision <= old.VideoRevision || current.PromptStatus != old.PromptStatus || current.VideoPrompt != old.VideoPrompt || current.VideoPromptOverride != manual || current.VideoStatus != model.DramaMediaStale {
		t.Fatalf("asset changes must preserve segment writing: old=%+v current=%+v", old, current)
	}
	run := &dramaRun{s: svc, project: &summary.Project, production: &model.DramaProduction{}, casts: staleCasts}
	payload, _ := json.Marshal(dramaRevisionPayload{Revision: old.Revision, VideoRevision: old.VideoRevision, Seconds: 5})
	late := &model.Task{ID: "late-asset-video", Prompt: "旧资产任务", ResultJSON: `{"mode":"video","video":{"resourceId":"late-paid-output"}}`}
	job := &model.DramaJob{Kind: model.DramaJobSegmentVideo, ShotID: old.ID, PayloadJSON: string(payload)}
	if err := run.applySegmentVideo(job, late); err != nil {
		t.Fatal(err)
	}
	if err := run.markRunning(job); err != nil {
		t.Fatal(err)
	}
	if err := run.failJob(job, "旧资产任务失败"); err != nil {
		t.Fatal(err)
	}
	current, _ = svc.repo.DramaSegment(projectID, old.ID)
	if current.VideoStatus != model.DramaMediaStale || current.VideoResourceID != old.VideoResourceID {
		t.Fatalf("old task overwrote latest asset state: %+v", current)
	}
	takes, err := svc.repo.DramaTakes(projectID, old.ID, "video", 20)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, take := range takes {
		found = found || take.ResourceID == "late-paid-output"
	}
	if !found {
		t.Fatal("old paid output must remain in history")
	}
	// 即使调度轮次仍持有旧资产快照，真正提交时也必须重新读最新资产。
	video := dramaVideoFixture()
	video.References.MaxAudios = 2
	setDramaVideoCapability(t, svc, fake, video)
	p, _ := svc.repo.DramaProduction(projectID)
	run.production, run.settings, run.meta = p, parseDramaSettings(p.SettingsJSON), parseDramaBibleMeta(p.BibleJSON)
	if err := svc.repo.UpdateDramaSegmentFields(old.ID, map[string]any{"video_status": model.DramaMediaQueued}); err != nil {
		t.Fatal(err)
	}
	beforePrompts := fake.byKind["segment_prompt"]
	task, skip, err := run.submitSegmentVideo(&model.DramaJob{ShotID: old.ID, EpisodeID: old.EpisodeID})
	if err != nil || skip || task == nil {
		t.Fatalf("submit with latest asset: skip=%v err=%v", skip, err)
	}
	reqs := dramaVideoRequests(fake)
	req := reqs[len(reqs)-1]
	for _, want := range []string{manual, "银发，深蓝长袍", "低沉沙哑的女声", "参考音频1：纳兰嫣然的声音"} {
		if !strings.Contains(req.Prompt, want) {
			t.Fatalf("latest request omitted %q: %s", want, req.Prompt)
		}
	}
	media, _ := json.Marshal(req.Input)
	if !strings.Contains(string(media), "resource:"+image) || !strings.Contains(string(media), "resource:"+sample) || fake.byKind["segment_prompt"] != beforePrompts {
		t.Fatalf("latest media missing or segment was rewritten: %s", media)
	}
}

func TestDramaSegmentAssetHeaderIncludesUnpicturedSubjectsAndInheritedVoice(t *testing.T) {
	casts := map[string]model.DramaCast{
		"hero":  {ID: "hero", Kind: "character", Name: "新姓名", AliasesJSON: `["旧姓名"]`, Appearance: "默认服装", VoiceInstructions: "成熟低音"},
		"look":  {ID: "look", Kind: "character", ParentID: "hero", Name: "旧姓名", LookName: "晚宴", Appearance: "黑色礼服"},
		"scene": {ID: "scene", Kind: "scene", Name: "大厅", Appearance: "大理石地面"},
		"prop":  {ID: "prop", Kind: "prop", Name: "信封", Appearance: "蓝色信封"},
	}
	draft := dramaSegmentDraft{shots: []model.DramaShot{{CastIDsJSON: `["hero"]`, LookCastIDsJSON: `["look"]`, SceneCastID: "scene", PropIDsJSON: `["prop"]`, Speaker: "旧姓名", Dialogue: "你好"}}}
	request := DramaSegmentRequest{GenerateAudio: true, References: []DramaSegmentReference{{CastID: "look", Label: "参考图1"}}}
	header := strings.Join(dramaSegmentLatestAssets(draft, request, casts), "\n")
	for _, want := range []string{"新姓名·晚宴（参考图1）", "旧姓名", "黑色礼服", "成熟低音", "大理石地面", "蓝色信封", "临时换装"} {
		if !strings.Contains(header, want) {
			t.Fatalf("missing %q: %s", want, header)
		}
	}
	if strings.Contains(header, "默认服装") || strings.Count(header, "成熟低音") != 1 {
		t.Fatalf("look must override default appearance and inherit one voice: %s", header)
	}
	request.GenerateAudio = false
	header = strings.Join(dramaSegmentLatestAssets(draft, request, casts), "\n")
	if strings.Contains(header, "成熟低音") || !strings.Contains(header, "无声视频") {
		t.Fatalf("silent model received speech instructions: %s", header)
	}
	look := casts["look"]
	look.Appearance = ""
	casts["look"] = look
	header = strings.Join(dramaSegmentLatestAssets(draft, request, casts), "\n")
	if !strings.Contains(header, "默认服装") {
		t.Fatalf("empty look lost inherited base appearance: %s", header)
	}
}

func TestDramaSegmentAssetOverflowDoesNotAutomaticallyRewrite(t *testing.T) {
	svc, fake, projectID, detail := dramaStudioFixture(t)
	p, _ := svc.repo.DramaProduction(projectID)
	project, _ := svc.repo.ProjectForUser("usr-drama", projectID)
	segment, _ := svc.repo.DramaSegment(projectID, detail.Segments[0].ID)
	video := dramaVideoFixture()
	video.References.PromptMaxChars = 100
	setDramaVideoCapability(t, svc, fake, video)
	if err := svc.repo.UpdateDramaSegmentFields(segment.ID, map[string]any{"video_status": model.DramaMediaQueued}); err != nil {
		t.Fatal(err)
	}
	run := &dramaRun{s: svc, project: project, production: p, settings: parseDramaSettings(p.SettingsJSON), meta: parseDramaBibleMeta(p.BibleJSON)}
	before := fake.byKind["segment_prompt"]
	_, skip, err := run.submitSegmentVideo(&model.DramaJob{ShotID: segment.ID, EpisodeID: segment.EpisodeID})
	if err == nil || skip || !strings.Contains(err.Error(), "不会自动重写") {
		t.Fatalf("overflow must stop without scheduling writing: skip=%v err=%v", skip, err)
	}
	after, _ := svc.repo.DramaSegment(projectID, segment.ID)
	if after.PromptStatus != segment.PromptStatus || after.VideoPrompt != segment.VideoPrompt || after.Revision != segment.Revision || fake.byKind["segment_prompt"] != before {
		t.Fatalf("overflow modified the original draft: %+v", after)
	}
}

func TestDramaSegmentReprocessRejectsChangedAssetInputs(t *testing.T) {
	svc, fake, projectID, detail := dramaStudioFixture(t)
	svc.dramaTailFrameHook = func(_, _ string) (string, error) { return "", errors.New("尾帧处理失败") }
	view, err := svc.PreflightDramaStudioAction("usr-drama", projectID, DramaStudioActionRequest{Action: "segment_video", TargetID: detail.Segments[0].ID})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ExecuteDramaStudioAction("usr-drama", projectID, confirmedDramaStudioRequest(view)); err != nil {
		t.Fatal(err)
	}
	runDramaTicks(t, svc, projectID, 5)
	before, _ := svc.repo.DramaSegment(projectID, detail.Segments[0].ID)
	if before.VideoStatus != model.DramaMediaFailed || before.VideoResourceID == "" {
		t.Fatalf("fixture must retain paid video needing processing: %+v", before)
	}
	casts, _ := svc.repo.DramaCasts(projectID)
	for _, cast := range casts {
		if cast.Name != "纳兰嫣然" {
			continue
		}
		if _, err := svc.repo.UpdateDramaCastRevision(cast.ID, cast.Revision, map[string]any{"image_resource_id": fake.resource("usr-drama", "image", "image/png"), "image_status": model.DramaMediaReady}); err != nil {
			t.Fatal(err)
		}
	}
	view, err = svc.PreflightDramaStudioAction("usr-drama", projectID, DramaStudioActionRequest{Action: "segment_reprocess", TargetID: before.ID})
	if err != nil || view.Ready || view.Reprocessable {
		t.Fatalf("outdated paid input must not be reprocessed as current: %+v %v", view, err)
	}
	if _, err := svc.ReprocessDramaSegmentVideo("usr-drama", projectID, before.EpisodeID, before.SegmentIndex); err == nil {
		t.Fatal("direct reprocess accepted outdated inputs")
	}
	after, _ := svc.repo.DramaSegment(projectID, before.ID)
	if after.VideoStatus != model.DramaMediaFailed || after.VideoRevision == before.VideoRevision || after.VideoResourceID != before.VideoResourceID || fake.byKind["video"] != 1 {
		t.Fatalf("outdated reprocess stuck the slot or lost paid video: %+v", after)
	}
	latest, err := svc.DramaEpisodeDetail("usr-drama", projectID, before.EpisodeID)
	if err != nil || latest.Segments[0].VideoReprocessable {
		t.Fatalf("detail should offer generation instead of outdated reprocess: %+v %v", latest.Segments, err)
	}
}
