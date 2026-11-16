package app

import (
	"testing"

	"yingce/backend/internal/model"
)

func TestDramaShotMediaIncompleteReferencesSaveButBlockGeneration(t *testing.T) {
	for _, tc := range []struct {
		name, kind, operation, reason string
		refs                          []string
		first, last                   string
	}{
		{name: "clear frames", kind: "video", operation: "image_to_video", first: "ref-one", last: "ref-two", reason: "所选视频模式需要参考图片或首尾帧"},
		{name: "remove last video reference", kind: "video", operation: "reference_to_video", refs: []string{"ref-one"}, reason: "所选视频模式需要参考图片或首尾帧"},
		{name: "remove last image reference", kind: "image", operation: "image_to_image", refs: []string{"ref-one"}, reason: "参考图生图需要至少一张参考图片"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, db, video := shotMediaFixture(t)
			draft := video.Config
			draft.Operation, draft.ReferenceResourceIDs = tc.operation, tc.refs
			draft.FirstFrameResourceID, draft.LastFrameResourceID = tc.first, tc.last
			revision := video.Revision
			if tc.kind == "image" {
				revision = 0
			}
			filled, err := s.SaveDramaShotMedia("user", "drama-project", "real-shot", tc.kind, DramaShotMediaSaveRequest{ExpectedRevision: &revision, Config: draft})
			if err != nil {
				t.Fatal(err)
			}
			draft = filled.Config
			draft.ReferenceResourceIDs, draft.FirstFrameResourceID, draft.LastFrameResourceID = nil, "", ""
			draft.ReferenceNames = map[string]string{"ref-one": "已移除的图片"}
			empty, err := s.SaveDramaShotMedia("user", "drama-project", "real-shot", tc.kind, DramaShotMediaSaveRequest{ExpectedRevision: &filled.Revision, Config: draft})
			if err != nil {
				t.Fatalf("incomplete draft must save: %v", err)
			}
			read, err := s.DramaShotMedia("user", "drama-project", "real-shot", tc.kind)
			if err != nil || read.Revision != filled.Revision+1 || read.Config.Operation != tc.operation || len(dramaShotMediaReferenceIDs(read.Config)) != 0 || len(read.Config.ReferenceNames) != 0 {
				t.Fatalf("cleared references were not persisted: %+v, %v", read, err)
			}
			quote, err := s.QuoteDramaShotMedia("user", "drama-project", "real-shot", tc.kind, DramaShotMediaSaveRequest{ExpectedRevision: &empty.Revision, Config: draft})
			if err != nil || quote.Ready || quote.Priced || quote.ConfirmationToken != "" || quote.Reason != tc.reason || quote.Config.Operation != tc.operation {
				t.Fatalf("incomplete draft quote must explain missing images: %+v, %v", quote, err)
			}
			preflight, err := s.PreflightDramaShotMedia("user", "drama-project", "real-shot", tc.kind, DramaShotMediaActionRequest{ExpectedRevision: &empty.Revision})
			if err != nil || preflight.Ready || preflight.Priced || preflight.ConfirmationToken != "" || preflight.Reason != tc.reason {
				t.Fatalf("saved incomplete draft must remain blocked: %+v, %v", preflight, err)
			}
			task, err := s.ExecuteDramaShotMedia("user", "drama-project", "real-shot", tc.kind, DramaShotMediaActionRequest{ExpectedRevision: &empty.Revision, BaseRevision: &preflight.BaseRevision, ConfirmationToken: "no-confirmation-for-missing-images", ClientOperationID: "empty-image-inputs"})
			if task != nil || !isAppErrorStatus(err, 409) {
				t.Fatalf("missing images admitted generation: %+v, %v", task, err)
			}
			for _, entity := range []any{&model.Task{}, &model.BillingOrder{}, &model.DramaTake{}} {
				var count int64
				if err := db.Model(entity).Count(&count).Error; err != nil || count != 0 {
					t.Fatalf("incomplete draft created %T: %d, %v", entity, count, err)
				}
			}
			var wallet model.CreditAccount
			if err := db.First(&wallet, "user_id = ?", "user").Error; err != nil || wallet.AvailableMicrocredits != 10000 || wallet.ReservedMicrocredits != 0 {
				t.Fatalf("incomplete draft charged credits: %+v, %v", wallet, err)
			}
		})
	}
}

func TestDramaShotMediaIncompleteDraftStillValidatesPresentImagesAndMode(t *testing.T) {
	s, db, saved := shotMediaFixture(t)
	for _, resource := range []model.Resource{
		{ID: "not-ready-reference", UserID: "user", Kind: "image", Status: model.ResourceStatusPending, MimeType: "image/png"},
		{ID: "foreign-reference", UserID: "other", Kind: "image", Status: model.ResourceStatusReady, MimeType: "image/png"},
		{ID: "video-reference", UserID: "user", Kind: "video", Status: model.ResourceStatusReady, MimeType: "video/mp4"},
	} {
		if err := db.Create(&resource).Error; err != nil {
			t.Fatal(err)
		}
	}
	for _, tc := range []struct {
		name, operation, reference, frame string
	}{
		{name: "missing image", operation: "reference_to_video", reference: "missing-reference"},
		{name: "unready image", operation: "reference_to_video", reference: "not-ready-reference"},
		{name: "foreign image", operation: "reference_to_video", reference: "foreign-reference"},
		{name: "wrong media kind", operation: "reference_to_video", reference: "video-reference"},
		{name: "wrong operation", operation: "image_to_image"},
		{name: "frame in reference mode", operation: "reference_to_video", frame: "ref-one"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			draft := saved.Config
			draft.Operation, draft.ReferenceResourceIDs = tc.operation, nil
			draft.FirstFrameResourceID, draft.LastFrameResourceID = tc.frame, ""
			if tc.reference != "" {
				draft.ReferenceResourceIDs = []string{tc.reference}
			}
			if _, err := s.SaveDramaShotMedia("user", "drama-project", "real-shot", "video", DramaShotMediaSaveRequest{ExpectedRevision: &saved.Revision, Config: draft}); !isAppErrorStatus(err, 400) {
				t.Fatalf("invalid present image or incompatible mode accepted: %v", err)
			}
			if current := mustShotMedia(t, s); current.Revision != saved.Revision {
				t.Fatal("rejected draft changed saved configuration")
			}
		})
	}
}
