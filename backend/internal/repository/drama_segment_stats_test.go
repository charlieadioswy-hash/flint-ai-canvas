package repository

import (
	"testing"

	"yingce/backend/internal/model"

	"gorm.io/driver/sqlite"
	"gorm.io/gorm"
)

func TestDramaSegmentStatsMixedFailuresRemainDisjoint(t *testing.T) {
	db, err := gorm.Open(sqlite.Open("file:"+t.Name()+"?mode=memory&cache=shared"), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.AutoMigrate(&model.DramaSegment{}); err != nil {
		t.Fatal(err)
	}
	sqlDB, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })

	segments := []model.DramaSegment{
		{ID: "ready", ProjectID: "project-1", EpisodeID: "episode-1", SegmentIndex: 0, PromptStatus: "ready"},
		{ID: "custom", ProjectID: "project-1", EpisodeID: "episode-1", SegmentIndex: 1, PromptStatus: "stale", VideoPromptOverride: "用户确认的提示词"},
		{ID: "prompt-failed", ProjectID: "project-1", EpisodeID: "episode-1", SegmentIndex: 2, PromptStatus: "failed"},
		{ID: "video-failed", ProjectID: "project-1", EpisodeID: "episode-1", SegmentIndex: 3, PromptStatus: "ready", VideoStatus: "failed", VideoResourceID: "saved-video"},
		{ID: "both-failed", ProjectID: "project-1", EpisodeID: "episode-1", SegmentIndex: 4, PromptStatus: "failed", VideoStatus: "failed", VideoPromptOverride: "保留的手动提示词"},
		{ID: "writing", ProjectID: "project-1", EpisodeID: "episode-1", SegmentIndex: 5, PromptStatus: "running"},
		{ID: "stale", ProjectID: "project-1", EpisodeID: "episode-1", SegmentIndex: 6, PromptStatus: "stale"},
		{ID: "video-ready", ProjectID: "project-1", EpisodeID: "episode-1", SegmentIndex: 7, PromptStatus: "ready", VideoStatus: "ready", VideoResourceID: "ready-video"},
		{ID: "custom-video-failed", ProjectID: "project-1", EpisodeID: "episode-1", SegmentIndex: 8, PromptStatus: "stale", VideoStatus: "failed", VideoPromptOverride: "另一段手动提示词"},
		{ID: "other-episode", ProjectID: "project-1", EpisodeID: "episode-2", SegmentIndex: 0, PromptStatus: "ready"},
		{ID: "other-project", ProjectID: "project-2", EpisodeID: "episode-3", SegmentIndex: 0, PromptStatus: "ready"},
	}
	if err := db.Create(&segments).Error; err != nil {
		t.Fatal(err)
	}

	repo := &Repository{db: db}
	stats, err := repo.DramaSegmentStats("project-1")
	if err != nil {
		t.Fatal(err)
	}
	if len(stats) != 2 {
		t.Fatalf("stats must contain only this project's two episodes: %+v", stats)
	}
	want := DramaSegmentStat{EpisodeID: "episode-1", Total: 9, PromptReady: 6, PromptSucceeded: 3, VideoReady: 1, VideoGenerated: 2, Failed: 4}
	if got := stats["episode-1"]; got != want {
		t.Fatalf("mixed prompt/video failures must count each failed segment once and exclude it from success: got %+v, want %+v", got, want)
	}
	want = DramaSegmentStat{EpisodeID: "episode-2", Total: 1, PromptReady: 1, PromptSucceeded: 1}
	if got := stats["episode-2"]; got != want {
		t.Fatalf("episode counts must remain separate: got %+v, want %+v", got, want)
	}
	empty, err := repo.DramaSegmentStats("project-empty")
	if err != nil {
		t.Fatal(err)
	}
	if len(empty) != 0 {
		t.Fatalf("project without segments must not inherit another project's counts: %+v", empty)
	}
}
