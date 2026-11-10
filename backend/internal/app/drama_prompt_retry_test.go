package app

import (
	"testing"

	"yingce/backend/internal/model"
)

func TestDramaGuidePromptRetriesAreIndependent(t *testing.T) {
	svc, fake := newDramaTestService(t)
	video := dramaVideoFixture()
	video.Duration.Values = []int{5}
	setDramaVideoCapability(t, svc, fake, video)
	guide := createGuidedDrama(t, svc, DramaChapterInput{Title: "第一集", Text: "少年在雨夜踏进旧车站。"})
	projectID := guide.Project.ID
	confirmGuide(t, svc, guide)
	runDramaTicks(t, svc, projectID, 8)
	confirmGuide(t, svc, guideSummary(t, svc, projectID))
	runDramaTicks(t, svc, projectID, 20)
	guide = guideSummary(t, svc, projectID)
	episodeID := guide.Episodes[0].ID
	segments, err := svc.repo.DramaSegments(episodeID)
	if err != nil || len(segments) < 2 || !guide.Guide.CanConfirm {
		t.Fatalf("expected completed text guide: %+v %+v %v", guide.Guide, segments, err)
	}
	for _, segment := range segments[:2] {
		if err := fake.db.Model(&model.DramaSegment{}).Where("id = ?", segment.ID).Updates(map[string]any{"prompt_status": model.DramaMediaFailed, "prompt_error": "模拟撰写失败"}).Error; err != nil {
			t.Fatal(err)
		}
	}
	custom := "保留用户手动填写的版本"
	if err := fake.db.Model(&model.DramaSegment{}).Where("id = ?", segments[0].ID).Update("video_prompt_override", custom).Error; err != nil {
		t.Fatal(err)
	}
	beforeCalls := fake.byKind[model.DramaJobSegmentPrompt]
	// 先让后一段运行，再重试前一段，保证不会连带作废已提交的后一段任务。
	queued, err := svc.RequestDramaSegmentPrompts("usr-drama", projectID, episodeID, GenerateDramaSegmentsRequest{Segments: []int{segments[1].SegmentIndex}})
	if err != nil || queued["queued"] != 1 {
		t.Fatalf("first retry: %+v %v", queued, err)
	}
	runDramaTicks(t, svc, projectID, 1)
	running, err := svc.repo.DramaSegment(projectID, segments[1].ID)
	if err != nil || running.PromptStatus != model.DramaMediaRunning {
		t.Fatalf("first retry should be in flight: %+v %v", running, err)
	}
	revision := guideSummary(t, svc, projectID).Production.Revision
	queued, err = svc.RequestDramaSegmentPrompts("usr-drama", projectID, episodeID, GenerateDramaSegmentsRequest{Segments: []int{segments[1].SegmentIndex}})
	if err != nil || queued["queued"] != 0 || guideSummary(t, svc, projectID).Production.Revision != revision {
		t.Fatalf("same in-flight segment must be a no-op: %+v %v", queued, err)
	}
	queued, err = svc.RequestDramaSegmentPrompts("usr-drama", projectID, episodeID, GenerateDramaSegmentsRequest{Segments: []int{segments[0].SegmentIndex, segments[0].SegmentIndex}})
	if err != nil || queued["queued"] != 1 {
		t.Fatalf("another failed segment should be accepted once: %+v %v", queued, err)
	}
	current, err := svc.repo.DramaSegment(projectID, running.ID)
	if err != nil || current.Revision != running.Revision || current.PromptStatus != model.DramaMediaRunning {
		t.Fatalf("independent retry must preserve in-flight segment: %+v %v", current, err)
	}
	latest := guideSummary(t, svc, projectID)
	if latest.Production.Revision != revision+1 || latest.Guide.CanConfirm {
		t.Fatalf("accepted retry must invalidate old proposals and block confirmation: %+v", latest)
	}
	camera := "新的机位"
	shots, err := svc.repo.DramaShots(episodeID)
	if err != nil || len(shots) == 0 {
		t.Fatalf("missing original shots: %+v %v", shots, err)
	}
	_, err = svc.UpdateDramaShot("usr-drama", projectID, shots[0].ID, UpdateDramaShotRequest{ExpectedRevision: &latest.Production.Revision, Camera: &camera})
	requireGuideConflict(t, err)
	_, err = svc.ConfirmDramaGuide("usr-drama", projectID, ConfirmDramaGuideRequest{ExpectedStep: model.DramaGuideStory, ExpectedRevision: latest.Production.Revision})
	if err == nil {
		t.Fatal("confirmation must remain blocked while prompts are in flight")
	}
	runDramaTicks(t, svc, projectID, 6)
	finished := guideSummary(t, svc, projectID)
	if !finished.Guide.CanConfirm || fake.byKind[model.DramaJobSegmentPrompt] != beforeCalls+2 {
		t.Fatalf("each segment should finish exactly once: %+v %v", finished.Guide, fake.byKind)
	}
	first, err := svc.repo.DramaSegment(projectID, segments[0].ID)
	if err != nil || first.VideoPromptOverride != custom || first.PromptError != "" || first.PromptStatus != model.DramaMediaReady {
		t.Fatalf("retry must preserve manual override and clear failure: %+v %v", first, err)
	}
	if fake.byKind["image"]+fake.byKind["video"]+fake.byKind["render"] != 0 {
		t.Fatalf("prompt retry must stay text-only: %v", fake.byKind)
	}
}

