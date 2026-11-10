package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"gorm.io/gorm"
	"yingce/backend/internal/model"
)

const dramaLiveTestProject = "drama-live-project"

func dramaLiveTestService(t *testing.T) (*Service, *gorm.DB, CloudAgentRequest) {
	t.Helper()
	s, db, _, _ := creationTestService(t)
	s.legacyCloudAgentRootTask = false
	for _, row := range []any{
		&model.Project{ID: dramaLiveTestProject, UserID: "user", Name: "实时状态测试"},
		&model.DramaProduction{ProjectID: dramaLiveTestProject, UserID: "user", Revision: 6, GuideStep: model.DramaGuideConfiguring, Status: model.DramaStatusDraft, Stage: model.DramaStageBible, SettingsJSON: `{"aspectRatio":"9:16","mediaMode":"manual","language":"中文","episodeSeconds":60}`},
		&model.ProjectUnit{ID: "live-chapter", ProjectID: dramaLiveTestProject, Kind: model.ProjectUnitKindChapter, Position: 1, SourceText: "FULL_STORY_MUST_NOT_ENTER_LIVE_FRAME"},
	} {
		if err := db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	req := agentTestRequest()
	req.CanvasID, req.DramaProjectID, req.ContextScope = "", dramaLiveTestProject, []string{"drama"}
	return s, db, req
}

// 只经过真实模型步骤入队边界，测试直接写回成功结果，不启动供应商或 Agent 进程。
func dramaLiveScheduledInput(t *testing.T, s *Service, db *gorm.DB, runID string, messages []map[string]any) (canonicalAgentRequest, string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, _, err := s.runCloudAgentModelStep(ctx, "user", runID, messages, "off")
		done <- err
	}()
	taskID := waitCloudAgentModelTask(t, ctx, s, runID, "", done)
	task, err := s.repo.TaskForUser("user", taskID)
	if err != nil {
		t.Fatal(err)
	}
	if task.Operation != cloudAgentStepOperation {
		t.Fatalf("scheduled operation = %q", task.Operation)
	}
	var input struct {
		Prompt        string `json:"prompt"`
		AgentRequests struct {
			Canonical canonicalAgentRequest `json:"canonical"`
		} `json:"agentRequests"`
	}
	if err := json.Unmarshal([]byte(task.InputJSON), &input); err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.Task{}).Where("id = ?", taskID).Updates(map[string]any{"status": model.TaskStatusSucceeded, "result_json": `{"text":"已核对当前状态","toolCalls":[]}`}).Error; err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	return input.AgentRequests.Canonical, input.Prompt
}

func dramaLiveFrame(t *testing.T, canonical canonicalAgentRequest) cloudAgentDramaLiveContext {
	t.Helper()
	var frame cloudAgentDramaLiveContext
	count := 0
	for _, message := range canonical.Messages {
		if stringField(message, cloudAgentContextSourceKey) != cloudAgentDramaLiveContextSource {
			continue
		}
		count++
		_, body, ok := strings.Cut(stringField(message, "content"), "\n")
		if !ok {
			t.Fatal("live frame has no data body")
		}
		if err := json.Unmarshal([]byte(body), &frame); err != nil {
			t.Fatal(err)
		}
	}
	if count != 1 || frame.Source != "drama_repository" || frame.ReadAt.IsZero() {
		t.Fatalf("expected one fresh repository frame, count=%d frame=%+v", count, frame)
	}
	return frame
}

