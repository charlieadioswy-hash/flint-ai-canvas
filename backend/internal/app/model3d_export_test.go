package app

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"

	"yingce/backend/internal/model"
	"yingce/backend/internal/model3d"
	"yingce/backend/internal/repository"
)

type model3DExportMock struct {
	calls   int
	request model3d.ConversionRequest
	start   chan struct{}
	err     error
	empty   bool
	size    int
}

func (m *model3DExportMock) Convert(ctx context.Context, request model3d.ConversionRequest) (model3d.ConversionOutput, error) {
	m.calls++
	m.request = request
	if m.start != nil {
		close(m.start)
		<-ctx.Done()
		return model3d.ConversionOutput{}, ctx.Err()
	}
	if m.err != nil {
		return model3d.ConversionOutput{}, m.err
	}
	data := []byte("Kaydara FBX Binary  \x00\x1a\x00output")
	if request.Options.Format == "abc" {
		data = []byte("Ogawa\x00\x01\xffcache")
	}
	if m.empty {
		data = nil
	}
	if m.size > len(data) {
		data = append(data, make([]byte, m.size-len(data))...)
	}
	path := filepath.Join(request.OutputDir, "result."+request.Options.Format)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return model3d.ConversionOutput{}, err
	}
	return model3d.ConversionOutput{Path: path, Format: request.Options.Format, FileName: filepath.Base(path), Bytes: int64(len(data))}, nil
}

func model3DExportSource(t *testing.T, s *Service, format string) *model.Resource {
	t.Helper()
	data := model3DTestGLB()
	if format == "fbx" {
		data = []byte("Kaydara FBX Binary  \x00\x1a\x00original")
	}
	resource, err := s.UploadResourceFile("3d-user", "source."+format, int64(len(data)), "model", 0, 0, 0, bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	return resource
}

func model3DExportReq(resource *model.Resource, format string) Model3DExportRequest {
	return Model3DExportRequest{RequestID: "export-one", ResourceID: resource.ID, SourceFormat: "glb", FileName: "模型.glb", Format: format}
}

func TestModel3DExportOwnedResourceUnbilledRoundTrip(t *testing.T) {
	for _, format := range []string{"fbx", "abc"} {
		t.Run(format, func(t *testing.T) {
			s, db, provider, _ := setupModel3DTest(t)
			converter := &model3DExportMock{}
			s.model3DConverter = converter
			resource := model3DExportSource(t, s, "glb")
			request := model3DExportReq(resource, format)
			if _, err := s.CreateModel3DExport("3d-other", request); err == nil {
				t.Fatal("accepted another user's source")
			}
			view, err := s.CreateModel3DExport("3d-user", request)
			if err != nil || view.Status != model.TaskStatusQueued {
				t.Fatalf("create: %+v, %v", view, err)
			}
			replayed, err := s.CreateModel3DExport("3d-user", request)
			if err != nil || replayed.ID != view.ID {
				t.Fatalf("request was not idempotent: %+v %v", replayed, err)
			}
			changed := request
			changed.FPS = 60
			if _, err := s.CreateModel3DExport("3d-user", changed); err == nil {
				t.Fatal("accepted reuse for different options")
			}
			if err := s.repo.DeleteResource("3d-user", resource.ID); !errors.Is(err, repository.ErrModel3DReferenced) {
				t.Fatalf("active source deletion allowed: %v", err)
			}
			if err := s.ProcessNextTask(); err != nil {
				t.Fatal(err)
			}
			view, err = s.Model3DExport("3d-user", view.ID)
			if err != nil || view.Status != model.TaskStatusSucceeded || view.Result == nil || view.Result.Format != format || view.Result.FileName != "模型."+format {
				t.Fatalf("result: %+v, %v", view, err)
			}
			if converter.calls != 1 || provider.submits != 0 || provider.uploads != nil {
				t.Fatal("conversion used provider or ran more than once")
			}
			if converter.request.Options.FPS != 30 {
				t.Fatalf("default fps missing: %+v", converter.request.Options)
			}
			if _, err := os.Stat(converter.request.SourcePath); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("temporary source was not removed: %v", err)
			}
			if _, err := s.Model3DExport("3d-other", view.ID); err == nil {
				t.Fatal("another user read export")
			}
			if _, err := s.CancelModel3DExport("3d-other", view.ID); err == nil {
				t.Fatal("another user cancelled export")
			}
			_, reader, err := s.OpenResource("3d-user", resource.ID)
			if err != nil {
				t.Fatal(err)
			}
			data, _ := io.ReadAll(reader)
			reader.Close()
			if !bytes.Equal(data, model3DTestGLB()) {
				t.Fatal("source was modified")
			}
			var billed, assets int64
			db.Model(&model.BillingOrder{}).Count(&billed)
			db.Model(&model.Asset{}).Count(&assets)
			if billed != 0 || assets != 0 {
				t.Fatal("export charged credits or replaced asset")
			}
			cancelled, err := s.CancelModel3DExport("3d-user", view.ID)
			if err != nil || cancelled.Status != model.TaskStatusSucceeded {
				t.Fatal("late cancellation replaced success")
			}
		})
	}
}

