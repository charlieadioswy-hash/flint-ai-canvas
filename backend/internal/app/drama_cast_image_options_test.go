package app

import (
	"encoding/json"
	"strings"
	"testing"

	"yingce/backend/internal/model"
)

func TestDramaCastImageOptionsSavePreflightAndWorkerAgree(t *testing.T) {
	svc, fake, projectID, _ := dramaStudioFixture(t)
	casts, _ := svc.repo.DramaCasts(projectID)
	cast := casts[0]
	subject := fake.resource("usr-drama", "image", "image/png")
	style := fake.resource("usr-drama", "image", "image/webp")
	p, _ := svc.repo.DramaProduction(projectID)
	options := DramaCastImageOptions{Model: DramaModelChoice{ChannelID: "another-channel", ModelKey: "asset-image"}, Ratio: "1:1", Resolution: "2k", SubjectReferenceIDs: []string{subject}, StyleReferenceIDs: []string{style}}
	updated, err := svc.UpdateDramaCastImageOptions("usr-drama", projectID, cast.ID, UpdateDramaCastImageOptionsRequest{ExpectedRevision: &p.Revision, ExpectedCastRevision: &cast.Revision, Options: options})
	if err != nil {
		t.Fatal(err)
	}
	if updated.ImageResourceID != cast.ImageResourceID || updated.ImageStatus != cast.ImageStatus || updated.ImagePrompt != cast.ImagePrompt {
		t.Fatal("saving options altered existing media or custom prompt")
	}
	after, _ := svc.repo.DramaProduction(projectID)
	if after.GuideStep != p.GuideStep || after.Revision != p.Revision+1 {
		t.Fatalf("unexpected stage/revision: %+v", after)
	}
	plan, err := svc.dramaCastImagePlanFor(svc.repo, "usr-drama", parseDramaSettings(after.SettingsJSON), updated)
	if err != nil || plan.Choice.ModelKey != "asset-image" || plan.Request.Size != "1:1" || plan.Intent.Operation != "image_to_image" || plan.Intent.Inputs["image"] != 2 {
		t.Fatalf("plan = %+v, %v", plan, err)
	}
	view, err := svc.PreflightDramaStudioAction("usr-drama", projectID, DramaStudioActionRequest{Action: "cast_image", TargetID: cast.ID})
	if err != nil || !view.Ready {
		t.Fatalf("preflight = %+v, %v", view, err)
	}
	if _, err := svc.ExecuteDramaStudioAction("usr-drama", projectID, confirmedDramaStudioRequest(view)); err != nil {
		t.Fatal(err)
	}
	runDramaTicks(t, svc, projectID, 8)
	var request *CreateTaskRequest
	for i := range fake.requests {
		if fake.requests[i].Type == "canvas_image" {
			request = &fake.requests[i]
		}
	}
	if request == nil || request.Model != options.Model.ModelKey {
		t.Fatalf("worker model = %+v", request)
	}
	config := request.Input["config"].(map[string]any)
	refs := request.Input["referenceImages"].([]any)
	if config["size"] != "1:1" || len(refs) != 2 || refs[0].(map[string]any)["storageKey"] != "resource:"+subject || refs[1].(map[string]any)["storageKey"] != "resource:"+style {
		t.Fatalf("worker inputs = %+v", request.Input)
	}
	if !strings.Contains(request.Prompt, "参考图1用于主体") || !strings.Contains(request.Prompt, "参考图2仅参考画风") {
		t.Fatalf("reference roles missing: %s", request.Prompt)
	}
	references, err := svc.repo.DramaResourceReferences("usr-drama", []string{subject, style})
	if err != nil || len(references) != 2 {
		t.Fatalf("reference protection = %+v %v", references, err)
	}
}