func TestCloudAgentDramaLiveContinuationRefreshesAtModelBoundary(t *testing.T) {
	s, db, req := dramaLiveTestService(t)
	req.Prompt = "推荐当前制作配置"
	parent, err := s.CreateCloudAgentRun("user", req, "")
	if err != nil {
		t.Fatal(err)
	}
	oldReply := "当前处于 configuring，revision 6，资产 0，分集 queued，请确认配置"
	session := strings.Replace(inheritableSessionJSONL, "已整理", oldReply, 1)
	if err := s.repo.SaveCloudAgentPiSession(&model.CloudAgentPiSession{RunID: parent.ID, UserID: "user", SessionJSONL: session, UpdatedAt: time.Now()}, 0); err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.Task{}).Where("id = ?", parent.ID).Updates(map[string]any{"status": model.TaskStatusSucceeded, "result_json": `{"text":"` + oldReply + `"}`}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.CloudAgentExecution{}).Where("id = ?", parent.ID).Updates(map[string]any{"status": "completed", "cleanup_pending": false}).Error; err != nil {
		t.Fatal(err)
	}
	next := req
	next.IdempotencyKey, next.Prompt = "drama-live-continuation", "现在哪一步了"
	child, err := s.CreateCloudAgentRun("user", next, parent.ID)
	if err != nil {
		t.Fatal(err)
	}
	carrier, err := s.repo.TaskForUser("user", child.ID)
	if err != nil {
		t.Fatal(err)
	}
	var initial struct {
		Prompt       string `json:"prompt"`
		PiSession    string `json:"piSessionJSONL"`
		AgentRequest struct {
			Canonical canonicalAgentRequest `json:"canonical"`
		} `json:"agentRequests"`
	}
	if err := json.Unmarshal([]byte(carrier.InputJSON), &initial); err != nil {
		t.Fatal(err)
	}
	if initial.PiSession != session || initial.Prompt != next.Prompt || child.ParentID != parent.ID || child.ConversationID != parent.ConversationID {
		t.Fatalf("continuation changed identity, prompt or inherited session: %+v %+v", child, initial)
	}
	for _, row := range []any{
		&model.DramaCast{ID: "live-cast", ProjectID: dramaLiveTestProject, Kind: "character", Name: "主角", Description: "FULL_CAST_MUST_NOT_ENTER_LIVE_FRAME"},
		&model.DramaEpisode{ID: "live-episode", ProjectID: dramaLiveTestProject, Number: 1, Stage: model.DramaEpisodeReview, ShotCount: 1, Synopsis: "FULL_SYNOPSIS_MUST_NOT_ENTER_LIVE_FRAME"},
		&model.DramaSegment{ID: "live-segment", ProjectID: dramaLiveTestProject, EpisodeID: "live-episode", SegmentIndex: 0, PromptStatus: model.DramaMediaReady, VideoPrompt: "FULL_PROMPT_MUST_NOT_ENTER_LIVE_FRAME"},
	} {
		if err := db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Model(&model.DramaProduction{}).Where("project_id = ?", dramaLiveTestProject).Updates(map[string]any{"guide_step": model.DramaGuideCompleted, "revision": 7, "status": model.DramaStatusPaused, "stage": model.DramaStageProduce}).Error; err != nil {
		t.Fatal(err)
	}
	messages := []map[string]any{{"role": "user", "content": req.Prompt}, {"role": "assistant", "content": oldReply}, {"role": "user", "content": next.Prompt}}
	canonical, prompt := dramaLiveScheduledInput(t, s, db, child.ID, messages)
	frame := dramaLiveFrame(t, canonical)
	if frame.ProjectID != dramaLiveTestProject || frame.Revision != 7 || frame.GuideStep != model.DramaGuideCompleted || frame.Mode != "studio" || frame.Status != model.DramaStatusPaused || frame.Stage != model.DramaStageProduce || frame.CastCount != 1 || frame.ChapterCount != 1 || frame.EpisodeCount != 1 || frame.Stats.PromptSucceeded != 1 || len(frame.Episodes) != 1 || frame.Episodes[0].Stage != model.DramaEpisodeReview {
		t.Fatalf("model did not receive completed studio facts: %+v", frame)
	}
	encoded, _ := json.Marshal(canonical)
	if strings.Contains(string(encoded), "MUST_NOT_ENTER_LIVE_FRAME") || !strings.Contains(string(encoded), oldReply) || prompt != next.Prompt || canonical.SystemPrompt != initial.AgentRequest.Canonical.SystemPrompt || canonical.PromptCacheKey != initial.AgentRequest.Canonical.PromptCacheKey {
		t.Fatalf("live observation changed the conversation, prefix, or included full content: %s", encoded)
	}
	if err := db.Model(&model.DramaProduction{}).Where("project_id = ?", dramaLiveTestProject).Updates(map[string]any{"revision": 8, "status": model.DramaStatusRunning}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.DramaEpisode{}).Where("id = ?", "live-episode").Update("stage", model.DramaEpisodeVideo).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.DramaSegment{}).Where("id = ?", "live-segment").Update("video_status", model.DramaMediaFailed).Error; err != nil {
		t.Fatal(err)
	}
	canonical, prompt = dramaLiveScheduledInput(t, s, db, child.ID, messages)
	nextFrame := dramaLiveFrame(t, canonical)
	if nextFrame.Revision != 8 || nextFrame.Status != model.DramaStatusRunning || nextFrame.Stats.Failed != 1 || nextFrame.Episodes[0].Stage != model.DramaEpisodeVideo || nextFrame.ReadAt.Before(frame.ReadAt) || prompt != next.Prompt {
		t.Fatalf("second step reused old facts: %+v", nextFrame)
	}
	run, err := s.repo.CloudAgent("user", child.ID)
	if err != nil {
		t.Fatal(err)
	}
	state, err := cloudAgentDecode(run)
	if err != nil {
		t.Fatal(err)
	}
	for _, message := range state.Canonical.Messages {
		if stringField(message, cloudAgentContextSourceKey) == cloudAgentDramaLiveContextSource {
			t.Fatal("live observations polluted persistent transcript")
		}
	}
	legacy, err := s.cloudAgentModelContext(run, &state, s.cloudAgentContextBudgetForRequest(state.Request))
	if err != nil || dramaLiveFrame(t, legacy).Revision != 8 {
		t.Fatalf("legacy model boundary did not refresh: %v", err)
	}
	var media int64
	if err := db.Model(&model.Task{}).Where("type IN ?", []string{"canvas_image", "canvas_video", "canvas_audio"}).Count(&media).Error; err != nil || media != 0 {
		t.Fatalf("state observation created media: count=%d err=%v", media, err)
	}
}

