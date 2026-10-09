package app

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"hash/crc32"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"gorm.io/gorm"
	"yingce/backend/internal/model"
	"yingce/backend/internal/moderation"
	"yingce/backend/internal/repository"
)

type mockImageModerationProvider struct {
	mu      sync.Mutex
	calls   []string
	configs []moderation.Config
	fail    map[string]bool
	results map[string]moderation.Result
}

func (m *mockImageModerationProvider) Validate(config moderation.Config) error {
	provider, err := moderation.NewProvider("aliyun")
	if err != nil {
		return err
	}
	return provider.Validate(config)
}

func (m *mockImageModerationProvider) Detect(_ context.Context, config moderation.Config, _ moderation.Image, service string) (moderation.Result, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.calls = append(m.calls, service)
	m.configs = append(m.configs, config)
	if m.fail[service] {
		return moderation.Result{}, errors.New("upstream failure containing secret must not be persisted")
	}
	if result, exists := m.results[service]; exists {
		return result, nil
	}
	return moderation.Result{RiskLevel: "none", RiskTags: []moderation.RiskTag{}, RequestID: "mock-request"}, nil
}

func setupImageModerationTest(t *testing.T) (*Service, *gorm.DB, *mockImageModerationProvider, *model.User) {
	t.Helper()
	db := newSQLiteTestDB(t)
	if err := db.AutoMigrate(&model.Resource{}, &model.AdminAuditEvent{}, &model.ImageModerationProvider{}, &model.ImageModerationConfig{}, &model.ImageModerationPolicy{}, &model.ImageModerationCheck{}, &model.ImageModerationItem{}, &model.ImageModerationDailyUsage{}); err != nil {
		t.Fatal(err)
	}
	provider := &mockImageModerationProvider{fail: map[string]bool{}, results: map[string]moderation.Result{}}
	svc := &Service{repo: repository.New(db), dataDir: t.TempDir(), workerID: "moderation-worker", imageModerationProviderFactory: func(kind string) (moderation.Provider, error) {
		if kind != "aliyun" {
			return nil, errors.New("unsupported")
		}
		return provider, nil
	}}
	return svc, db, provider, &model.User{ID: "moderation-admin", Role: model.UserRoleAdmin}
}

func moderationTestRequest() ImageModerationProviderRequest {
	return ImageModerationProviderRequest{Name: "Detector", Type: "aliyun", Enabled: true, Region: "cn-shanghai", Services: []string{"aigcCheck", "aigcViolationDetection"}, TimeoutSeconds: 30, MaxCallsPerDay: 100, MinIntervalSeconds: 1, AccessKeyID: "test-ak", AccessKeySecret: "test-sk"}
}

func enableImageModerationTest(t *testing.T, svc *Service, admin *model.User, req ImageModerationProviderRequest) *ImageModerationProviderView {
	t.Helper()
	provider, err := svc.SaveImageModerationProvider(admin, "", req)
	if err != nil {
		t.Fatal(err)
	}
	state, err := svc.AdminImageModeration(admin)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ActivateImageModerationProvider(admin, provider.ID, ImageModerationActivationRequest{ConfigID: provider.ConfigID, ExpectedRevision: state.PolicyRevision}); err != nil {
		t.Fatal(err)
	}
	return provider
}