func TestDramaGuidePromptRetryPreservesOtherQueuedSegments(t *testing.T) {
	fixture := newDramaGuideRevisionFixture(t, model.DramaGuideStory)
	projectID, episodeID := fixture.summary.Project.ID, fixture.shot.EpisodeID
	if err := fixture.fake.db.Model(&model.DramaSegment{}).Where("id = ?", fixture.segment.ID).Update("prompt_status", model.DramaMediaFailed).Error; err != nil {
		t.Fatal(err)
	}
	other := model.DramaSegment{ID: newID(), ProjectID: projectID, EpisodeID: episodeID, SegmentIndex: 1, Revision: 7}
	job := model.DramaJob{ID: newID(), ProjectID: projectID, EpisodeID: episodeID, ShotID: other.ID, Kind: model.DramaJobSegmentPrompt, Status: model.DramaJobQueued}
	for _, row := range []any{&other, &job} {
		if err := fixture.fake.db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	queued, err := fixture.svc.RequestDramaSegmentPrompts("usr-drama", projectID, episodeID, GenerateDramaSegmentsRequest{Segments: []int{fixture.segment.SegmentIndex}})
	if err != nil || queued["queued"] != 1 {
		t.Fatalf("failed segment retry: %+v %v", queued, err)
	}
	current, err := fixture.svc.repo.DramaSegment(projectID, other.ID)
	if err != nil || current.Revision != other.Revision || current.PromptStatus != other.PromptStatus {
		t.Fatalf("retry must preserve other queued segment: %+v %v", current, err)
	}
	var currentJob model.DramaJob
	if err := fixture.fake.db.First(&currentJob, "id = ?", job.ID).Error; err != nil || currentJob.Status != model.DramaJobQueued {
		t.Fatalf("retry must not cancel other queued prompt: %+v %v", currentJob, err)
	}
}

func TestDramaGuidePromptRetryNoopAndStructuralGuards(t *testing.T) {
	for _, status := range []string{"", model.DramaMediaQueued, model.DramaMediaRunning} {
		t.Run("already-"+status, func(t *testing.T) {
			fixture := newDramaGuideRevisionFixture(t, model.DramaGuideStory)
			if err := fixture.fake.db.Model(&model.DramaSegment{}).Where("id = ?", fixture.segment.ID).Update("prompt_status", status).Error; err != nil {
				t.Fatal(err)
			}
			queued, err := fixture.svc.RequestDramaSegmentPrompts("usr-drama", fixture.summary.Project.ID, fixture.shot.EpisodeID, GenerateDramaSegmentsRequest{Segments: []int{0, 0}})
			if err != nil || queued["queued"] != 0 {
				t.Fatalf("pending segment should not be queued twice: %+v %v", queued, err)
			}
			production, _ := fixture.svc.repo.DramaProduction(fixture.summary.Project.ID)
			segment, _ := fixture.svc.repo.DramaSegment(fixture.summary.Project.ID, fixture.segment.ID)
			if production.Revision != fixture.summary.Production.Revision || segment.Revision != fixture.segment.Revision || segment.PromptStatus != status {
				t.Fatalf("no-op must not change revisions or status: %+v %+v", production, segment)
			}
		})
	}
	for _, kind := range []string{model.DramaJobBible, model.DramaJobPlan, model.DramaJobScript} {
		for _, status := range []string{model.DramaJobQueued, model.DramaJobRunning} {
			t.Run(kind+"-"+status, func(t *testing.T) {
				fixture := newDramaGuideRevisionFixture(t, model.DramaGuideStory)
				job := model.DramaJob{ID: newID(), ProjectID: fixture.summary.Project.ID, Kind: kind, Status: status}
				if err := fixture.fake.db.Create(&job).Error; err != nil {
					t.Fatal(err)
				}
				_, err := fixture.svc.RequestDramaSegmentPrompts("usr-drama", fixture.summary.Project.ID, fixture.shot.EpisodeID, GenerateDramaSegmentsRequest{Segments: []int{0}})
				requireGuideConflict(t, err)
				segment, _ := fixture.svc.repo.DramaSegment(fixture.summary.Project.ID, fixture.segment.ID)
				if segment.Revision != fixture.segment.Revision {
					t.Fatalf("structural task guard must keep the target unchanged: %+v", segment)
				}
			})
		}
	}
}