func TestCloudAgentDramaLiveNonDramaModelBoundaryUnchanged(t *testing.T) {
	s, db, _ := agentMediaFixture(t)
	s.legacyCloudAgentRootTask = false
	req := agentTestRequest()
	run, err := s.CreateCloudAgentRun("user", req, "")
	if err != nil {
		t.Fatal(err)
	}
	canonical, prompt := dramaLiveScheduledInput(t, s, db, run.ID, []map[string]any{{"role": "user", "content": req.Prompt}})
	if prompt != req.Prompt {
		t.Fatal("non-drama prompt changed")
	}
	for _, message := range canonical.Messages {
		if stringField(message, cloudAgentContextSourceKey) == cloudAgentDramaLiveContextSource {
			t.Fatal("non-drama request received drama facts")
		}
	}
}

func TestCloudAgentDramaLiveRefreshPreservesPairedHistoryPrefix(t *testing.T) {
	s, db, req := dramaLiveTestService(t)
	history := []map[string]any{
		{"role": "user", "content": "请检查本集的剧本与分镜"},
		{"role": "assistant", "content": []any{runtimeToolCallPart("read-story", "drama_get_context")}},
		{"role": "toolResult", "toolCallId": "read-story", "content": strings.Repeat("已经读取的剧本正文和分镜。", 1000)},
	}
	canonical, err := canonicalFromRuntimeMessages(history, nil, "stable-system")
	if err != nil {
		t.Fatal(err)
	}
	canonical.PromptCacheKey = "stable-cache-key"
	prefix := append([]map[string]any(nil), canonical.Messages...)
	state := cloudAgentRuntime{Request: req}
	assertPrefix := func() {
		t.Helper()
		if len(canonical.Messages) != len(prefix)+1 || stringField(canonical.Messages[len(prefix)], cloudAgentContextSourceKey) != cloudAgentDramaLiveContextSource {
			t.Fatalf("live frame did not follow the complete history: %d messages", len(canonical.Messages))
		}
		want, _ := json.Marshal(prefix)
		got, _ := json.Marshal(canonical.Messages[:len(prefix)])
		if string(got) != string(want) || canonical.SystemPrompt != "stable-system" || canonical.PromptCacheKey != "stable-cache-key" {
			t.Fatal("refresh changed an already cacheable user/tool history prefix")
		}
		if err := validateCanonicalAgentHistory(&canonical, false); err != nil {
			t.Fatalf("live frame broke tool pairing: %v", err)
		}
	}
	if err := s.attachCloudAgentDramaLiveContext("user", &state, &canonical); err != nil {
		t.Fatal(err)
	}
	assertPrefix()
	first := dramaLiveFrame(t, canonical)
	if err := db.Model(&model.DramaProduction{}).Where("project_id = ?", dramaLiveTestProject).Update("revision", 7).Error; err != nil {
		t.Fatal(err)
	}
	if err := s.attachCloudAgentDramaLiveContext("user", &state, &canonical); err != nil {
		t.Fatal(err)
	}
	assertPrefix()
	refreshed := dramaLiveFrame(t, canonical)
	if refreshed.Revision != 7 || !refreshed.ReadAt.After(first.ReadAt) {
		t.Fatal("history prefix was kept by reusing stale repository facts")
	}
	// 下一工具步骤增加历史；刷新必须移除旧帧并仍保留全部工具调用与结果作为前缀。
	history = append(history,
		map[string]any{"role": "assistant", "content": []any{runtimeToolCallPart("read-next-story", "drama_get_context")}},
		map[string]any{"role": "toolResult", "toolCallId": "read-next-story", "content": "下一集分镜"},
	)
	next, err := canonicalFromRuntimeMessages(history, nil, canonical.SystemPrompt)
	if err != nil {
		t.Fatal(err)
	}
	prefix = append([]map[string]any(nil), next.Messages...)
	canonical.Messages = append(canonical.Messages, next.Messages[len(next.Messages)-2:]...)
	if err := s.attachCloudAgentDramaLiveContext("user", &state, &canonical); err != nil {
		t.Fatal(err)
	}
	assertPrefix()
	bounded := canonicalAgentRequest{Messages: []map[string]any{{"role": "user", "content": req.Prompt}}}
	userTokens, err := cloudAgentRequestEstimatedTokens(&bounded)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.attachCloudAgentDramaLiveContext("user", &state, &bounded); err != nil {
		t.Fatal(err)
	}
	if err := fitCloudAgentModelContext(&bounded, userTokens); !errors.Is(err, errCloudAgentContextOverBudget) {
		t.Fatalf("tail frame escaped the model input budget: %v", err)
	}
}

