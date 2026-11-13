package app

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"

	"gorm.io/gorm"
	"yingce/backend/internal/model"
	"yingce/backend/internal/platform"
	"yingce/backend/internal/production"
)

func sceneSplitFixture(t *testing.T) (*Service, *gorm.DB, DramaSceneSplitRequest) {
	t.Helper()
	s, db, _ := agentMediaFixture(t)
	s.coordinator = platform.NewCoordinatorWithRedis(nil, t.Name())
	settings := DramaSettings{Models: DramaModels{Text: DramaModelChoice{ChannelID: "channel", ModelKey: "text-test"}, Video: DramaModelChoice{ChannelID: "channel", ModelKey: "seedance-test"}}}
	settings.MediaMode, settings.VideoContinuity = DramaMediaManual, DramaContinuityParallel
	now := time.Now()
	for _, row := range []any{
		&model.Project{ID: "scene-project", UserID: "user", Name: "场景重拆测试", Status: model.ProjectStatusActive},
		&model.DramaProduction{ProjectID: "scene-project", UserID: "user", Revision: 3, GuideStep: model.DramaGuideStory, Status: model.DramaStatusCompleted, Stage: model.DramaStageProduce, SettingsJSON: encodeDramaSettings(settings)},
		&model.DramaEpisode{ID: "scene-episode", ProjectID: "scene-project", Number: 1, Revision: 4, Stage: model.DramaEpisodeDone, ShotCount: 3, DurationMs: 6000},
		&model.DramaCast{ID: "scene-hero", ProjectID: "scene-project", Kind: "character", Name: "秦子文", AliasesJSON: "[]"},
		&model.DramaShot{ID: "scene-shot-1", ProjectID: "scene-project", EpisodeID: "scene-episode", Position: 0, SegmentIndex: 0, Scene: "卧室", Speaker: "秦子文", Dialogue: "走吧。", Action: "起身", DurationMs: 2000, CastIDsJSON: `["scene-hero"]`, CreatedAt: now, UpdatedAt: now},
		&model.DramaShot{ID: "scene-shot-2", ProjectID: "scene-project", EpisodeID: "scene-episode", Position: 1, SegmentIndex: 0, Scene: "卧室", Action: "开门", DurationMs: 2000, CastIDsJSON: `["scene-hero"]`, CreatedAt: now, UpdatedAt: now},
		&model.DramaShot{ID: "scene-outside", ProjectID: "scene-project", EpisodeID: "scene-episode", Position: 2, SegmentIndex: 1, Scene: "院子", Action: "走出院子", Camera: "固定", DurationMs: 2000, CreatedAt: now, UpdatedAt: now},
		&model.DramaSegment{ID: "scene-segment-0", ProjectID: "scene-project", EpisodeID: "scene-episode", SegmentIndex: 0, Revision: 2, PromptStatus: model.DramaMediaReady, VideoStatus: model.DramaMediaReady, VideoResourceID: "old-segment-video", ReferenceCastIDsJSON: `["scene-hero"]`, VideoPrompt: "原段提示词", UpdatedAt: now},
		&model.DramaSegment{ID: "scene-segment-1", ProjectID: "scene-project", EpisodeID: "scene-episode", SegmentIndex: 1, Revision: 7, PromptStatus: model.DramaMediaReady, VideoStatus: model.DramaMediaReady, VideoResourceID: "outside-video", VideoPrompt: "组外提示词", UpdatedAt: now},
		&model.DramaShotMedia{ID: "scene-media", ProjectID: "scene-project", EpisodeID: "scene-episode", ShotID: "scene-shot-2", Kind: "image", Revision: 2, Status: model.DramaMediaReady, ResourceID: "old-image", CurrentTakeID: "scene-image-take", ScriptHash: "old-script", ConfigJSON: `{}`},
		&model.DramaTake{ID: "scene-image-take", ProjectID: "scene-project", OwnerID: "scene-shot-2", Kind: "shot_image", ResourceID: "old-image", Version: 1},
	} {
		if err := db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	p, e := int64(3), int64(4)
	return s, db, DramaSceneSplitRequest{ExpectedRevision: &p, EpisodeRevision: &e, ShotIDs: []string{"scene-shot-1", "scene-shot-2"}, TargetShotCount: 3, DirectorTemplate: "smart_drama", Model: settings.Models.Text}
}

func sceneSplitComplete(t *testing.T, s *Service, db *gorm.DB, req DramaSceneSplitRequest, shots []production.ScriptShot) DramaSceneSplitResult {
	t.Helper()
	preflight, err := s.PreflightDramaSceneSplit("user", "scene-project", "scene-episode", req)
	if err != nil || !preflight.Ready || !preflight.Priced || preflight.AmountMicrocredits != 100 {
		t.Fatalf("preflight = %+v %v", preflight, err)
	}
	req.ConfirmationToken, req.ClientOperationID = preflight.ConfirmationToken, "split-once"
	task, err := s.ExecuteDramaSceneSplit("user", "scene-project", "scene-episode", req)
	if err != nil {
		t.Fatal(err)
	}
	replayed, err := s.ExecuteDramaSceneSplit("user", "scene-project", "scene-episode", req)
	if err != nil || replayed.ID != task.ID {
		t.Fatalf("idempotent task = %+v %v", replayed, err)
	}
	if !strings.Contains(task.Prompt, "智能导演·剧集版") {
		t.Fatal("template did not reach task prompt")
	}
	text, _ := json.Marshal(map[string]any{"shots": shots})
	result, _ := json.Marshal(map[string]string{"text": string(text)})
	if err := db.Model(&model.Task{}).Where("id = ?", task.ID).Updates(map[string]any{"status": model.TaskStatusSucceeded, "progress": 100, "result_json": string(result)}).Error; err != nil {
		t.Fatal(err)
	}
	history, err := s.DramaSceneSplits("user", "scene-project", "scene-episode")
	if err != nil || len(history) != 1 || history[0].Stale || history[0].Text == "" {
		t.Fatalf("history = %+v %v", history, err)
	}
	return history[0]
}

func sceneSplitShots(n int) []production.ScriptShot {
	rows := make([]production.ScriptShot, n)
	for i := range rows {
		rows[i] = production.ScriptShot{Scene: "卧室", Characters: []string{"秦子文"}, Action: "起身走向门口", DurationSeconds: 2, Camera: "推镜头", ImagePrompt: "秦子文走向门口", VideoPrompt: "平稳推近"}
	}
	rows[0].Speaker, rows[0].Dialogue = "秦子文", "走吧。"
	return rows
}

func TestDramaSceneSplitExplicitAdoptionKeepsOutsideAndPaidHistory(t *testing.T) {
	for _, target := range []int{1, 3} {
		t.Run(string(rune('0'+target)), func(t *testing.T) {
			s, db, req := sceneSplitFixture(t)
			req.TargetShotCount = target
			outside, _ := s.repo.DramaShot("scene-project", "scene-outside")
			outsideSegment, _ := s.repo.DramaSegment("scene-project", "scene-segment-1")
			result := sceneSplitComplete(t, s, db, req, sceneSplitShots(target))
			before, _ := s.repo.DramaShots("scene-episode")
			if len(before) != 3 {
				t.Fatal("completed draft modified existing shots")
			}
			_, err := s.AdoptDramaSceneSplit("user", "scene-project", "scene-episode", DramaSceneSplitAdoptRequest{ExpectedRevision: req.ExpectedRevision, EpisodeRevision: req.EpisodeRevision, TakeID: result.TakeID})
			if err != nil {
				t.Fatal(err)
			}
			after, _ := s.repo.DramaShots("scene-episode")
			if len(after) != target+1 || after[0].ID != "scene-shot-1" {
				t.Fatalf("range replacement = %+v", after)
			}
			currentOutside, _ := s.repo.DramaShot("scene-project", "scene-outside")
			outside.Position = currentOutside.Position
			if !reflect.DeepEqual(outside, currentOutside) {
				t.Fatalf("outside shot changed: %+v / %+v", outside, currentOutside)
			}
			currentOutsideSegment, _ := s.repo.DramaSegment("scene-project", "scene-segment-1")
			if !reflect.DeepEqual(outsideSegment, currentOutsideSegment) {
				t.Fatal("outside segment changed")
			}
			var media model.DramaShotMedia
			db.First(&media, "id = ?", "scene-media")
			if media.Status != model.DramaMediaStale || media.Revision != 3 || media.ResourceID != "old-image" || media.CurrentTakeID != "scene-image-take" {
				t.Fatalf("paid media not preserved stale: %+v", media)
			}
			var take model.DramaTake
			if err := db.First(&take, "id = ?", "scene-image-take").Error; err != nil || take.ResourceID != "old-image" {
				t.Fatal("old take lost")
			}
			segment, _ := s.repo.DramaSegment("scene-project", "scene-segment-0")
			if segment.PromptStatus != model.DramaMediaStale || segment.VideoStatus != model.DramaMediaStale || segment.VideoResourceID != "old-segment-video" || segment.ReferenceCastIDsJSON != `["scene-hero"]` {
				t.Fatalf("range segment references lost: %+v", segment)
			}
			p, _ := s.repo.DramaProduction("scene-project")
			if p.GuideStep != model.DramaGuideStory || p.Status != model.DramaStatusCompleted || p.Revision != 4 {
				t.Fatalf("workflow restarted: %+v", p)
			}
			history, err := s.DramaSceneSplits("user", "scene-project", "scene-episode")
			if err != nil || !history[0].Applied || history[0].Snapshot == nil || !strings.Contains(history[0].Snapshot.ShotsJSON, "scene-shot-2") || !strings.Contains(history[0].Snapshot.MediaJSON, "old-image") {
				t.Fatalf("old owner snapshot missing: %+v %v", history, err)
			}
			var tasks int64
			db.Model(&model.Task{}).Where("project_id = ?", "scene-project").Count(&tasks)
			if tasks != 1 {
				t.Fatal("adoption generated more tasks")
			}
		})
	}
}

func TestDramaSceneSplitRejectsBadScopesActiveTasksAndStaleInputs(t *testing.T) {
	s, db, req := sceneSplitFixture(t)
	if _, err := s.PreflightDramaSceneSplit("other", "scene-project", "scene-episode", req); err == nil {
		t.Fatal("foreign project accepted")
	}
	bad := req
	bad.ShotIDs = []string{"scene-shot-2"}
	if _, err := s.PreflightDramaSceneSplit("user", "scene-project", "scene-episode", bad); err == nil {
		t.Fatal("partial group accepted")
	}
	bad = req
	bad.TargetShotCount = 241
	if _, err := s.PreflightDramaSceneSplit("user", "scene-project", "scene-episode", bad); err == nil {
		t.Fatal("excess target accepted")
	}
	if err := db.Create(&model.Task{ID: "scene-active", ProjectID: "scene-project", UserID: "user", Status: model.TaskStatusQueued}).Error; err != nil {
		t.Fatal(err)
	}
	blocked, err := s.PreflightDramaSceneSplit("user", "scene-project", "scene-episode", req)
	if err != nil || blocked.Ready || blocked.Reason == "" {
		t.Fatalf("active task accepted %+v %v", blocked, err)
	}
	db.Delete(&model.Task{}, "id = ?", "scene-active")
	result := sceneSplitComplete(t, s, db, req, sceneSplitShots(3))
	db.Model(&model.DramaShot{}).Where("id = ?", "scene-shot-1").Update("camera", "希区柯克镜头")
	if _, err := s.AdoptDramaSceneSplit("user", "scene-project", "scene-episode", DramaSceneSplitAdoptRequest{ExpectedRevision: req.ExpectedRevision, EpisodeRevision: req.EpisodeRevision, TakeID: result.TakeID}); !isAppErrorStatus(err, 409) {
		t.Fatalf("changed camera accepted: %v", err)
	}
	var snapshots int64
	db.Model(&model.DramaSceneRevision{}).Count(&snapshots)
	if snapshots != 0 {
		t.Fatal("rejected adoption wrote history")
	}
}

func TestDramaSceneSplitRejectsChangedDialogueAssetsCountAndDuration(t *testing.T) {
	for _, mutation := range []string{"dialogue", "asset", "count", "duration"} {
		t.Run(mutation, func(t *testing.T) {
			s, db, req := sceneSplitFixture(t)
			shots := sceneSplitShots(3)
			switch mutation {
			case "dialogue":
				shots[0].Dialogue = "新增台词"
			case "asset":
				shots[1].Characters = []string{"猜测人物"}
			case "count":
				shots = shots[:2]
			case "duration":
				for i := range shots {
					shots[i].DurationSeconds = 60
				}
			}
			result := sceneSplitComplete(t, s, db, req, shots)
			if _, err := s.AdoptDramaSceneSplit("user", "scene-project", "scene-episode", DramaSceneSplitAdoptRequest{ExpectedRevision: req.ExpectedRevision, EpisodeRevision: req.EpisodeRevision, TakeID: result.TakeID}); err == nil {
				t.Fatal("invalid generated result accepted")
			}
			current, _ := s.repo.DramaShots("scene-episode")
			if len(current) != 3 || current[0].Dialogue != "走吧。" {
				t.Fatal("rejected result changed source")
			}
		})
	}
}

func TestDramaSceneSplitCameraPresetReachesVideoRequest(t *testing.T) {
	s, _, _ := sceneSplitFixture(t)
	input, err := s.dramaShotMediaInput(s.repo, "user", model.DramaShot{ProjectID: "scene-project", EpisodeID: "scene-episode", ID: "scene-shot-1", Camera: "希区柯克镜头"}, "video", DramaShotMediaConfig{Prompt: "秦子文站在门口", Operation: "text_to_video"})
	if err != nil || !strings.Contains(stringValue(input["prompt"]), "背景透视发生变化") {
		t.Fatalf("camera preset missing from actual request: %+v %v", input, err)
	}
}

func TestDramaSceneSplitKeepsEveryOriginalSegmentBoundary(t *testing.T) {
	s, db, req := sceneSplitFixture(t)
	if err := db.Model(&model.DramaShot{}).Where("id = ?", "scene-outside").Update("scene", "卧室").Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.DramaShot{ID: "scene-after", ProjectID: "scene-project", EpisodeID: "scene-episode", Position: 3, SegmentIndex: 2, Scene: "院子", DurationMs: 2000}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.DramaSegment{ID: "scene-segment-2", ProjectID: "scene-project", EpisodeID: "scene-episode", SegmentIndex: 2, Revision: 1, PromptStatus: model.DramaMediaReady}).Error; err != nil {
		t.Fatal(err)
	}
	req.ShotIDs = append(req.ShotIDs, "scene-outside")
	req.TargetShotCount = 1
	if _, err := s.PreflightDramaSceneSplit("user", "scene-project", "scene-episode", req); err == nil {
		t.Fatal("a segment would be left empty")
	}
	req.TargetShotCount = 2
	result := sceneSplitComplete(t, s, db, req, sceneSplitShots(2))
	if _, err := s.AdoptDramaSceneSplit("user", "scene-project", "scene-episode", DramaSceneSplitAdoptRequest{ExpectedRevision: req.ExpectedRevision, EpisodeRevision: req.EpisodeRevision, TakeID: result.TakeID}); err != nil {
		t.Fatal(err)
	}
	shots, _ := s.repo.DramaShots("scene-episode")
	if len(shots) != 3 || shots[0].SegmentIndex != 0 || shots[1].SegmentIndex != 1 || shots[2].ID != "scene-after" || shots[2].SegmentIndex != 2 {
		t.Fatalf("original boundaries changed: %+v", shots)
	}
	segments, _ := s.repo.DramaSegments("scene-episode")
	if len(segments) != 3 || segments[0].ID != "scene-segment-0" || segments[1].ID != "scene-segment-1" || segments[2].Revision != 1 {
		t.Fatalf("segment identities or outside changed: %+v", segments)
	}
}