func TestDramaCastImageOptionsRejectInvalidAndStaleWrites(t *testing.T) {
	svc, fake, projectID, _ := dramaStudioFixture(t)
	casts, _ := svc.repo.DramaCasts(projectID)
	cast := casts[0]
	p, _ := svc.repo.DramaProduction(projectID)
	foreign := fake.resource("other-user", "image", "image/png")
	video := fake.resource("usr-drama", "video", "video/mp4")
	image := fake.resource("usr-drama", "image", "image/png")
	for _, options := range []DramaCastImageOptions{
		{Ratio: "7:19"}, {Resolution: "8k"},
		{Model: DramaModelChoice{ChannelID: "incomplete"}},
		{Model: DramaModelChoice{LogicalModelID: "logical", ChannelID: "ch", ModelKey: "image"}},
		{SubjectReferenceIDs: []string{foreign}}, {StyleReferenceIDs: []string{video}},
		{SubjectReferenceIDs: []string{image}, StyleReferenceIDs: []string{image}},
	} {
		if _, err := svc.UpdateDramaCastImageOptions("usr-drama", projectID, cast.ID, UpdateDramaCastImageOptionsRequest{ExpectedRevision: &p.Revision, ExpectedCastRevision: &cast.Revision, Options: options}); err == nil {
			t.Fatalf("invalid options accepted: %+v", options)
		}
	}
	if _, err := svc.UpdateDramaCastImageOptions("other-user", projectID, cast.ID, UpdateDramaCastImageOptionsRequest{ExpectedRevision: &p.Revision}); err == nil {
		t.Fatal("foreign project accepted")
	}
	if _, err := svc.UpdateDramaCastImageOptions("usr-drama", projectID, cast.ID, UpdateDramaCastImageOptionsRequest{}); err == nil {
		t.Fatal("missing revision accepted")
	}
	if _, err := svc.UpdateDramaCastImageOptions("usr-drama", projectID, cast.ID, UpdateDramaCastImageOptionsRequest{ExpectedRevision: &p.Revision, ExpectedCastRevision: &cast.Revision}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.UpdateDramaCastImageOptions("usr-drama", projectID, cast.ID, UpdateDramaCastImageOptionsRequest{ExpectedRevision: &p.Revision, ExpectedCastRevision: &cast.Revision}); err == nil {
		t.Fatal("stale revision accepted")
	}
	after, _ := svc.repo.DramaProduction(projectID)
	currentCast, _ := svc.repo.DramaCast(projectID, cast.ID)
	if _, err := svc.UpdateDramaCastImageOptions("usr-drama", projectID, cast.ID, UpdateDramaCastImageOptionsRequest{ExpectedRevision: &after.Revision, ExpectedCastRevision: &cast.Revision}); err == nil {
		t.Fatal("fresh project revision authorized stale cast draft")
	}
	if err := fake.db.Model(&model.DramaCast{}).Where("id = ?", cast.ID).Update("image_status", model.DramaMediaQueued).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := svc.UpdateDramaCastImageOptions("usr-drama", projectID, cast.ID, UpdateDramaCastImageOptionsRequest{ExpectedRevision: &after.Revision, ExpectedCastRevision: &currentCast.Revision}); err == nil {
		t.Fatal("queued image options changed")
	}
}

func TestDramaCastImageOptionsEnforceActualModelCapability(t *testing.T) {
	svc, fake, projectID, _ := dramaStudioFixture(t)
	seedDramaStudioBatchImagePrice(t, fake)
	casts, _ := svc.repo.DramaCasts(projectID)
	cast := casts[0]
	p, _ := svc.repo.DramaProduction(projectID)
	image := fake.resource("usr-drama", "image", "image/png")
	if _, err := svc.UpdateDramaCastImageOptions("usr-drama", projectID, cast.ID, UpdateDramaCastImageOptionsRequest{ExpectedRevision: &p.Revision, ExpectedCastRevision: &cast.Revision, Options: DramaCastImageOptions{Resolution: "4k"}}); err == nil || !strings.Contains(err.Error(), "4K") {
		t.Fatalf("unsupported resolution accepted: %v", err)
	}
	profile := DefaultModelCapabilityConfigForModel(string(model.ChannelInterfaceGeminiImage), "image")
	profile.Image.References.MaxImages = 0
	raw, _ := json.Marshal(profile)
	if err := fake.db.Model(&model.ChannelModel{}).Where("id = ?", "studio-batch-image").Update("capability_config_json", string(raw)).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := svc.UpdateDramaCastImageOptions("usr-drama", projectID, cast.ID, UpdateDramaCastImageOptionsRequest{ExpectedRevision: &p.Revision, ExpectedCastRevision: &cast.Revision, Options: DramaCastImageOptions{SubjectReferenceIDs: []string{image}}}); err == nil {
		t.Fatal("model that accepts no images accepted reference image")
	}
}

func TestDramaCastImageOptionsInvalidateOldQuoteAndLookReferenceOrder(t *testing.T) {
	svc, _, projectID, _ := dramaStudioFixture(t)
	casts, _ := svc.repo.DramaCasts(projectID)
	cast := casts[0]
	before, err := svc.PreflightDramaStudioAction("usr-drama", projectID, DramaStudioActionRequest{Action: "cast_image", TargetID: cast.ID})
	if err != nil || !before.Ready {
		t.Fatalf("preflight = %+v, %v", before, err)
	}
	p, _ := svc.repo.DramaProduction(projectID)
	if _, err := svc.UpdateDramaCastImageOptions("usr-drama", projectID, cast.ID, UpdateDramaCastImageOptionsRequest{ExpectedRevision: &p.Revision, ExpectedCastRevision: &cast.Revision, Options: DramaCastImageOptions{Ratio: "1:1"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ExecuteDramaStudioAction("usr-drama", projectID, confirmedDramaStudioRequest(before)); err == nil {
		t.Fatal("old quote survived image configuration change")
	}
	raw, _ := json.Marshal(DramaCastImageOptions{SubjectReferenceIDs: []string{"a"}, StyleReferenceIDs: []string{"b"}})
	look := model.DramaCast{ParentID: cast.ID, ImageOptionsJSON: string(raw)}
	text := dramaCastReferenceInstructions(look)
	if !strings.Contains(text, "参考图2用于主体") || !strings.Contains(text, "参考图3仅参考画风") {
		t.Fatalf("look identity offset missing: %s", text)
	}
}