func addImageModerationResource(t *testing.T, svc *Service, userID, id string) *model.Resource {
	t.Helper()
	var data bytes.Buffer
	if err := png.Encode(&data, image.NewNRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(svc.dataDir, "resources"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(svc.dataDir, "resources", id+".png"), data.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	resource := &model.Resource{ID: id, UserID: userID, Kind: "image", Status: model.ResourceStatusReady, Provider: "local", ObjectKey: id + ".png", MimeType: "image/png", Size: int64(data.Len()), ETag: "test-image-v1"}
	if err := svc.repo.Create(resource); err != nil {
		t.Fatal(err)
	}
	return resource
}

func processImageModerationTest(t *testing.T, svc *Service) {
	t.Helper()
	check, err := svc.repo.ClaimImageModerationCheck(svc.workerID, imageModerationLease)
	if err != nil || check == nil {
		t.Fatalf("claim: %v, %+v", err, check)
	}
	svc.processImageModerationCheck(context.Background(), check)
}

func ageImageModerationChecks(t *testing.T, db *gorm.DB) {
	t.Helper()
	if err := db.Model(&model.ImageModerationCheck{}).Where("1 = 1").Update("created_at", time.Now().UTC().Add(-time.Hour)).Error; err != nil {
		t.Fatal(err)
	}
}

func TestImageModerationAdminEncryptedVersionsAndActivation(t *testing.T) {
	svc, db, mock, admin := setupImageModerationTest(t)
	if _, err := svc.AdminImageModeration(&model.User{ID: "regular", Role: model.UserRoleUser}); err == nil {
		t.Fatal("non-admin read permitted")
	}
	if _, err := svc.SaveImageModerationProvider(&model.User{ID: "regular"}, "", moderationTestRequest()); err == nil {
		t.Fatal("non-admin update permitted")
	}
	view := enableImageModerationTest(t, svc, admin, moderationTestRequest())
	unpaired := moderationTestRequest()
	unpaired.AccessKeySecret = ""
	if _, err := svc.SaveImageModerationProvider(admin, view.ID, unpaired); err == nil {
		t.Fatal("unpaired credential rotation accepted")
	}
	zeroBudget := moderationTestRequest()
	zeroBudget.MaxCallsPerDay = 0
	if _, err := svc.SaveImageModerationProvider(admin, view.ID, zeroBudget); err == nil {
		t.Fatal("zero budget silently defaulted to a spend allowance")
	}
	record, err := svc.repo.ImageModerationConfig(view.ConfigID)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(record.AccessKeyIDEncrypted, encryptedSettingPrefix) || !strings.HasPrefix(record.AccessKeySecretEncrypted, encryptedSettingPrefix) {
		t.Fatal("credentials not encrypted")
	}
	if err := svc.ValidateImageModerationProvider(admin, view.ID, view.ConfigID); err != nil {
		t.Fatal(err)
	}
	if len(mock.calls) != 0 {
		t.Fatal("configuration validation submitted a paid call")
	}
	req := moderationTestRequest()
	req.Name = "Detector updated"
	req.AccessKeyID = ""
	req.AccessKeySecret = ""
	req.Region = "cn-beijing"
	next, err := svc.SaveImageModerationProvider(admin, view.ID, req)
	if err != nil {
		t.Fatal(err)
	}
	if next.Version != 2 || next.ConfigID == view.ConfigID {
		t.Fatal("configuration not append-only")
	}
	var count int64
	if err := db.Model(&model.ImageModerationConfig{}).Count(&count).Error; err != nil || count != 2 {
		t.Fatalf("configs: %d %v", count, err)
	}
	old, _ := svc.repo.ImageModerationConfig(view.ConfigID)
	if old.Region != "cn-shanghai" {
		t.Fatal("old config mutated")
	}
	state, err := svc.AdminImageModeration(admin)
	if err != nil {
		t.Fatal(err)
	}
	if state.ActiveConfigID != view.ConfigID {
		t.Fatal("saving silently activated config")
	}
	disabledRequest := req
	disabledRequest.Enabled = false
	if _, err := svc.SaveImageModerationProvider(admin, view.ID, disabledRequest); err == nil {
		t.Fatal("saving disabled active provider unexpectedly succeeded")
	}
	available, availabilityErr := svc.ImageModerationAvailable("user")
	if availabilityErr != nil || !available {
		t.Fatal("rejected config update disabled the active service")
	}
	encoded, _ := json.Marshal(state)
	if bytes.Contains(encoded, []byte("test-ak")) || bytes.Contains(encoded, []byte("test-sk")) || bytes.Contains(encoded, []byte(encryptedSettingPrefix)) {
		t.Fatal("admin response leaked credentials")
	}
	if _, err := svc.ActivateImageModerationProvider(admin, view.ID, ImageModerationActivationRequest{ConfigID: next.ConfigID, ExpectedRevision: 0}); err == nil {
		t.Fatal("stale activation succeeded")
	}
	if _, err := svc.ArchiveImageModerationProvider(admin, view.ID); err == nil {
		t.Fatal("active provider archived")
	}
	state, err = svc.DisableImageModeration(admin, state.PolicyRevision)
	if err != nil {
		t.Fatal(err)
	}
	if state.ActiveProviderID != "" {
		t.Fatal("disable failed")
	}
	if _, err := svc.ArchiveImageModerationProvider(admin, view.ID); err != nil {
		t.Fatal(err)
	}
	available, err = svc.ImageModerationAvailable("user")
	if err != nil || available {
		t.Fatalf("availability %v %v", available, err)
	}
	var auditRecords []model.AdminAuditEvent
	if err := db.Find(&auditRecords).Error; err != nil {
		t.Fatal(err)
	}
	if len(auditRecords) != 5 {
		t.Fatalf("expected configure/create+activate+configure/update+disable+archive audits, got %d", len(auditRecords))
	}
	auditJSON, _ := json.Marshal(auditRecords)
	if bytes.Contains(auditJSON, []byte("test-ak")) || bytes.Contains(auditJSON, []byte("test-sk")) {
		t.Fatal("audit leaked credentials")
	}
}

func TestImageModerationManualDedupePermissionsAndUnifiedPartial(t *testing.T) {
	svc, db, mock, admin := setupImageModerationTest(t)
	enableImageModerationTest(t, svc, admin, moderationTestRequest())
	resource := addImageModerationResource(t, svc, "user-1", "image-1")
	mock.results["aigcCheck"] = moderation.Result{RiskLevel: "high", RiskTags: []moderation.RiskTag{{Code: "violence", Label: "暴力内容", Level: "high"}}, RequestID: "mock-high"}
	mock.fail["aigcViolationDetection"] = true
	if _, err := svc.CreateImageModerationCheck("user-2", resource.ID); err == nil {
		t.Fatal("cross-user create permitted")
	}
	report, err := svc.CreateImageModerationCheck("user-1", resource.ID)
	if err != nil {
		t.Fatal(err)
	}
	repeated, err := svc.CreateImageModerationCheck("user-1", resource.ID)
	if err != nil || !repeated.Reused || report.CheckID != repeated.CheckID {
		t.Fatalf("dedupe: %+v %v", repeated, err)
	}
	if len(mock.calls) != 0 {
		t.Fatal("admission synchronously called provider")
	}
	if _, err := svc.ImageModerationCheck("user-2", report.CheckID); err == nil {
		t.Fatal("cross-user report permitted")
	}
	if _, err := svc.LatestImageModerationCheck("user-2", resource.ID); err == nil {
		t.Fatal("cross-user latest permitted")
	}
	if err := svc.repo.DeleteResource("user-1", resource.ID); !errors.Is(err, repository.ErrImageModerationReferenced) {
		t.Fatalf("in-flight resource deletion: %v", err)
	}
	processImageModerationTest(t, svc)
	result, err := svc.ImageModerationCheck("user-1", report.CheckID)
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "partial" || result.OverallRisk != "high" || len(result.RiskTags) != 1 || !result.IsCurrent {
		t.Fatalf("unified result %+v", result)
	}
	if len(mock.calls) != 2 {
		t.Fatalf("provider calls = %d", len(mock.calls))
	}
	var usage model.ImageModerationDailyUsage
	if err := db.First(&usage).Error; err != nil || usage.Calls != 2 {
		t.Fatalf("usage %+v %v", usage, err)
	}
	var items []model.ImageModerationItem
	if err := db.Find(&items).Error; err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(items)
	if bytes.Contains(encoded, []byte("secret must")) {
		t.Fatal("raw provider error persisted")
	}
	encoded, _ = json.Marshal(result)
	for _, value := range []string{"aliyun", "cn-shanghai", "aigcCheck", "test-ak", "test-sk"} {
		if bytes.Contains(encoded, []byte(value)) {
			t.Fatalf("user response exposed %s", value)
		}
	}
	if err := svc.repo.DeleteResource("user-1", resource.ID); err != nil {
		t.Fatal(err)
	}
}

func TestImageModerationUsesAdmittedConfigurationAndLatestReport(t *testing.T) {
	svc, db, mock, admin := setupImageModerationTest(t)
	view := enableImageModerationTest(t, svc, admin, moderationTestRequest())
	resource := addImageModerationResource(t, svc, "user-1", "image-1")
	report, err := svc.CreateImageModerationCheck("user-1", resource.ID)
	if err != nil {
		t.Fatal(err)
	}
	req := moderationTestRequest()
	req.Region = "cn-beijing"
	req.Services = []string{"aigcCheck"}
	req.AccessKeySecret = "new-secret"
	next, err := svc.SaveImageModerationProvider(admin, view.ID, req)
	if err != nil {
		t.Fatal(err)
	}
	state, err := svc.AdminImageModeration(admin)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := svc.ActivateImageModerationProvider(admin, view.ID, ImageModerationActivationRequest{ConfigID: next.ConfigID, ExpectedRevision: state.PolicyRevision}); err != nil {
		t.Fatal(err)
	}
	processImageModerationTest(t, svc)
	if len(mock.calls) != 2 || mock.configs[0].Region != "cn-shanghai" || mock.configs[0].AccessKeySecret != "test-sk" {
		t.Fatal("in-flight check mixed configuration versions")
	}
	old, err := svc.ImageModerationCheck("user-1", report.CheckID)
	if err != nil || old.IsCurrent {
		t.Fatalf("old config current: %+v %v", old, err)
	}
	ageImageModerationChecks(t, db)
	mock.fail["aigcCheck"] = true
	newReport, err := svc.CreateImageModerationCheck("user-1", resource.ID)
	if err != nil {
		t.Fatal(err)
	}
	processImageModerationTest(t, svc)
	latest, err := svc.LatestImageModerationCheck("user-1", resource.ID)
	if err != nil {
		t.Fatal(err)
	}
	if latest.CheckID != newReport.CheckID || latest.Status != "failed" || latest.OverallRisk != "unknown" {
		t.Fatalf("old clean result replaced latest failure: %+v", latest)
	}
	if len(mock.calls) != 3 || mock.configs[2].Region != "cn-beijing" {
		t.Fatal("new config not used")
	}
}

func TestImageModerationGlobalBudgetAndInterval(t *testing.T) {
	svc, db, mock, admin := setupImageModerationTest(t)
	req := moderationTestRequest()
	req.MaxCallsPerDay = 1
	enableImageModerationTest(t, svc, admin, req)
	resource := addImageModerationResource(t, svc, "user-1", "image-1")
	report, err := svc.CreateImageModerationCheck("user-1", resource.ID)
	if err != nil {
		t.Fatal(err)
	}
	second := addImageModerationResource(t, svc, "user-1", "image-2")
	if _, err := svc.CreateImageModerationCheck("user-1", second.ID); err == nil {
		t.Fatal("per-user interval bypassed")
	}
	processImageModerationTest(t, svc)
	result, err := svc.ImageModerationCheck("user-1", report.CheckID)
	if err != nil {
		t.Fatal(err)
	}
	if len(mock.calls) != 1 || result.Status != "partial" || result.OverallRisk != "unknown" {
		t.Fatalf("budget should produce incomplete unknown: %+v, calls=%d", result, len(mock.calls))
	}
	ageImageModerationChecks(t, db)
	req.Name = "Another provider"
	enableImageModerationTest(t, svc, admin, req)
	other, err := svc.CreateImageModerationCheck("user-1", second.ID)
	if err != nil {
		t.Fatal(err)
	}
	processImageModerationTest(t, svc)
	result, err = svc.ImageModerationCheck("user-1", other.CheckID)
	if err != nil {
		t.Fatal(err)
	}
	if len(mock.calls) != 1 || result.Status != "failed" {
		t.Fatal("provider switch bypassed global daily budget")
	}
}

func TestImageModerationRecoveryDoesNotReplayStartedItem(t *testing.T) {
	svc, db, mock, admin := setupImageModerationTest(t)
	enableImageModerationTest(t, svc, admin, moderationTestRequest())
	resource := addImageModerationResource(t, svc, "user-1", "image-1")
	report, err := svc.CreateImageModerationCheck("user-1", resource.ID)
	if err != nil {
		t.Fatal(err)
	}
	check, err := svc.repo.ClaimImageModerationCheck("crashed-worker", imageModerationLease)
	if err != nil {
		t.Fatal(err)
	}
	items, err := svc.repo.ImageModerationItems(check.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := svc.repo.BeginImageModerationItem(check.ID, items[0].ID, "crashed-worker", 100, imageModerationLease); err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.ImageModerationCheck{}).Where("id = ?", check.ID).Update("lease_expires_at", time.Now().UTC().Add(-time.Minute)).Error; err != nil {
		t.Fatal(err)
	}
	processImageModerationTest(t, svc)
	result, err := svc.ImageModerationCheck("user-1", report.CheckID)
	if err != nil {
		t.Fatal(err)
	}
	if len(mock.calls) != 1 || mock.calls[0] == items[0].Service || result.Status != "partial" || result.OverallRisk != "unknown" {
		t.Fatalf("uncertain call replayed: %+v calls=%v", result, mock.calls)
	}
	items, err = svc.repo.ImageModerationItems(check.ID)
	if err != nil {
		t.Fatal(err)
	}
	if items[0].ErrorCode != "execution_uncertain" {
		t.Fatalf("started item not uncertain: %+v", items[0])
	}
	var usage model.ImageModerationDailyUsage
	if err := db.First(&usage).Error; err != nil || usage.Calls != 2 {
		t.Fatalf("recovery usage %+v %v", usage, err)
	}
}

func TestImageModerationChangedResourceNeverCallsProvider(t *testing.T) {
	svc, db, mock, admin := setupImageModerationTest(t)
	enableImageModerationTest(t, svc, admin, moderationTestRequest())
	resource := addImageModerationResource(t, svc, "user-1", "image-1")
	report, err := svc.CreateImageModerationCheck("user-1", resource.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.Resource{}).Where("id = ?", resource.ID).Update("e_tag", "new-image").Error; err != nil {
		t.Fatal(err)
	}
	processImageModerationTest(t, svc)
	result, err := svc.ImageModerationCheck("user-1", report.CheckID)
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "failed" || result.IsCurrent || len(mock.calls) != 0 {
		t.Fatalf("changed image submitted or current: %+v calls=%d", result, len(mock.calls))
	}
}

func TestImageModerationWorkerRunsQueuedJob(t *testing.T) {
	svc, _, mock, admin := setupImageModerationTest(t)
	enableImageModerationTest(t, svc, admin, moderationTestRequest())
	resource := addImageModerationResource(t, svc, "user-1", "image-1")
	report, err := svc.CreateImageModerationCheck("user-1", resource.ID)
	if err != nil {
		t.Fatal(err)
	}
	ctx, started := svc.backgroundWorkers().Start()
	if !started {
		t.Fatal("worker runtime unavailable")
	}
	svc.startImageModerationWorker(ctx)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := svc.StopWorker(ctx); err != nil {
			t.Error(err)
		}
	})
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		result, err := svc.ImageModerationCheck("user-1", report.CheckID)
		if err != nil {
			t.Fatal(err)
		}
		if result.Status == "completed" {
			mock.mu.Lock()
			calls := len(mock.calls)
			mock.mu.Unlock()
			if calls != 2 {
				t.Fatalf("calls = %d", calls)
			}
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("durable queued check not processed")
}

func TestImageModerationConcurrentClicksReuseOneBatch(t *testing.T) {
	svc, db, mock, admin := setupImageModerationTest(t)
	enableImageModerationTest(t, svc, admin, moderationTestRequest())
	resource := addImageModerationResource(t, svc, "user-1", "image-1")
	var workers sync.WaitGroup
	reports := make(chan *ImageModerationReport, 8)
	failures := make(chan error, 8)
	for index := 0; index < 8; index++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			report, err := svc.CreateImageModerationCheck("user-1", resource.ID)
			if err != nil {
				failures <- err
			} else {
				reports <- report
			}
		}()
	}
	workers.Wait()
	close(failures)
	close(reports)
	for err := range failures {
		t.Errorf("concurrent click: %v", err)
	}
	unique := ""
	for report := range reports {
		if unique == "" {
			unique = report.CheckID
		}
		if report.CheckID != unique {
			t.Fatal("concurrent clicks admitted duplicate batch")
		}
	}
	var count int64
	if err := db.Model(&model.ImageModerationCheck{}).Count(&count).Error; err != nil || count != 1 {
		t.Fatalf("reports = %d, %v", count, err)
	}
	processImageModerationTest(t, svc)
	if len(mock.calls) != 2 {
		t.Fatalf("calls = %d", len(mock.calls))
	}
}