func TestModel3DExportNativeFBXDoesNotRequireBlender(t *testing.T) {
	s, _, _, _ := setupModel3DTest(t)
	t.Setenv("CANVAS_BLENDER_BIN", filepath.Join(t.TempDir(), "unavailable"))
	resource := model3DExportSource(t, s, "fbx")
	request := model3DExportReq(resource, "fbx")
	request.SourceFormat = "fbx"
	view, err := s.CreateModel3DExport("3d-user", request)
	if err != nil || view.Status != model.TaskStatusSucceeded || view.Result == nil || view.Result.ResourceID != resource.ID {
		t.Fatalf("did not pass through original: %+v %v", view, err)
	}
	capability, err := s.Model3DExportCapabilities("3d-user")
	if err != nil || capability.Available {
		t.Fatalf("unexpected availability: %+v %v", capability, err)
	}
	request.RequestID, request.Format = "needs-blender", "abc"
	if _, err := s.CreateModel3DExport("3d-user", request); err == nil {
		t.Fatal("admitted conversion without binary")
	}
	request = model3DExportReq(model3DExportSource(t, s, "glb"), "fbx")
	request.SourceFormat, request.RequestID = "fbx", "false-format"
	if _, err := s.CreateModel3DExport("3d-user", request); err == nil {
		t.Fatal("accepted GLB pretending to be native FBX")
	}
}

func TestModel3DExportResumesStoredOutputWithoutReconversion(t *testing.T) {
	s, _, _, _ := setupModel3DTest(t)
	converter := &model3DExportMock{}
	s.model3DConverter = converter
	resource := model3DExportSource(t, s, "glb")
	view, err := s.CreateModel3DExport("3d-user", model3DExportReq(resource, "fbx"))
	if err != nil {
		t.Fatal(err)
	}
	data := []byte("Kaydara FBX Binary  \x00\x1a\x00saved-before-crash")
	stored, err := s.UploadResourceFile("3d-user", "model.fbx", int64(len(data)), "model", 0, 0, 0, bytes.NewReader(data), "model3d-export:"+view.ID)
	if err != nil {
		t.Fatal(err)
	}
	day := time.Now().UTC().Format("2006-01-02")
	before, err := s.repo.DailyUploadBytes("3d-user", day)
	if err != nil {
		t.Fatal(err)
	}
	if err := s.ProcessNextTask(); err != nil {
		t.Fatal(err)
	}
	view, err = s.Model3DExport("3d-user", view.ID)
	if err != nil || view.Status != model.TaskStatusSucceeded || view.Result == nil || view.Result.ResourceID != stored.ID || converter.calls != 0 {
		t.Fatalf("did not recover stored output: %+v %v", view, err)
	}
	if after, err := s.repo.DailyUploadBytes("3d-user", day); err != nil || after != before {
		t.Fatalf("ready checkpoint consumed upload quota again: before=%d after=%d err=%v", before, after, err)
	}
}

