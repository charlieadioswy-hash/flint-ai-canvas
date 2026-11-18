package app

import (
	"encoding/json"
	"strings"
	"testing"

	"gorm.io/gorm"
	"yingce/backend/internal/model"
)

const shotPromptWritten = `【00.00—03.00秒｜镜头一：近景·固定】
秦子文打开门。
秦子文：“我先开门。”
【03.00—08.00秒｜镜头二：中景·固定】
35mm中景，窗侧冷光，画面右侧是尚未拆封的纸箱。
03.00—05.00：秦子武（参考图2）缓缓侧身，右手指向窗外，衣袖随动作轻摆。
05.00—08.00：秦子武保持视线朝向窗外，轻声说：“风从这边进来。”
动作音：衣料摩擦、窗外风声。
【08.00—12.00秒｜镜头三：全景·跟】
秦子文转身离开窗边。
秦子文：“我们出去吧。”`

func shotPromptFixture(t *testing.T) (*Service, *gorm.DB, DramaShotMediaView) {
	t.Helper()
	s, db, saved := shotMediaFixture(t)
	for _, row := range []any{
		&model.DramaCast{ID: "prompt-brother", ProjectID: "drama-project", Kind: "character", Name: "秦子文", Appearance: "黑色短发，深灰外套", ImageResourceID: "ref-two", ImageStatus: model.DramaMediaReady},
		&model.DramaCast{ID: "prompt-hero", ProjectID: "drama-project", Kind: "character", Name: "秦子武", Appearance: "浅色衬衣，袖口挽起", ImageResourceID: "ref-one", ImageStatus: model.DramaMediaReady, VoiceInstructions: "轻柔青年声"},
		&model.DramaCast{ID: "prompt-scene", ProjectID: "drama-project", Kind: "scene", Name: "新房客厅", Appearance: "窗朝北，灰白墙面，墙边堆放未拆封纸箱"},
		&model.DramaShot{ID: "prompt-before", ProjectID: "drama-project", EpisodeID: "episode", Position: 0, SegmentIndex: 0, SegmentTitle: "兄弟初入新房", Scene: "新房客厅", CastIDsJSON: `["prompt-brother"]`, SceneCastID: "prompt-scene", ShotSize: "近景", Camera: "固定", Action: "秦子文打开门", Speaker: "秦子文", Dialogue: "我先开门。", DurationMs: 3000},
		&model.DramaShot{ID: "prompt-after", ProjectID: "drama-project", EpisodeID: "episode", Position: 2, SegmentIndex: 0, SegmentTitle: "兄弟初入新房", Scene: "新房客厅", CastIDsJSON: `["prompt-brother"]`, SceneCastID: "prompt-scene", ShotSize: "全景", Camera: "跟", Action: "秦子文转身离开窗边", Speaker: "秦子文", Dialogue: "我们出去吧。", DurationMs: 4000},
		&model.DramaSegment{ID: "prompt-segment", ProjectID: "drama-project", EpisodeID: "episode", SegmentIndex: 0, PromptStatus: model.DramaMediaReady, VideoPrompt: shotPromptWritten, ReferenceCastIDsJSON: `["prompt-brother","prompt-hero","prompt-scene"]`},
	} {
		if err := db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Model(&model.DramaShot{}).Where("id = ?", "real-shot").Updates(map[string]any{
		"segment_title": "兄弟初入新房", "scene": "新房客厅", "cast_ids_json": `["prompt-hero"]`, "scene_cast_id": "prompt-scene", "shot_size": "中景", "camera": "固定", "image_prompt": "秦子武站在窗边，右手垂在身侧", "action": "秦子武缓缓侧身指向窗外", "speaker": "秦子武", "dialogue": "风从这边进来。",
	}).Error; err != nil {
		t.Fatal(err)
	}
	p, err := s.repo.DramaProduction("drama-project")
	if err != nil {
		t.Fatal(err)
	}
	episodeSettings := parseDramaSettings(p.SettingsJSON)
	episodeSettings.StyleName, episodeSettings.StylePrompt = "本集水墨", "水墨留白，柔和纸面质感"
	if err := db.Model(&model.DramaEpisode{}).Where("id = ?", "episode").Update("settings_json", encodeDramaSettings(episodeSettings)).Error; err != nil {
		t.Fatal(err)
	}
	saved = mustShotMedia(t, s)
	return s, db, saved
}

func TestDramaShotPromptUpgradesLegacyDefaultsWithEpisodeAndSegmentContext(t *testing.T) {
	for _, legacy := range []string{"", "人物推门走出房间"} {
		t.Run(legacy, func(t *testing.T) {
			s, db, saved := shotPromptFixture(t)
			config := saved.Config
			config.Prompt, config.PromptSourceHash = legacy, nil
			encoded, _ := json.Marshal(config)
			if err := db.Model(&model.DramaShotMedia{}).Where("id = ?", saved.ID).Update("config_json", string(encoded)).Error; err != nil {
				t.Fatal(err)
			}
			got := mustShotMedia(t, s)
			for _, want := range []string{"兄弟初入新房", "新房客厅", "灰白墙面", "浅色衬衣", "水墨留白", "秦子武站在窗边", "00.00—05.00秒", "衣袖随动作轻摆", "动作音：衣料摩擦、窗外风声"} {
				if !strings.Contains(got.Config.Prompt, want) {
					t.Fatalf("missing contextual detail %q in:\n%s", want, got.Config.Prompt)
				}
			}
			if got.Config.PromptSourceHash == nil || *got.Config.PromptSourceHash == "" || got.Revision != saved.Revision {
				t.Fatalf("default enrichment changed persistence or lacked source marker: %+v", got.Config)
			}
			currentBlock := strings.Split(got.Config.Prompt, "【00.00—05.00秒")[1]
			if strings.Contains(currentBlock, "我先开门") || strings.Contains(currentBlock, "我们出去吧") || strings.Contains(currentBlock, "03.00—05.00：") {
				t.Fatalf("current block leaked another shot or retained segment timecode:\n%s", currentBlock)
			}
			for _, entity := range []any{&model.Task{}, &model.BillingOrder{}, &model.DramaTake{}} {
				var count int64
				if err := db.Model(entity).Count(&count).Error; err != nil || count != 0 {
					t.Fatalf("reading enriched defaults created %T: %d, %v", entity, count, err)
				}
			}
		})
	}
}

func TestDramaShotPromptPreservesManualDraftAndDeliberateClear(t *testing.T) {
	s, db, saved := shotPromptFixture(t)
	for _, manual := range []string{"手工调整：镜头只拍手指和窗外倒影。", ""} {
		draft := saved.Config
		draft.Prompt = manual
		updated, err := s.SaveDramaShotMedia("user", "drama-project", "real-shot", "video", DramaShotMediaSaveRequest{ExpectedRevision: &saved.Revision, Config: draft})
		if err != nil {
			t.Fatal(err)
		}
		if err := db.Model(&model.DramaSegment{}).Where("id = ?", "prompt-segment").Update("video_prompt", strings.ReplaceAll(shotPromptWritten, "窗侧冷光", "夕阳暖光")).Error; err != nil {
			t.Fatal(err)
		}
		for repeat := 0; repeat < 2; repeat++ {
			got := mustShotMedia(t, s)
			if got.Config.Prompt != manual || got.Config.PromptSourceHash == nil || *got.Config.PromptSourceHash != "" {
				t.Fatalf("manual text changed on read %d: %+v", repeat, got.Config)
			}
		}
		saved = updated
	}
}

func TestDramaShotPromptReferenceNumbersFollowActualAttachments(t *testing.T) {
	s, _, saved := shotPromptFixture(t)
	draft := saved.Config
	draft.Operation, draft.FirstFrameResourceID, draft.LastFrameResourceID = "reference_to_video", "", ""
	draft.ReferenceResourceIDs = []string{"ref-one", "ref-two"}
	first, err := s.QuoteDramaShotMedia("user", "drama-project", "real-shot", "video", DramaShotMediaSaveRequest{ExpectedRevision: &saved.Revision, Config: draft})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(first.Config.Prompt, "秦子武（参考图1）缓缓侧身") || strings.Contains(first.Config.Prompt, "秦子武（参考图2）缓缓侧身") {
		t.Fatalf("segment reference not mapped to actual first attachment:\n%s", first.Config.Prompt)
	}
	draft.ReferenceResourceIDs = []string{"ref-two", "ref-one"}
	second, err := s.QuoteDramaShotMedia("user", "drama-project", "real-shot", "video", DramaShotMediaSaveRequest{ExpectedRevision: &saved.Revision, Config: draft})
	if err != nil || !strings.Contains(second.Config.Prompt, "秦子武（参考图2）缓缓侧身") || second.ScopeHash == first.ScopeHash {
		t.Fatalf("reordered attachments retained old identity: %+v, %v", second, err)
	}
}

func TestDramaShotPromptResolvesManualSubjectAgainstShotAttachments(t *testing.T) {
	s, db, saved := shotPromptFixture(t)
	manual := strings.Replace(shotPromptWritten, "秦子武（参考图2）缓缓侧身", "@[segment-cast:prompt-hero]缓缓侧身", 1)
	if err := db.Model(&model.DramaSegment{}).Where("id = ?", "prompt-segment").Updates(map[string]any{
		"video_prompt_override": manual, "reference_cast_ids_json": `["prompt-brother"]`,
	}).Error; err != nil {
		t.Fatal(err)
	}
	for _, tt := range []struct {
		name, operation, firstFrame, expected string
		images                                []string
	}{
		{name: "numbered reference", operation: "reference_to_video", images: []string{"ref-two", "ref-one"}, expected: "参考图2缓缓侧身"},
		{name: "pinned first frame", operation: "image_to_video", firstFrame: "ref-one", expected: "秦子武缓缓侧身"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			draft := saved.Config
			draft.Operation, draft.FirstFrameResourceID, draft.LastFrameResourceID = tt.operation, tt.firstFrame, ""
			draft.ReferenceResourceIDs = tt.images
			draft.ReferenceSubjects = map[string]string{"ref-one": "prompt-hero"}
			got, err := s.QuoteDramaShotMedia("user", "drama-project", "real-shot", "video", DramaShotMediaSaveRequest{ExpectedRevision: &saved.Revision, Config: draft})
			if err != nil {
				t.Fatal(err)
			}
			_, body, found := strings.Cut(got.Config.Prompt, "【00.00—05.00秒")
			if !found || !strings.Contains(body, tt.expected) || !strings.Contains(body, "衣袖随动作轻摆") || strings.Contains(body, "segment-cast:") {
				t.Fatalf("written shot body did not keep its subject binding:\n%s", got.Config.Prompt)
			}
		})
	}
}