func TestDramaSceneSplitKeepsDialogueWithinEachOriginalSegment(t *testing.T) {
	for _, moveDialogue := range []bool{false, true} {
		t.Run(map[bool]string{false: "preserved", true: "moved"}[moveDialogue], func(t *testing.T) {
			s, db, req := sceneSplitFixture(t)
			for id, dialogue := range map[string]string{"scene-shot-1": "第一句。", "scene-shot-2": "第二句。", "scene-outside": "第三句。"} {
				if err := db.Model(&model.DramaShot{}).Where("id = ?", id).Updates(map[string]any{"scene": "卧室", "speaker": "秦子文", "dialogue": dialogue}).Error; err != nil {
					t.Fatal(err)
				}
			}
			req.ShotIDs, req.TargetShotCount = append(req.ShotIDs, "scene-outside"), 4
			before, _ := s.repo.DramaShots("scene-episode")
			dialogues := []string{"第一句。", "第二句。", "第三句。", ""}
			if moveDialogue {
				dialogues = []string{"第一句。", "", "第二句。", "第三句。"}
			}
			shots := sceneSplitShots(4)
			for index, dialogue := range dialogues {
				shots[index].Speaker, shots[index].Dialogue = "秦子文", dialogue
				if dialogue == "" {
					shots[index].Speaker = ""
				}
			}
			result := sceneSplitComplete(t, s, db, req, shots)
			task, _ := s.repo.Task(result.TaskID)
			if !strings.Contains(task.Prompt, "输出第1到2镜属于原第1段") || !strings.Contains(task.Prompt, "输出第3到4镜属于原第2段") {
				t.Fatal("confirmed segment allocation missing from actual model request")
			}
			_, err := s.AdoptDramaSceneSplit("user", "scene-project", "scene-episode", DramaSceneSplitAdoptRequest{ExpectedRevision: req.ExpectedRevision, EpisodeRevision: req.EpisodeRevision, TakeID: result.TakeID})
			if moveDialogue && err == nil {
				t.Fatal("adoption accepted dialogue moved across the original segment boundary")
			}
			if !moveDialogue && err != nil {
				t.Fatal(err)
			}
			after, _ := s.repo.DramaShots("scene-episode")
			for _, index := range []int{0, 1} {
				if dramaSceneSegmentDialogue(before, index) != dramaSceneSegmentDialogue(after, index) {
					t.Fatal("an original segment lost or received dialogue")
				}
			}
			if moveDialogue {
				var snapshots int64
				db.Model(&model.DramaSceneRevision{}).Count(&snapshots)
				if snapshots != 0 || len(after) != len(before) {
					t.Fatal("rejected adoption changed saved shots or history")
				}
			}
		})
	}
}

