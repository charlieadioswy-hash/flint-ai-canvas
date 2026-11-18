package app

import (
	"net/http"
	"reflect"
	"testing"

	"yingce/backend/internal/model"
)

func TestDramaShotVideoSummariesScopeAndAdoptedResources(t *testing.T) {
	s, db, view := shotMediaFixture(t)
	const user, project, episode = "user", "drama-project", "episode"
	for _, row := range []any{
		&model.DramaEpisode{ID: "other-episode", ProjectID: project, Number: 2},
		&model.DramaEpisode{ID: "foreign-episode", ProjectID: "foreign-project"},
		&model.DramaShot{ID: "earlier-shot", ProjectID: project, EpisodeID: episode, Position: 0},
		&model.DramaShot{ID: "other-segment", ProjectID: project, EpisodeID: episode, SegmentIndex: 1, Position: 2},
		&model.DramaShot{ID: "other-episode-shot", ProjectID: project, EpisodeID: "other-episode"},
		&model.Task{ID: "foreign-task", UserID: "other", ProjectID: project, Status: model.TaskStatusRunning},
		&model.DramaShotMedia{ID: "image-slot", ProjectID: project, EpisodeID: episode, ShotID: "real-shot", Kind: "image", ResourceID: "current-image", TaskID: "foreign-task"},
		&model.DramaShotMedia{ID: "out-of-segment", ProjectID: project, EpisodeID: episode, ShotID: "other-segment", Kind: "video", ResourceID: "other-video"},
		&model.DramaTake{ID: "historical-take", ProjectID: project, OwnerID: "real-shot", Kind: "shot_video", TaskID: "deleted-task", ResourceID: "old-video"},
	} {
		if err := db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	if err := db.Model(&model.DramaShotMedia{}).Where("id = ?", view.ID).Updates(map[string]any{"resource_id": "current-video", "status": "stale"}).Error; err != nil {
		t.Fatal(err)
	}
	got, err := s.DramaShotVideoSummaries(user, project, episode, 0)
	want := []DramaShotVideoSummary{{ShotID: "earlier-shot"}, {ShotID: "real-shot", ResourceID: "current-video", ImageResourceID: "current-image"}}
	if err != nil || !reflect.DeepEqual(got, want) {
		t.Fatalf("segment summaries = %+v, %v; want %+v", got, err, want)
	}
	if got, err := s.DramaShotVideoSummaries(user, project, episode, 9); err != nil || got == nil || len(got) != 0 {
		t.Fatalf("empty segment = %+v, %v", got, err)
	}
	if _, err := s.DramaShotVideoSummaries("other", project, episode, 0); !isAppErrorStatus(err, http.StatusNotFound) {
		t.Fatalf("foreign owner = %v", err)
	}
	if _, err := s.DramaShotVideoSummaries(user, project, "foreign-episode", 0); !isAppErrorStatus(err, http.StatusNotFound) {
		t.Fatalf("foreign episode = %v", err)
	}
	if _, err := s.DramaShotVideoSummaries(user, project, episode, -1); !isAppErrorStatus(err, http.StatusBadRequest) {
		t.Fatalf("invalid index = %v", err)
	}
}

func TestDramaShotVideoSummariesRecoversOnlyStillBoundResult(t *testing.T) {
	s, db, _ := shotMediaFixture(t)
	const user, project, episode, shot = "user", "drama-project", "episode", "real-shot"
	check := func(resourceID string, pending bool) {
		t.Helper()
		rows, err := s.DramaShotVideoSummaries(user, project, episode, 0)
		if err != nil || !reflect.DeepEqual(rows, []DramaShotVideoSummary{{ShotID: shot, ResourceID: resourceID, Pending: pending}}) {
			t.Fatalf("expected resource %q and pending %v; got %+v, %v", resourceID, pending, rows, err)
		}
	}
	markSucceededWithoutWriteback := func(taskID, resourceID string) {
		t.Helper()
		if err := db.Create(&model.Resource{ID: resourceID, UserID: user, Kind: "video", Status: model.ResourceStatusReady, MimeType: "video/mp4", DurationMs: 5000}).Error; err != nil {
			t.Fatal(err)
		}
		if err := db.Model(&model.Task{}).Where("id = ?", taskID).Updates(map[string]any{
			"status": model.TaskStatusSucceeded, "result_json": `{"mode":"video","video":{"resourceId":"` + resourceID + `"}}`,
		}).Error; err != nil {
			t.Fatal(err)
		}
	}
	first, err := s.ExecuteDramaShotMedia(user, project, shot, "video", shotMediaConfirmed(t, s, "summary-first"))
	if err != nil {
		t.Fatal(err)
	}
	check("", true)
	markSucceededWithoutWriteback(first.ID, "adopted-video")
	check("adopted-video", false)
	second, err := s.ExecuteDramaShotMedia(user, project, shot, "video", shotMediaConfirmed(t, s, "summary-second"))
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.DramaShot{}).Where("id = ?", shot).Update("action", "实际镜头改动").Error; err != nil {
		t.Fatal(err)
	}
	check("adopted-video", true)
	markSucceededWithoutWriteback(second.ID, "late-video")
	check("adopted-video", false)
	take, err := s.repo.DramaShotMediaTakeForTask(project, second.ID)
	if err != nil || take.ResourceID != "late-video" {
		t.Fatalf("late paid result was lost: %+v, %v", take, err)
	}
}

func TestDramaShotVideoSummariesStillShowsAdoptedResultsIfBackfillFails(t *testing.T) {
	s, db, view := shotMediaFixture(t)
	const user, project, episode, shot = "user", "drama-project", "episode", "real-shot"
	task, err := s.ExecuteDramaShotMedia(user, project, shot, "video", shotMediaConfirmed(t, s, "unreadable-result"))
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.Task{}).Where("id = ?", task.ID).Updates(map[string]any{
		"status": model.TaskStatusSucceeded, "result_json": `{"mode":"video","video":{"resourceId":"missing-resource"}}`,
	}).Error; err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.DramaShotMedia{}).Where("id = ?", view.ID).Update("resource_id", "previous-video").Error; err != nil {
		t.Fatal(err)
	}
	for _, row := range []any{
		&model.DramaShot{ID: "neighbor", ProjectID: project, EpisodeID: episode, Position: 2},
		&model.DramaShotMedia{ID: "neighbor-video-slot", ProjectID: project, EpisodeID: episode, ShotID: "neighbor", Kind: "video", ResourceID: "neighbor-video"},
	} {
		if err := db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	rows, err := s.DramaShotVideoSummaries(user, project, episode, 0)
	want := []DramaShotVideoSummary{{ShotID: shot, ResourceID: "previous-video"}, {ShotID: "neighbor", ResourceID: "neighbor-video"}}
	if err != nil || !reflect.DeepEqual(rows, want) {
		t.Fatalf("adopted results after a failed backfill = %+v, %v; want %+v", rows, err, want)
	}
}