func TestDramaShotPromptRefreshesAutomaticDraftAndKeepsQuoteSaveScopeStable(t *testing.T) {
	s, db, saved := shotPromptFixture(t)
	draft := saved.Config
	draft.Seconds = 6
	preview, err := s.QuoteDramaShotMedia("user", "drama-project", "real-shot", "video", DramaShotMediaSaveRequest{ExpectedRevision: &saved.Revision, Config: draft})
	if err != nil || !preview.Ready || !strings.Contains(preview.Config.Prompt, "00.00—06.00秒") || strings.Contains(preview.Config.Prompt, "衣袖随动作轻摆") {
		t.Fatalf("changed duration did not rebuild safely: %+v, %v", preview, err)
	}
	updated, err := s.SaveDramaShotMedia("user", "drama-project", "real-shot", "video", DramaShotMediaSaveRequest{ExpectedRevision: &saved.Revision, Config: draft})
	if err != nil {
		t.Fatal(err)
	}
	fresh, err := s.PreflightDramaShotMedia("user", "drama-project", "real-shot", "video", DramaShotMediaActionRequest{ExpectedRevision: &updated.Revision})
	if err != nil || fresh.ScopeHash != preview.ScopeHash || fresh.Config.Prompt != updated.Config.Prompt || fresh.Config.Prompt != preview.Config.Prompt {
		t.Fatalf("quote/save/preflight mismatch: %+v, %v", fresh, err)
	}
	if err := db.Model(&model.DramaShot{}).Where("id = ?", "real-shot").Update("action", "秦子武扶住窗框，指尖轻敲窗沿").Error; err != nil {
		t.Fatal(err)
	}
	got := mustShotMedia(t, s)
	if !strings.Contains(got.Config.Prompt, "指尖轻敲窗沿") || got.Config.Prompt == updated.Config.Prompt {
		t.Fatalf("automatic draft did not follow current script:\n%s", got.Config.Prompt)
	}
}