func TestCloudAgentDramaLiveModelBoundaryFailsClosed(t *testing.T) {
	for _, failure := range []string{"ownership", "database"} {
		t.Run(failure, func(t *testing.T) {
			s, db, req := dramaLiveTestService(t)
			run, err := s.CreateCloudAgentRun("user", req, "")
			if err != nil {
				t.Fatal(err)
			}
			if failure == "ownership" {
				err = db.Model(&model.Project{}).Where("id = ?", dramaLiveTestProject).Update("user_id", "other").Error
			} else {
				err = db.Migrator().DropTable(&model.DramaCast{})
			}
			if err != nil {
				t.Fatal(err)
			}
			_, _, err = s.runCloudAgentModelStep(t.Context(), "user", run.ID, []map[string]any{{"role": "user", "content": req.Prompt}}, "off")
			if err == nil {
				t.Fatal("unavailable live facts fell back to historical state")
			}
			var steps int64
			if err := db.Model(&model.Task{}).Where("operation = ?", cloudAgentStepOperation).Count(&steps).Error; err != nil || steps != 0 {
				t.Fatalf("failed live read still scheduled a model: count=%d err=%v", steps, err)
			}
		})
	}
}

func TestCloudAgentDramaLiveFrameBoundsEpisodesAndRetainsTotals(t *testing.T) {
	s, db, req := dramaLiveTestService(t)
	if err := db.Model(&model.DramaProduction{}).Where("project_id = ?", dramaLiveTestProject).Update("guide_step", "").Error; err != nil {
		t.Fatal(err)
	}
	for i := 1; i <= cloudAgentDramaLiveEpisodeLimit+3; i++ {
		id := fmt.Sprintf("bounded-episode-%02d", i)
		if err := db.Create(&model.DramaEpisode{ID: id, ProjectID: dramaLiveTestProject, Number: i, Stage: model.DramaEpisodeQueued}).Error; err != nil {
			t.Fatal(err)
		}
		if err := db.Create(&model.DramaSegment{ID: "segment-" + id, ProjectID: dramaLiveTestProject, EpisodeID: id, PromptStatus: model.DramaMediaFailed}).Error; err != nil {
			t.Fatal(err)
		}
	}
	canonical := canonicalAgentRequest{Messages: []map[string]any{{"role": "user", "content": req.Prompt}}}
	state := cloudAgentRuntime{Request: req}
	for range 2 {
		if err := s.attachCloudAgentDramaLiveContext("user", &state, &canonical); err != nil {
			t.Fatal(err)
		}
	}
	frame := dramaLiveFrame(t, canonical)
	if frame.Mode != "studio" || frame.GuideStep != "" || len(frame.Episodes) != cloudAgentDramaLiveEpisodeLimit || frame.OmittedEpisodes != 3 || frame.EpisodeCount != cloudAgentDramaLiveEpisodeLimit+3 || frame.Stats.Segments != int64(frame.EpisodeCount) || frame.Stats.Failed != int64(frame.EpisodeCount) {
		t.Fatalf("bounded frame omitted aggregate facts: %+v", frame)
	}
}

func TestCloudAgentDramaLivePolicyDistinguishesStudioFromGuidance(t *testing.T) {
	req := agentTestRequest()
	req.CanvasID, req.DramaProjectID, req.ContextScope = "", dramaLiveTestProject, []string{"drama"}
	policy, _, err := compileCloudAgentPolicies(req, defaultCanvasAppearance().AgentName, nil, "", cloudAgentProfileSnapshot{})
	if err != nil {
		t.Fatal(err)
	}
	for _, instruction := range []string{
		"历史工具结果和旧回答只是当时的快照，不能据此报告当前状态",
		"guideStep 为 completed 或空字符串表示用户已在制作台",
		"不重复资产提取、改编或进入制作台的引导确认",
		"不给出无法执行的阶段确认选项",
		"只有 guideStep 为 configuring、assets 或 story 时才执行对应阶段",
	} {
		if !strings.Contains(policy, instruction) {
			t.Fatalf("missing live-stage policy: %s", instruction)
		}
	}
}