func TestModel3DExportReclaimsIncompleteOutput(t *testing.T) {
	for _, status := range []model.ResourceStatus{model.ResourceStatusPending, model.ResourceStatusFailed} {
		t.Run(string(status), func(t *testing.T) {
			s, db, _, _ := setupModel3DTest(t)
			converter := &model3DExportMock{}
			s.model3DConverter = converter
			source := model3DExportSource(t, s, "glb")
			view, err := s.CreateModel3DExport("3d-user", model3DExportReq(source, "fbx"))
			if err != nil {
				t.Fatal(err)
			}
			old, err := s.repo.ClaimNextTask("interrupted-worker", time.Minute)
			if err != nil || old == nil || old.ID != view.ID {
				t.Fatalf("claim: %+v %v", old, err)
			}
			data := []byte("Kaydara FBX Binary  \x00\x1a\x00incomplete-checkpoint")
			checkpoint, err := s.UploadResourceFile("3d-user", "model.fbx", int64(len(data)), "model", 0, 0, 0, bytes.NewReader(data), "model3d-export:"+view.ID)
			if err != nil {
				t.Fatal(err)
			}
			checkpoint.Status = status
			if err := s.repo.SaveResource(checkpoint); err != nil {
				t.Fatal(err)
			}
			if err := db.Model(&model.Task{}).Where("id = ?", view.ID).Update("lease_expires_at", time.Now().Add(-time.Second)).Error; err != nil {
				t.Fatal(err)
			}
			day := time.Now().UTC().Format("2006-01-02")
			before, err := s.repo.DailyUploadBytes("3d-user", day)
			if err != nil {
				t.Fatal(err)
			}
			if err := s.ProcessNextTask(); err != nil {
				t.Fatal(err)
			}
			view, err = s.Model3DExport("3d-user", view.ID)
			if err != nil || view.Status != model.TaskStatusSucceeded || view.Result == nil || view.Result.ResourceID == checkpoint.ID || converter.calls != 1 {
				t.Fatalf("incomplete output blocked recovery: %+v %v calls=%d", view, err, converter.calls)
			}
			stored, err := s.resourceForUploadKey("3d-user", normalizedResourceUploadKey([]string{"model3d-export:" + view.ID}))
			if err != nil || stored == nil || stored.ID != view.Result.ResourceID || stored.Status != model.ResourceStatusReady {
				t.Fatalf("replacement checkpoint missing: %+v %v", stored, err)
			}
			stale, err := s.repo.ResourceForUser("3d-user", checkpoint.ID)
			if err != nil || stale.UploadKey != nil || stale.Status != status {
				t.Fatalf("stale checkpoint was reused: %+v %v", stale, err)
			}
			oldData, err := os.ReadFile(filepath.Join(s.dataDir, "resources", filepath.FromSlash(checkpoint.ObjectKey)))
			if err != nil || !bytes.Equal(oldData, data) {
				t.Fatalf("old object was overwritten: %q %v", oldData, err)
			}
			// A writer holding the old in-memory row cannot restore its old
			// upload identity over the replacement checkpoint.
			checkpoint.Status = model.ResourceStatusReady
			if err := s.repo.SaveResource(checkpoint); err == nil {
				t.Fatal("late stale resource write restored the checkpoint identity")
			}
			if latest, err := s.resourceForUploadKey("3d-user", normalizedResourceUploadKey([]string{"model3d-export:" + view.ID})); err != nil || latest == nil || latest.ID != view.Result.ResourceID {
				t.Fatalf("late resource write replaced recovered output: %+v %v", latest, err)
			}
			if after, err := s.repo.DailyUploadBytes("3d-user", day); err != nil || after != before+view.Result.Bytes || s.pendingStorage["3d-user"] != 0 {
				t.Fatalf("recovery quota mismatch: before=%d after=%d pending=%d err=%v", before, after, s.pendingStorage["3d-user"], err)
			}
		})
	}
}