func TestDramaShotPromptCameraIntentKeepsAutomaticRefresh(t *testing.T) {
	s, db, _ := shotPromptFixture(t)
	const user, project, shot = "user", "drama-project", "real-shot"
	if err := db.Model(&model.DramaShot{}).Where("id = ?", shot).Update("camera", "推").Error; err != nil {
		t.Fatal(err)
	}
	written := strings.Replace(shotPromptWritten, "35mm中景，窗侧冷光", "35mm中景，缓慢推近，窗侧冷光", 1)
	if err := db.Model(&model.DramaSegment{}).Where("id = ?", "prompt-segment").Update("video_prompt", written).Error; err != nil {
		t.Fatal(err)
	}
	current := mustShotMedia(t, s)
	draft := current.Config
	if draft.PromptSourceHash == nil || *draft.PromptSourceHash == "" || !strings.Contains(draft.Prompt, "缓慢推近") {
		t.Fatalf("expected automatic prompt with the original movement: %+v", draft)
	}
	draft.CameraIntent = "无运镜"
	updated, err := s.SaveDramaShotMedia(user, project, shot, "video", DramaShotMediaSaveRequest{ExpectedRevision: &current.Revision, Config: draft})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Config.PromptSourceHash == nil || *updated.Config.PromptSourceHash == "" || updated.Config.CameraIntent != "无运镜" || !strings.Contains(updated.Config.Prompt, "中景·无运镜】") || strings.Contains(updated.Config.Prompt, "缓慢推近") || !strings.Contains(updated.Config.Prompt, "衣袖随动作轻摆") {
		t.Fatalf("override did not refresh the automatic prompt and preserve the written action: %+v", updated.Config)
	}
	draft = updated.Config
	draft.Seconds = 6
	rebuilt, err := s.SaveDramaShotMedia(user, project, shot, "video", DramaShotMediaSaveRequest{ExpectedRevision: &updated.Revision, Config: draft})
	if err != nil || rebuilt.Config.CameraIntent != "无运镜" || !strings.Contains(rebuilt.Config.Prompt, "00.00—06.00秒") {
		t.Fatalf("duration change did not rebuild the prompt with the saved camera: %+v, %v", rebuilt.Config, err)
	}
}

