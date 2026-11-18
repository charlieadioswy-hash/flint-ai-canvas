package app

import (
	"testing"

	"yingce/backend/internal/model"
)

func TestDramaCastDeleteDetachesOffscreenAudioReferences(t *testing.T) {
	fixture := newDramaGuideRevisionFixture(t, model.DramaGuideStory)
	svc, fake := fixture.svc, fixture.fake
	projectID := fixture.summary.Project.ID
	video := dramaVideoFixture()
	video.References.MaxAudios = 1
	setDramaVideoCapability(t, svc, fake, video)
	sample := fake.resource("usr-drama", "audio", "audio/wav")
	if err := fake.db.Model(&model.DramaCast{}).Where("id = ?", fixture.cast.ID).Update("voice_sample_resource_id", sample).Error; err != nil {
		t.Fatal(err)
	}
	// The fixture's shot has no cast references: this character is only a voice reference.
	selected := []string{fixture.cast.ID}
	revision := fixture.summary.Production.Revision
	if err := svc.UpdateDramaSegment("usr-drama", projectID, fixture.shot.EpisodeID, 0, UpdateDramaSegmentRequest{ExpectedRevision: &revision, AudioCastIDs: &selected}); err != nil {
		t.Fatal(err)
	}
	revision++
	if err := svc.DeleteDramaCast("usr-drama", projectID, fixture.cast.ID, reviewedDramaCastDeletion(t, svc, projectID, fixture.cast.ID)); err != nil {
		t.Fatalf("audio-only reference must be detached: %v", err)
	}
	if _, err := svc.repo.DramaCast(projectID, fixture.cast.ID); err == nil {
		t.Fatal("voice character still exists")
	}
	production, err := svc.repo.DramaProduction(projectID)
	if err != nil || production.Revision != revision+1 {
		t.Fatalf("deletion did not advance guide revision: %+v %v", production, err)
	}
	segments, err := svc.repo.DramaSegments(fixture.shot.EpisodeID)
	if err != nil || len(segments) != 1 || segments[0].AudioCastIDsJSON != "[]" {
		t.Fatalf("explicit audio reference was not cleared: %+v %v", segments, err)
	}
}
