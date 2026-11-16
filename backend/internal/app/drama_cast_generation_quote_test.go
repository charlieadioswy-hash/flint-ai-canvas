package app

import "testing"

func TestDramaCastImageQuoteTreatsMissingAndEmptyReferencesAsSameScope(t *testing.T) {
	svc, fake, projectID, detail := dramaStudioFixture(t)
	seedDramaStudioBatchImagePrice(t, fake)
	casts, err := svc.repo.DramaCasts(projectID)
	if err != nil {
		t.Fatal(err)
	}
	cast := casts[0]
	if err := svc.repo.UpdateDramaCastFields(cast.ID, map[string]any{"image_options_json": ""}); err != nil {
		t.Fatal(err)
	}
	stored, err := svc.repo.DramaCast(projectID, cast.ID)
	if err != nil {
		t.Fatal(err)
	}
	p, err := svc.repo.DramaProduction(projectID)
	if err != nil {
		t.Fatal(err)
	}
	// The editor expands absent reference groups to empty arrays before quoting.
	options := DramaCastImageOptions{SubjectReferenceIDs: []string{}, StyleReferenceIDs: []string{}}
	draft := DramaStudioCastDraft{Name: &stored.Name, Appearance: &stored.Appearance, ImagePrompt: &stored.ImagePrompt, ImageStyleID: &stored.ImageStyleID, ImageStyleName: &stored.ImageStyleName, ImageStylePrompt: &stored.ImageStylePrompt, ImageOptions: &options}
	req := DramaStudioBatchRequest{Action: "cast_image", TargetIDs: []string{cast.ID}, EpisodeID: detail.Episode.ID, Regenerate: true, CastDrafts: map[string]DramaStudioCastDraft{cast.ID: draft}}
	quoted, err := svc.PreflightDramaStudioBatch("usr-drama", projectID, req)
	if err != nil || !quoted.Ready || !quoted.Priced || quoted.ScopeHash == "" {
		t.Fatalf("editor draft quote: %+v %v", quoted, err)
	}
	// Clicking generate rechecks persisted data and includes the restyle choice.
	req.CastDrafts, req.RestyleSegments = nil, true
	fresh, err := svc.PreflightDramaStudioBatch("usr-drama", projectID, req)
	if err != nil || !fresh.Ready || fresh.ScopeHash != quoted.ScopeHash || fresh.AmountMicrocredits != quoted.AmountMicrocredits || fresh.ConfirmationToken == quoted.ConfirmationToken {
		t.Fatalf("equivalent empty references must preserve scope and refresh execution token: draft=%+v stored=%+v %v", quoted, fresh, err)
	}
	if _, err := svc.UpdateDramaCast("usr-drama", projectID, cast.ID, UpdateDramaCastRequest{EpisodeID: detail.Episode.ID, ExpectedRevision: &p.Revision, ExpectedCastRevision: &stored.Revision, ImageOptions: &options}); err != nil {
		t.Fatal(err)
	}
	saved, err := svc.PreflightDramaStudioBatch("usr-drama", projectID, req)
	if err != nil || !saved.Ready || saved.ScopeHash != quoted.ScopeHash || saved.AmountMicrocredits != quoted.AmountMicrocredits || saved.ConfirmationToken == fresh.ConfirmationToken {
		t.Fatalf("saving equivalent references must preserve scope across revision changes: draft=%+v saved=%+v %v", quoted, saved, err)
	}
	reference := fake.resource("usr-drama", "image", "image/png")
	options.SubjectReferenceIDs = []string{reference}
	req.CastDrafts = map[string]DramaStudioCastDraft{cast.ID: {ImageOptions: &options}}
	changed, err := svc.PreflightDramaStudioBatch("usr-drama", projectID, req)
	if err != nil || !changed.Ready || changed.ScopeHash == quoted.ScopeHash || changed.AmountMicrocredits != quoted.AmountMicrocredits {
		t.Fatalf("a new reference must change scope even at the same price: before=%+v changed=%+v %v", quoted, changed, err)
	}
}