func TestDramaShotPromptSegmentRevisionInvalidatesExecutionWithoutCharge(t *testing.T) {
	s, db, saved := shotPromptFixture(t)
	before, err := s.PreflightDramaShotMedia("user", "drama-project", "real-shot", "video", DramaShotMediaActionRequest{ExpectedRevision: &saved.Revision})
	if err != nil || !before.Ready {
		t.Fatalf("preflight: %+v, %v", before, err)
	}
	if err := db.Model(&model.DramaSegment{}).Where("id = ?", "prompt-segment").Update("video_prompt", strings.ReplaceAll(shotPromptWritten, "窗侧冷光", "夕阳暖光")).Error; err != nil {
		t.Fatal(err)
	}
	after, err := s.PreflightDramaShotMedia("user", "drama-project", "real-shot", "video", DramaShotMediaActionRequest{ExpectedRevision: &saved.Revision})
	if err != nil || !after.Ready || after.ScopeHash == before.ScopeHash || after.ConfirmationToken == before.ConfirmationToken || !strings.Contains(after.Config.Prompt, "夕阳暖光") {
		t.Fatalf("changed segment did not invalidate effective prompt: %+v, %v", after, err)
	}
	_, err = s.ExecuteDramaShotMedia("user", "drama-project", "real-shot", "video", DramaShotMediaActionRequest{ExpectedRevision: &before.Revision, BaseRevision: &before.BaseRevision, ConfirmationToken: before.ConfirmationToken, ClientOperationID: "old-shot-context"})
	if !isAppErrorStatus(err, 409) {
		t.Fatalf("old context execution accepted: %v", err)
	}
	for _, entity := range []any{&model.Task{}, &model.BillingOrder{}, &model.DramaTake{}} {
		var count int64
		if err := db.Model(entity).Count(&count).Error; err != nil || count != 0 {
			t.Fatalf("rejected old context created %T: %d, %v", entity, count, err)
		}
	}
	var wallet model.CreditAccount
	if err := db.First(&wallet, "user_id = ?", "user").Error; err != nil || wallet.AvailableMicrocredits != 10000 || wallet.ReservedMicrocredits != 0 {
		t.Fatalf("rejected old context charged credits: %+v, %v", wallet, err)
	}
}