func TestDramaSceneSplitReindexKeepsOutsideMediaAndStoryboardsUsable(t *testing.T) {
	s, db, req := sceneSplitFixture(t)
	outside, err := s.repo.DramaShot("scene-project", "scene-outside")
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Create(&model.DramaShotMedia{ID: "outside-shot-media", ProjectID: "scene-project", EpisodeID: "scene-episode", ShotID: outside.ID, Kind: "image", Revision: 1, Status: model.DramaMediaReady, ResourceID: "outside-image", ScriptHash: dramaShotScriptHash(*outside), ConfigJSON: `{}`}).Error; err != nil {
		t.Fatal(err)
	}
	board, err := s.CreateDramaStoryboard("user", "scene-project", DramaStoryboardCreateRequest{ClientOperationID: "outside-board", ShotIDs: []string{outside.ID}, Rows: 2, Columns: 2, Config: DramaShotMediaConfig{Operation: "text_to_image"}})
	if err != nil {
		t.Fatal(err)
	}
	result := sceneSplitComplete(t, s, db, req, sceneSplitShots(3))
	if _, err := s.AdoptDramaSceneSplit("user", "scene-project", "scene-episode", DramaSceneSplitAdoptRequest{ExpectedRevision: req.ExpectedRevision, EpisodeRevision: req.EpisodeRevision, TakeID: result.TakeID}); err != nil {
		t.Fatal(err)
	}
	shifted, _ := s.repo.DramaShot("scene-project", outside.ID)
	if shifted.Position != outside.Position+1 {
		t.Fatal("outside shot was not reindexed")
	}
	media, err := s.DramaShotMedia("user", "scene-project", outside.ID, "image")
	if err != nil || media.Status != model.DramaMediaReady || media.ResourceID != "outside-image" {
		t.Fatalf("outside saved media became stale after reindex: %+v %v", media, err)
	}
	currentBoard, err := s.DramaStoryboard("user", "scene-project", board.ID)
	if err != nil || currentBoard.Status != "draft" {
		t.Fatalf("outside storyboard became stale after reindex: %+v %v", currentBoard, err)
	}
	if err := db.Model(&model.DramaShot{}).Where("id = ?", outside.ID).Update("action", "改为跑出院子").Error; err != nil {
		t.Fatal(err)
	}
	media, _ = s.DramaShotMedia("user", "scene-project", outside.ID, "image")
	currentBoard, _ = s.DramaStoryboard("user", "scene-project", board.ID)
	if media.Status != model.DramaMediaStale || currentBoard.Status != "stale" {
		t.Fatal("actual script changes no longer invalidate saved media and storyboards")
	}
}

func TestDramaSceneSplitGenericRetryRequiresFreshPreflight(t *testing.T) {
	s, db, req := sceneSplitFixture(t)
	result := sceneSplitComplete(t, s, db, req, sceneSplitShots(3))
	if err := db.Model(&model.Task{}).Where("id = ?", result.TaskID).Update("status", model.TaskStatusFailed).Error; err != nil {
		t.Fatal(err)
	}
	var before model.CreditAccount
	db.First(&before, "user_id = ?", "user")
	if _, err := s.RetryTask("user", result.TaskID); !isAppErrorStatus(err, 400) {
		t.Fatalf("generic retry bypassed scene preflight: %v", err)
	}
	var tasks int64
	db.Model(&model.Task{}).Where("project_id = ?", "scene-project").Count(&tasks)
	var after model.CreditAccount
	db.First(&after, "user_id = ?", "user")
	if tasks != 1 || before.AvailableMicrocredits != after.AvailableMicrocredits || before.ReservedMicrocredits != after.ReservedMicrocredits {
		t.Fatal("rejected generic retry created a task or changed the wallet")
	}
}
