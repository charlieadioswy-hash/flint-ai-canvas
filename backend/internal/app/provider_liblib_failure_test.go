package app

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"yingce/backend/internal/model"
	"yingce/backend/internal/platform"
	"yingce/backend/internal/protocol"
)

func TestLiblibUploadFailureKeepsStatusAndSafeMessage(t *testing.T) {
	for _, test := range []struct {
		name string
		err  error
		want string
	}{
		{"disabled credential", providerHTTPError{StatusCode: 403, Body: `<Error><Code>InvalidAccessKeyId</Code><Message>private-credential</Message><HostId>private-host</HostId></Error>`}, "Liblib 素材上传服务的存储凭据不可用，请联系供应商或更换渠道"},
		{"other authorization denial", providerHTTPError{StatusCode: 403, Body: `<Error><Code>AccessDenied</Code><Message>private-credential</Message></Error>`}, "Liblib 素材上传被拒绝，请联系供应商或更换渠道"},
		{"malformed authorization response", providerHTTPError{StatusCode: 401, Body: `<private-credential`}, "Liblib 素材上传被拒绝，请联系供应商或更换渠道"},
		{"upstream unavailable", providerHTTPError{StatusCode: 503}, ""},
		{"upload timeout", context.DeadlineExceeded, ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			failure := liblibUploadFailure(test.err)
			if !errors.Is(failure, test.err) {
				t.Fatal("upload failure lost its original cause")
			}
			if routeFailureCode(failure) != routeFailureCode(test.err) || safeRouteRejection(failure) != safeRouteRejection(test.err) {
				t.Fatal("upload message changed route retry classification")
			}
			if test.want == "" {
				if failure != test.err {
					t.Fatal("non-authorization failure changed billing or retry semantics")
				}
				return
			}
			if taskFailureMessage(failure) != test.want {
				t.Fatalf("unsafe or misleading upload message: %q", taskFailureMessage(failure))
			}
			var original, wrapped providerHTTPError
			if !errors.As(test.err, &original) || !errors.As(failure, &wrapped) || original.StatusCode != wrapped.StatusCode {
				t.Fatal("upload failure lost its HTTP status")
			}
		})
	}
}