func TestDramaShotPromptChangedContextKeepsLateResultInHistory(t *testing.T) {
	s, db, _ := shotPromptFixture(t)
	task, err := s.ExecuteDramaShotMedia("user", "drama-project", "real-shot", "video", shotMediaConfirmed(t, s, "shot-context-in-flight"))
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.DramaSegment{}).Where("id = ?", "prompt-segment").Update("video_prompt", strings.ReplaceAll(shotPromptWritten, "窗侧冷光", "夕阳暖光")).Error; err != nil {
		t.Fatal(err)
	}
	completeShotMedia(t, s, db, task.ID, "old-context-video")
	got := mustShotMedia(t, s)
	if got.ResourceID != "" || got.Status != "stale" || len(got.Takes) != 1 || got.Takes[0].ResourceID != "old-context-video" {
		t.Fatalf("changed segment context auto-adopted old result: %+v", got)
	}
	adopted, err := s.AdoptDramaShotMedia("user", "drama-project", "real-shot", "video", DramaShotMediaAdoptRequest{ExpectedRevision: &got.Revision, TakeID: got.Takes[0].ID})
	if err != nil || adopted.ResourceID != "old-context-video" {
		t.Fatalf("explicit adoption of preserved result failed: %+v, %v", adopted, err)
	}
}

func TestDramaShotPromptBlockedQuotePreservesClearedDraft(t *testing.T) {
	s, _, saved := shotPromptFixture(t)
	draft := saved.Config
	draft.Prompt = ""
	preview, err := s.QuoteDramaShotMedia("user", "drama-project", "real-shot", "video", DramaShotMediaSaveRequest{ExpectedRevision: &saved.Revision, Config: draft})
	if err != nil || preview.Ready || preview.Config.Prompt != "" || preview.Config.PromptSourceHash == nil || *preview.Config.PromptSourceHash != "" {
		t.Fatalf("blocked quote restored automatic text: %+v, %v", preview, err)
	}
	if got := mustShotMedia(t, s); got.Config.Prompt != saved.Config.Prompt {
		t.Fatal("blocked quote saved cleared draft")
	}
}

func TestDramaShotPromptUsesManualSegmentOverrideWhileQueued(t *testing.T) {
	s, db, _ := shotPromptFixture(t)
	manual := strings.ReplaceAll(shotPromptWritten, "窗侧冷光", "窗侧蓝光")
	if err := db.Model(&model.DramaSegment{}).Where("id = ?", "prompt-segment").Updates(map[string]any{"video_prompt_override": manual, "prompt_status": "queued"}).Error; err != nil {
		t.Fatal(err)
	}
	got := mustShotMedia(t, s)
	if !strings.Contains(got.Config.Prompt, "窗侧蓝光") || strings.Contains(got.Config.Prompt, "窗侧冷光") {
		t.Fatalf("valid manual segment override ignored:\n%s", got.Config.Prompt)
	}
}

func TestDramaShotPromptIgnoresStaleSegmentDraft(t *testing.T) {
	s, db, _ := shotPromptFixture(t)
	if err := db.Model(&model.DramaSegment{}).Where("id = ?", "prompt-segment").Update("prompt_status", "stale").Error; err != nil {
		t.Fatal(err)
	}
	got := mustShotMedia(t, s)
	if strings.Contains(got.Config.Prompt, "衣袖随动作轻摆") || !strings.Contains(got.Config.Prompt, "秦子武缓缓侧身指向窗外") || !strings.Contains(got.Config.Prompt, "风从这边进来。") {
		t.Fatalf("stale written segment replaced current structured script:\n%s", got.Config.Prompt)
	}
}