func TestImageModerationCredentialRotationRepairsUnreadableOldConfig(t *testing.T) {
	svc, db, mock, admin := setupImageModerationTest(t)
	view := enableImageModerationTest(t, svc, admin, moderationTestRequest())
	if err := db.Model(&model.ImageModerationConfig{}).Where("id = ?", view.ConfigID).Update("access_key_secret_encrypted", encryptedSettingPrefix+"broken").Error; err != nil {
		t.Fatal(err)
	}
	req := moderationTestRequest()
	req.AccessKeyID = ""
	req.AccessKeySecret = ""
	if _, err := svc.SaveImageModerationProvider(admin, view.ID, req); err == nil {
		t.Fatal("unreadable preserved credential silently accepted")
	}
	req.AccessKeyID = "rotated-ak"
	req.AccessKeySecret = "rotated-sk"
	next, err := svc.SaveImageModerationProvider(admin, view.ID, req)
	if err != nil {
		t.Fatal(err)
	}
	record, err := svc.repo.ImageModerationConfig(next.ConfigID)
	if err != nil {
		t.Fatal(err)
	}
	config, err := svc.imageModerationDomainConfig(record)
	if err != nil {
		t.Fatal(err)
	}
	if config.AccessKeyID != "rotated-ak" || config.AccessKeySecret != "rotated-sk" || len(mock.calls) != 0 {
		t.Fatal("credential rotation failed or made a paid call")
	}
}

