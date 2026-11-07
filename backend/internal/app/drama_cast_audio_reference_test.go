package app

import (
	"strings"
	"testing"

	"yingce/backend/internal/model"
)

func TestDramaCastDeleteProtectsOffscreenAudioReferences(t *testing.T) {
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
	err := svc.DeleteDramaCast("usr-drama", projectID, fixture.cast.ID, DeleteDramaCastRequest{ExpectedRevision: &revision})
	requireGuideConflict(t, err)
	if !strings.Contains(err.Error(), "剧情段") {
		t.Fatalf("audio-only reference should block deletion as a segment reference: %v", err)
	}
	if _, err := svc.repo.DramaCast(projectID, fixture.cast.ID); err != nil {
		t.Fatalf("rejected deletion must preserve the voice character: %v", err)
	}
	production, err := svc.repo.DramaProduction(projectID)
	if err != nil || production.Revision != revision || production.GuideStep != model.DramaGuideStory {
		t.Fatalf("rejected deletion changed guide state: %+v %v", production, err)
	}
	segments, err := svc.repo.DramaSegments(fixture.shot.EpisodeID)
	if err != nil || len(segments) != 1 || segments[0].AudioCastIDsJSON != encodeStringList(selected) {
		t.Fatalf("rejected deletion must preserve the audio reference: %+v %v", segments, err)
	}
	// Removing the audio reference releases the deletion protection.
	empty := []string{}
	if err := svc.UpdateDramaSegment("usr-drama", projectID, fixture.shot.EpisodeID, 0, UpdateDramaSegmentRequest{ExpectedRevision: &revision, AudioCastIDs: &empty}); err != nil {
		t.Fatal(err)
	}
	revision++
	if err := svc.DeleteDramaCast("usr-drama", projectID, fixture.cast.ID, DeleteDramaCastRequest{ExpectedRevision: &revision}); err != nil {
		t.Fatalf("character without live references should be deletable: %v", err)
	}
}