func TestModel3DExportOutputPublicationRequiresCurrentLease(t *testing.T) {
	s, db, _, _ := setupModel3DTest(t)
	s.model3DConverter = &model3DExportMock{}
	source := model3DExportSource(t, s, "glb")
	view, err := s.CreateModel3DExport("3d-user", model3DExportReq(source, "fbx"))
	if err != nil {
		t.Fatal(err)
	}
	old, err := s.repo.ClaimNextTask("old-worker", time.Minute)
	if err != nil || old == nil {
		t.Fatalf("claim old: %+v %v", old, err)
	}
	data := []byte("Kaydara FBX Binary  \x00\x1a\x00old-worker-output")
	oldOutput, err := s.UploadResourceFile("3d-user", "old.fbx", int64(len(data)), "model", 0, 0, 0, bytes.NewReader(data), "old-export-attempt")
	if err != nil {
		t.Fatal(err)
	}
	key := normalizedResourceUploadKey([]string{"model3d-export:" + view.ID})
	if err := db.Model(&model.Task{}).Where("id = ?", view.ID).Update("lease_expires_at", time.Now().Add(-time.Second)).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := s.repo.PublishModel3DExportOutput(old, oldOutput, *key); !errors.Is(err, repository.ErrTaskStateConflict) {
		t.Fatalf("expired lease published: %v", err)
	}
	current, err := s.repo.ClaimNextTask("new-worker", time.Minute)
	if err != nil || current == nil || current.ID != old.ID {
		t.Fatalf("claim new: %+v %v", current, err)
	}
	newData := []byte("Kaydara FBX Binary  \x00\x1a\x00new-worker-output")
	newOutput, err := s.UploadResourceFile("3d-user", "new.fbx", int64(len(newData)), "model", 0, 0, 0, bytes.NewReader(newData), "new-export-attempt")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.repo.PublishModel3DExportOutput(current, newOutput, *key); err != nil {
		t.Fatal(err)
	}
	if _, err := s.repo.PublishModel3DExportOutput(old, oldOutput, *key); !errors.Is(err, repository.ErrTaskStateConflict) {
		t.Fatalf("replaced lease published: %v", err)
	}
	s.cleanupModel3DExportOutput(old, oldOutput)
	if _, err := s.repo.ResourceForUser("3d-user", oldOutput.ID); err == nil {
		t.Fatal("discarded attempt was not queued for cleanup")
	}
	checkpoint, err := s.resourceForUploadKey("3d-user", key)
	if err != nil || checkpoint == nil || checkpoint.ID != newOutput.ID {
		t.Fatalf("late output replaced the current checkpoint: %+v %v", checkpoint, err)
	}
	if _, err := s.CancelModel3DExport("3d-user", view.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := s.repo.PublishModel3DExportOutput(current, newOutput, *key); !errors.Is(err, repository.ErrTaskStateConflict) {
		t.Fatalf("cancelled task published: %v", err)
	}
	s.cleanupModel3DExportOutput(current, checkpoint)
	if stored, err := s.resourceForUploadKey("3d-user", key); err != nil || stored != nil {
		t.Fatalf("cancelled checkpoint retained: %+v %v", stored, err)
	}
}

func TestModel3DExportCancelledStoredOutputIsCleaned(t *testing.T) {
	s, _, _, _ := setupModel3DTest(t)
	s.model3DConverter = &model3DExportMock{}
	resource := model3DExportSource(t, s, "glb")
	view, err := s.CreateModel3DExport("3d-user", model3DExportReq(resource, "fbx"))
	if err != nil {
		t.Fatal(err)
	}
	data := []byte("Kaydara FBX Binary  \x00\x1a\x00saved-during-cancel")
	stored, err := s.UploadResourceFile("3d-user", "model.fbx", int64(len(data)), "model", 0, 0, 0, bytes.NewReader(data), "model3d-export:"+view.ID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.CancelModel3DExport("3d-user", view.ID); err != nil {
		t.Fatal(err)
	}
	task, err := s.repo.TaskForUser("3d-user", view.ID)
	if err != nil {
		t.Fatal(err)
	}
	s.cleanupModel3DExportOutput(task, stored)
	if _, err := s.repo.ResourceForUser("3d-user", stored.ID); err == nil {
		t.Fatal("cancelled output retained storage quota")
	}
	if _, err := s.repo.ResourceForUser("3d-user", resource.ID); err != nil {
		t.Fatal("cleanup removed original source", err)
	}
}

func TestModel3DExportCancellationBeforeAdmissionIsDurable(t *testing.T) {
	s, _, _, _ := setupModel3DTest(t)
	converter := &model3DExportMock{}
	s.model3DConverter = converter
	resource := model3DExportSource(t, s, "glb")
	request := model3DExportReq(resource, "abc")
	cancelled, err := s.CancelModel3DExportByRequest("3d-user", request.RequestID)
	if err != nil || cancelled.Status != model.TaskStatusCancelled {
		t.Fatalf("cancel: %+v %v", cancelled, err)
	}
	late, err := s.CreateModel3DExport("3d-user", request)
	if err != nil || late.ID != cancelled.ID || late.Status != model.TaskStatusCancelled {
		t.Fatalf("late creation escaped cancellation: %+v %v", late, err)
	}
	if err := s.ProcessNextTask(); err != nil || converter.calls != 0 {
		t.Fatal("cancelled request ran conversion", err)
	}
}

func TestModel3DExportRunningCancellationKillsConverter(t *testing.T) {
	s, _, _, _ := setupModel3DTest(t)
	converter := &model3DExportMock{start: make(chan struct{})}
	s.model3DConverter = converter
	resource := model3DExportSource(t, s, "glb")
	view, err := s.CreateModel3DExport("3d-user", model3DExportReq(resource, "abc"))
	if err != nil {
		t.Fatal(err)
	}
	finished := make(chan error, 1)
	go func() { finished <- s.ProcessNextTask() }()
	select {
	case <-converter.start:
	case <-time.After(5 * time.Second):
		t.Fatal("converter not started")
	}
	if _, err := s.CancelModel3DExportByRequest("3d-user", "export-one"); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-finished:
		if err != nil && !errors.Is(err, repository.ErrTaskStateConflict) {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("converter not cancelled")
	}
	view, err = s.Model3DExport("3d-user", view.ID)
	if err != nil || view.Status != model.TaskStatusCancelled || view.Result != nil {
		t.Fatalf("cancellation overwritten: %+v %v", view, err)
	}
}

func TestModel3DExportEmptyOutputFails(t *testing.T) {
	s, _, _, _ := setupModel3DTest(t)
	s.model3DConverter = &model3DExportMock{empty: true}
	resource := model3DExportSource(t, s, "glb")
	view, err := s.CreateModel3DExport("3d-user", model3DExportReq(resource, "fbx"))
	if err != nil {
		t.Fatal(err)
	}
	if err := s.ProcessNextTask(); err != nil {
		t.Fatal(err)
	}
	view, err = s.Model3DExport("3d-user", view.ID)
	if err != nil || view.Status != model.TaskStatusFailed || view.Result != nil {
		t.Fatalf("invalid output succeeded: %+v %v", view, err)
	}
}

func TestModel3DExportHonorsGeneratedFileQuota(t *testing.T) {
	s, db, _, admin := setupModel3DTest(t)
	s.model3DConverter = &model3DExportMock{size: 2 << 20}
	policy := defaultRuntimePolicy()
	policy.Resource.GeneratedFileMB = 1
	if _, err := s.UpdateRuntimePolicySetting(admin, policy); err != nil {
		t.Fatal(err)
	}
	resource := model3DExportSource(t, s, "glb")
	view, err := s.CreateModel3DExport("3d-user", model3DExportReq(resource, "fbx"))
	if err != nil {
		t.Fatal(err)
	}
	if err := s.ProcessNextTask(); err != nil {
		t.Fatal(err)
	}
	view, err = s.Model3DExport("3d-user", view.ID)
	if err != nil || view.Status != model.TaskStatusFailed || view.Result != nil {
		t.Fatalf("quota did not stop output: %+v %v", view, err)
	}
	var count int64
	if err := db.Model(&model.Resource{}).Count(&count).Error; err != nil || count != 1 {
		t.Fatalf("over-quota output persisted: %d %v", count, err)
	}
}

func TestModel3DExportDefersWithoutOccupyingConversionSlot(t *testing.T) {
	s, db, _, _ := setupModel3DTest(t)
	converter := &model3DExportMock{}
	s.model3DConverter = converter
	resource := model3DExportSource(t, s, "glb")
	view, err := s.CreateModel3DExport("3d-user", model3DExportReq(resource, "fbx"))
	if err != nil {
		t.Fatal(err)
	}
	lease, acquired, err := s.coordinator.AcquireLease(context.Background(), "model3d-export", 1, time.Minute)
	if err != nil || !acquired {
		t.Fatal("could not acquire conversion slot", err)
	}
	defer lease.Release()
	if err := s.ProcessNextTask(); err != nil || converter.calls != 0 {
		t.Fatal("conversion ran without slot", err)
	}
	deferred, err := s.repo.TaskForUser("3d-user", view.ID)
	if err != nil || deferred.NextPollAt == nil || deferred.LeaseOwner != "" || deferred.Status != model.TaskStatusRunning {
		t.Fatalf("worker did not defer: %+v %v", deferred, err)
	}
	lease.Release()
	if err := db.Model(deferred).Update("next_poll_at", nil).Error; err != nil {
		t.Fatal(err)
	}
	if err := s.ProcessNextTask(); err != nil || converter.calls != 1 {
		t.Fatal("conversion did not resume after slot release", err)
	}
}