func TestImageModerationLatestFailedBatchSupersedesOlderCleanResult(t *testing.T) {
	svc, db, mock, admin := setupImageModerationTest(t)
	enableImageModerationTest(t, svc, admin, moderationTestRequest())
	resource := addImageModerationResource(t, svc, "user-1", "image-1")
	first, err := svc.CreateImageModerationCheck("user-1", resource.ID)
	if err != nil {
		t.Fatal(err)
	}
	processImageModerationTest(t, svc)
	ageImageModerationChecks(t, db)
	mock.fail["aigcCheck"] = true
	mock.fail["aigcViolationDetection"] = true
	second, err := svc.CreateImageModerationCheck("user-1", resource.ID)
	if err != nil {
		t.Fatal(err)
	}
	processImageModerationTest(t, svc)
	older, err := svc.ImageModerationCheck("user-1", first.CheckID)
	if err != nil {
		t.Fatal(err)
	}
	latest, err := svc.LatestImageModerationCheck("user-1", resource.ID)
	if err != nil {
		t.Fatal(err)
	}
	if older.IsCurrent || latest.CheckID != second.CheckID || !latest.IsCurrent || latest.Status != "failed" || latest.OverallRisk != "unknown" {
		t.Fatalf("old green remained current: old=%+v latest=%+v", older, latest)
	}
}