func TestLiblibSubmissionFailureBoundaries(t *testing.T) {
	for _, uploadRejected := range []bool{true, false} {
		name := "create response timeout"
		if uploadRejected {
			name = "upload rejected before create"
		}
		t.Run(name, func(t *testing.T) {
			t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
			s, db := newMediaRecoveryTestService(t)
			s.coordinator = platform.NewCoordinatorWithRedis(nil, "fixture-worker")
			var signatures, uploads, creates atomic.Int32
			releaseCreate := make(chan struct{})
			var server *httptest.Server
			server = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/api/generate/upload/signature":
					signatures.Add(1)
					_ = json.NewEncoder(w).Encode(map[string]any{"code": 0, "data": map[string]any{"key": "inputs/1.png", "policy": "fixture-policy", "postUrl": server.URL + "/oss", "xossDate": "20260101T000000Z", "xossSignature": "fixture-signature", "xossCredential": "fixture-credential", "xossSignatureVersion": "OSS4-HMAC-SHA256"}})
				case "/oss":
					uploads.Add(1)
					if uploadRejected {
						w.WriteHeader(http.StatusForbidden)
						_, _ = w.Write([]byte(`<Error><Code>InvalidAccessKeyId</Code><Message>fixture-credential is disabled</Message><HostId>private-host</HostId></Error>`))
						return
					}
					w.WriteHeader(http.StatusNoContent)
				default:
					if !strings.HasPrefix(r.URL.Path, "/api/generate/webui/") {
						t.Errorf("unexpected upstream request: %s", r.URL.Path)
						w.WriteHeader(http.StatusNotFound)
						return
					}
					creates.Add(1)
					select {
					case <-r.Context().Done():
					case <-releaseCreate:
					}
				}
			}))
			defer server.Close()
			defer close(releaseCreate)
			transport := OutboundHTTPClient(time.Second).Transport.(*http.Transport)
			originalTLS := transport.TLSClientConfig
			roots := x509.NewCertPool()
			roots.AddCert(server.Certificate())
			transport.TLSClientConfig = &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}
			t.Cleanup(func() { transport.CloseIdleConnections(); transport.TLSClientConfig = originalTLS })
			config := providerConfig{InterfaceType: protocol.LiblibImageProtocolID, BaseURL: server.URL, APIKey: "fixture-access", SecretKey: "fixture-secret", Model: "0123456789abcdef0123456789abcdef", Size: "6x2", Count: "1"}
			task := seedMediaTask(t, db, config)
			input := canvasGenerationInput{
				Mode: "image", Config: config, Prompt: "fixture",
				ReferenceImages: []providerMedia{{DataURL: dataURL("image/png", mediaTestPNG(t))}},
				Metadata:        map[string]any{"providerOptions": map[string]any{protocol.LiblibImageProtocolID: map[string]any{"family": "sd", "templateUuid": "0123456789abcdef0123456789abcdef", "steps": 20, "sampler": 0, "cfgScale": 7, "denoisingStrength": .75}}},
			}
			encoded, _ := json.Marshal(input)
			task.InputJSON = string(encoded)
			if err := db.Model(task).Update("input_json", task.InputJSON).Error; err != nil {
				t.Fatal(err)
			}
			baseContext, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			ctx := withProviderAnalytics(withProtocolRegistry(baseContext, s.protocolRegistry()), s, *task)
			_, failure := runImageTask(ctx, input)
			if failure == nil || signatures.Load() != 1 || uploads.Load() != 1 {
				t.Fatalf("unexpected upload execution: failure=%v signatures=%d uploads=%d", failure, signatures.Load(), uploads.Load())
			}
			if err := s.terminalCoordinator().handleExecutionFailure(task, failure, false, false); !errors.Is(err, failure) {
				t.Fatalf("terminal handling lost failure: %v", err)
			}
			saved, err := s.repo.Task(task.ID)
			if err != nil {
				t.Fatal(err)
			}
			diagnostic := taskExecutionDiagnostic(saved)
			if diagnostic == nil || diagnostic.TaskSubmitted || saved.ProviderRequestID != "" {
				t.Fatalf("unexpected submission identity: %+v", diagnostic)
			}
			if uploadRejected {
				if creates.Load() != 0 || diagnostic.Phase != "preparation" || diagnostic.Code != "preparation_failed" || diagnostic.SubmissionOutcome != "not_submitted" || diagnostic.RetryClass != "new_generation_authorization" {
					t.Fatalf("upload rejection was treated as generation submission: creates=%d diagnostic=%+v", creates.Load(), diagnostic)
				}
				if !strings.Contains(saved.Error, "存储凭据不可用") || s.cloudAgentModelTaskRetryable(task.ID) {
					t.Fatalf("upload failure message or automatic retry changed: %q", saved.Error)
				}
				var call model.ApiCallLog
				if err := db.Where("task_id = ? AND method = ?", task.ID, "INTERNAL").First(&call).Error; err != nil {
					t.Fatal(err)
				}
				if call.Path != "/task/provider-preflight" || call.ErrorCode != "request_not_sent" || call.StatusCode != 403 || call.Billable {
					t.Fatalf("synthetic attempt lost preflight or HTTP facts: %+v", call)
				}
			} else if creates.Load() != 1 || !errors.Is(failure, context.DeadlineExceeded) || diagnostic.Phase != "execution" || diagnostic.SubmissionOutcome != "unknown" || diagnostic.RetryClass != "reconcile_submission" {
				t.Fatalf("sent create lost unknown-result protection: creates=%d diagnostic=%+v failure=%v", creates.Load(), diagnostic, failure)
			}
			var calls []model.ApiCallLog
			if err := db.Where("task_id = ?", task.ID).Find(&calls).Error; err != nil {
				t.Fatal(err)
			}
			for _, call := range calls {
				if (call.RequestKind == "upload" || call.RequestKind == "upload-signature" || call.Method == "INTERNAL") && (call.RequestBody != "" || call.ResponseBody != "") {
					t.Fatal("upload audit exposed credential bodies")
				}
				for _, secret := range []string{"fixture-policy", "fixture-signature", "fixture-credential", "private-host", "fixture-access", "fixture-secret"} {
					if strings.Contains(call.Error+saved.Error+diagnostic.SafeMessage, secret) {
						t.Fatal("upload failure exposed private provider details")
					}
				}
			}
		})
	}
}