func TestImageModerationRejectsInvalidAndOversizedPixelsBeforeCloudAdmission(t *testing.T) {
	svc, db, mock, admin := setupImageModerationTest(t)
	enableImageModerationTest(t, svc, admin, moderationTestRequest())
	for _, testCase := range []struct {
		name          string
		width, height uint32
		broken        bool
	}{{name: "long-edge", width: 16385, height: 2}, {name: "pixel-count", width: 16000, height: 16000}, {name: "broken-file", broken: true}} {
		t.Run(testCase.name, func(t *testing.T) {
			resource := addImageModerationResource(t, svc, "user-1", testCase.name)
			fileName := filepath.Join(svc.dataDir, "resources", resource.ObjectKey)
			data, err := os.ReadFile(fileName)
			if err != nil {
				t.Fatal(err)
			}
			if testCase.broken {
				data = []byte("not an image")
			} else {
				binary.BigEndian.PutUint32(data[16:20], testCase.width)
				binary.BigEndian.PutUint32(data[20:24], testCase.height)
				binary.BigEndian.PutUint32(data[29:33], crc32.ChecksumIEEE(data[12:29]))
			}
			if err := os.WriteFile(fileName, data, 0o600); err != nil {
				t.Fatal(err)
			}
			if _, err := svc.CreateImageModerationCheck("user-1", resource.ID); err == nil {
				t.Fatal("invalid image admitted")
			}
		})
	}
	var count int64
	if err := db.Model(&model.ImageModerationCheck{}).Count(&count).Error; err != nil || count != 0 || len(mock.calls) != 0 {
		t.Fatalf("invalid images created checks/calls: %d/%d, %v", count, len(mock.calls), err)
	}
}
