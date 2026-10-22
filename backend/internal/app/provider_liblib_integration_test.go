package app

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha1"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"yingce/backend/internal/generation"
	"yingce/backend/internal/model"
	"yingce/backend/internal/platform"
	"yingce/backend/internal/protocol"
)

func TestLiblibAPILogRetainsAcceptedTaskAndAuditState(t *testing.T) {
	s := &Service{}
	for _, test := range []struct {
		state  int
		want   string
		failed bool
	}{{1, "pending", false}, {2, "processing", false}, {3, "processing", false}, {4, "processing", false}, {5, "succeeded", false}, {6, "failed", true}, {7, "expired", true}} {
		t.Run(fmt.Sprint(test.state), func(t *testing.T) {
			log := model.ApiCallLog{Capability: "image", Path: "/api/generate/webui/status", RequestKind: "poll", Status: model.ApiCallStatusSucceeded, ProviderRequestID: "liblib-existing"}
			s.EnrichAPICallLog(&log, []byte(fmt.Sprintf(`{"code":0,"data":{"generateUuid":"liblib-existing","generateStatus":%d,"generateMsg":"fixture failure"}}`, test.state)))
			if log.ProviderRequestID != "liblib-existing" || log.ProviderStatus != test.want || (log.Status == model.ApiCallStatusFailed) != test.failed {
				t.Fatalf("unexpected Liblib log state: %+v", log)
			}
			if test.failed && log.Error != "fixture failure" {
				t.Fatalf("lost upstream failure: %q", log.Error)
			}
		})
	}
	for _, identity := range []string{"", "liblib-existing"} {
		log := model.ApiCallLog{Capability: "image", Path: "/api/generate/webui/status", RequestKind: "poll", Status: model.ApiCallStatusSucceeded, ProviderRequestID: identity}
		s.EnrichAPICallLog(&log, []byte(`{"code":0,"data":{"generateUuid":"wrong-task","id":"wrong-generic-id","generateStatus":4,"status":"succeeded"}}`))
		if log.ProviderRequestID != identity || log.ProviderStatus != "processing" {
			t.Fatal("unvalidated poll response replaced the accepted task identity or status")
		}
	}
	log := model.ApiCallLog{Capability: "image", Path: "/unrelated", Status: model.ApiCallStatusSucceeded}
	s.EnrichAPICallLog(&log, []byte(`{"code":0,"data":{"generateUuid":"not-a-liblib-task","generateStatus":6}}`))
	if log.ProviderRequestID != "" || log.Status != model.ApiCallStatusSucceeded {
		t.Fatal("Liblib state interpretation escaped its protocol paths")
	}
}

// All HTTP endpoints are loopback fixtures. The test covers the real host upload,
// signed create/poll, persisted task identity, and final resource materialization.
func TestLiblibControlledTaskResumesAndSavesOnlyMaskedPNG(t *testing.T) {
	testLiblibControlledTaskRecovery(t, false)
}

func TestLiblibInpaintTaskResumesWithIndependentOutputMask(t *testing.T) {
	testLiblibControlledTaskRecovery(t, true)
}

func TestLiblibCannyPreparationChangesOnlyTransparentControlUploads(t *testing.T) {
	for _, remote := range []bool{false, true} {
		t.Run(fmt.Sprintf("remote=%v", remote), func(t *testing.T) {
			t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
			transparent := outputMaskPNG(t, outputMaskRow(color.NRGBA{R: 255, G: 255, B: 255}, color.NRGBA{R: 255, A: 255}, color.NRGBA{G: 255, A: 255}))
			opaque := outputMaskPNG(t, outputMaskRow(color.NRGBA{R: 8, G: 51, B: 219, A: 255}))
			uploads := make(chan []byte, 4)
			var signatures atomic.Int32
			var server *httptest.Server
			server = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/transparent.png":
					w.Header().Set("Content-Type", "image/png")
					_, _ = w.Write(transparent)
				case "/opaque.png":
					w.Header().Set("Content-Type", "image/png")
					_, _ = w.Write(opaque)
				case "/api/generate/upload/signature":
					_ = json.NewEncoder(w).Encode(map[string]any{"code": 0, "data": map[string]any{"key": fmt.Sprintf("inputs/%d.png", signatures.Add(1)), "policy": "fixture-policy", "postUrl": server.URL + "/oss", "xossDate": "20260101T000000Z", "xossSignature": "fixture-signature", "xossCredential": "fixture-credential", "xossSignatureVersion": "OSS4-HMAC-SHA256"}})
				case "/oss":
					if err := r.ParseMultipartForm(1 << 20); err != nil {
						t.Error(err)
						w.WriteHeader(http.StatusBadRequest)
						return
					}
					file, _, err := r.FormFile("file")
					if err != nil {
						t.Error(err)
						w.WriteHeader(http.StatusBadRequest)
						return
					}
					data, _ := io.ReadAll(file)
					_ = file.Close()
					uploads <- data
					w.WriteHeader(http.StatusNoContent)
				default:
					t.Errorf("unexpected upstream request: %s", r.URL.Path)
					w.WriteHeader(http.StatusNotFound)
				}
			}))
			defer server.Close()
			transport := OutboundHTTPClient(time.Second).Transport.(*http.Transport)
			originalTLS := transport.TLSClientConfig
			roots := x509.NewCertPool()
			roots.AddCert(server.Certificate())
			transport.TLSClientConfig = &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}
			t.Cleanup(func() { transport.CloseIdleConnections(); transport.TLSClientConfig = originalTLS })
			media := func(name string, data []byte) generation.Media {
				if remote {
					return generation.Media{URL: server.URL + "/" + name + ".png"}
				}
				return generation.Media{DataURL: dataURL("image/png", data)}
			}
			control, controlOpaque := media("transparent", transparent), media("opaque", opaque)
			params := generation.ControlNetParameters{Preprocessor: "canny", Model: "abcdef0123456789abcdef0123456789", Strength: .6, End: .6, ControlMode: "balanced", ResizeMode: "stretch", Canny: &generation.CannyParameters{Resolution: 512, LowThreshold: 100, HighThreshold: 200}}
			input := canvasGenerationInput{
				Mode: "image", Config: providerConfig{InterfaceType: protocol.LiblibImageProtocolID, BaseURL: server.URL, APIKey: "fixture-access", SecretKey: "fixture-secret", Model: "0123456789abcdef0123456789abcdef", Size: "6x2"},
				ReferenceImages: []providerMedia{providerMedia(control)},
				ControlNet:      []generation.ControlNetUnit{{ID: "transparent", Image: control, Mask: &control, Parameters: params}, {ID: "opaque", Image: controlOpaque, Parameters: params}},
				OutputMask:      &generation.OutputMask{Image: control, Mode: "non-black", ResizeMode: "stretch"},
				Metadata:        map[string]any{"providerOptions": map[string]any{protocol.LiblibImageProtocolID: map[string]any{"family": "sd", "templateUuid": "0123456789abcdef0123456789abcdef", "steps": 20, "sampler": 0, "cfgScale": 7, "denoisingStrength": .75}}},
			}
			original, _ := json.Marshal(input)
			request := protocolRequestFromInput(input)
			before, _ := json.Marshal(request)
			prepared, err := prepareLiblibProtocolRequest(context.Background(), input, request)
			if err != nil {
				t.Fatal(err)
			}
			after, _ := json.Marshal(request)
			current, _ := json.Marshal(input)
			if !bytes.Equal(before, after) || !bytes.Equal(original, current) {
				t.Fatal("preparation mutated source, output mask, or original request references")
			}
			if prepared.ControlNet[0].Image.URL == prepared.Images[0].URL || prepared.ControlNet[0].Mask.URL != prepared.Images[0].URL || prepared.ControlNet[0].Image.Metadata["width"] != 3 || prepared.ControlNet[0].Image.Metadata["height"] != 1 {
				t.Fatal("Canny control was not isolated from content and control mask")
			}
			if remote {
				if signatures.Load() != 1 || prepared.Images[0].URL != control.URL || prepared.ControlNet[1].Image.URL != controlOpaque.URL {
					t.Fatal("remote transparent control must be uploaded, while source and opaque control retain their addresses")
				}
			} else {
				if signatures.Load() != 3 || !bytes.Equal(<-uploads, transparent) {
					t.Fatal("ordinary content must upload its original transparent bytes")
				}
			}
			flattened, err := png.Decode(bytes.NewReader(<-uploads))
			if err != nil {
				t.Fatal(err)
			}
			for x, want := range []color.NRGBA{{A: 255}, {R: 255, A: 255}, {G: 255, A: 255}} {
				if color.NRGBAModel.Convert(flattened.At(x, 0)).(color.NRGBA) != want {
					t.Fatalf("Canny pixel %d has hidden RGB or lost its visible color", x)
				}
			}
			if !remote && !bytes.Equal(<-uploads, opaque) {
				t.Fatal("opaque control upload was re-encoded")
			}
		})
	}
}

func testLiblibControlledTaskRecovery(t *testing.T, inpaint bool) {
	t.Helper()
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	s, db := newMediaRecoveryTestService(t)
	s.coordinator = platform.NewCoordinatorWithRedis(nil, "fixture-worker")
	registry := s.protocolRegistry()
	adapter, installed := registry.Resolve(protocol.LiblibImageProtocolID)
	if !installed || adapter.Metadata().Execution != "host:liblib-image" || !adapter.Metadata().SupportsControlNet {
		t.Fatal("official Liblib plugin package did not load its host adapter")
	}
	const accessKey, secretKey = "fixture-access", "fixture-secret"
	const policySecret, signatureSecret, credentialSecret = "fixture-oss-policy", "fixture-oss-signature", "fixture-oss-credential"
	var signatures, uploads, creates, polls, downloads atomic.Int32
	var server *httptest.Server
	generated := image.NewNRGBA(image.Rect(0, 0, 6, 2))
	for y := 0; y < 2; y++ {
		for x := 0; x < 6; x++ {
			generated.SetNRGBA(x, y, color.NRGBA{R: 255, G: 255, B: 255, A: 255})
		}
	}
	generatedBytes := outputMaskPNG(t, generated)
	controlBytes := outputMaskPNG(t, outputMaskRow(color.NRGBA{R: 255, A: 255}, color.NRGBA{G: 255, A: 255}, color.NRGBA{B: 255, A: 255}))
	wantUploads := int32(1)
	if inpaint {
		wantUploads = 2
	}
	assertSigned := func(r *http.Request) {
		q := r.URL.Query()
		mac := hmac.New(sha1.New, []byte(secretKey))
		_, _ = mac.Write([]byte(r.URL.EscapedPath() + "&" + q.Get("Timestamp") + "&" + q.Get("SignatureNonce")))
		if q.Get("AccessKey") != accessKey || q.Get("Timestamp") == "" || q.Get("SignatureNonce") == "" || q.Get("Signature") != base64.RawURLEncoding.EncodeToString(mac.Sum(nil)) {
			t.Errorf("missing or invalid signature on %s", r.URL.Path)
		}
		if r.Method != http.MethodPost || r.Header.Get("X-Upstream-Custom") != "fixture-custom-header" {
			t.Errorf("API request lost method/custom header on %s", r.URL.Path)
		}
	}
	writeJSON := func(w http.ResponseWriter, data any) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"code": 0, "data": data})
	}
	server = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/generate/upload/signature":
			assertSigned(r)
			key := "references/control.png"
			if signatures.Add(1) == 2 && inpaint {
				key = "references/repaint.png"
			}
			writeJSON(w, map[string]any{"key": key, "policy": policySecret, "postUrl": server.URL + "/oss", "xossDate": "20260101T000000Z", "xossExpires": "3600", "xossSignature": signatureSecret, "xossCredential": credentialSecret, "xossSignatureVersion": "OSS4-HMAC-SHA256"})
		case "/oss":
			uploads.Add(1)
			if r.Method != http.MethodPost || r.URL.RawQuery != "" || r.Header.Get("Authorization") != "" || r.Header.Get("X-Upstream-Custom") != "" {
				t.Error("OSS upload inherited API credentials or channel headers")
			}
			reader, err := r.MultipartReader()
			if err != nil {
				t.Error(err)
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			fields := map[string]string{}
			lastPart := ""
			for {
				part, err := reader.NextPart()
				if err == io.EOF {
					break
				}
				if err != nil {
					t.Error(err)
					break
				}
				content, _ := io.ReadAll(part)
				lastPart = part.FormName()
				if lastPart == "file" {
					if inpaint && fields["key"] == "references/repaint.png" {
						mask, err := png.Decode(bytes.NewReader(content))
						if err != nil || mask.Bounds().Dx() != 3 || mask.Bounds().Dy() != 1 {
							t.Errorf("invalid inpaint mask upload: %v", err)
						} else {
							for x, want := range []uint32{0, 0xffff, 0} {
								r, g, b, a := mask.At(x, 0).RGBA()
								if r != want || g != want || b != want || a != 0xffff {
									t.Errorf("uploaded mask pixel %d did not convert alpha to white=repaint", x)
								}
							}
						}
					} else if !bytes.Equal(content, controlBytes) {
						t.Error("uploaded bytes differ from owned control resource")
					}
				} else {
					fields[lastPart] = string(content)
				}
			}
			validKey := fields["key"] == "references/control.png" || inpaint && fields["key"] == "references/repaint.png"
			if lastPart != "file" || fields["policy"] != policySecret || fields["x-oss-signature"] != signatureSecret || fields["x-oss-credential"] != credentialSecret || !validKey {
				t.Error("invalid OSS form or file was not the final part")
			}
			w.WriteHeader(http.StatusNoContent)
		case "/api/generate/webui/text2img", "/api/generate/webui/img2img":
			assertSigned(r)
			creates.Add(1)
			var body struct {
				GenerateParams struct {
					SourceImage  string `json:"sourceImage"`
					Mode         int    `json:"mode"`
					InpaintParam *struct {
						MaskImage string `json:"maskImage"`
					} `json:"inpaintParam"`
					ControlNet []struct {
						SourceImage string `json:"sourceImage"`
						MaskImage   string `json:"maskImage"`
						Width       int    `json:"width"`
						Height      int    `json:"height"`
						ResizeMode  int    `json:"resizeMode"`
					} `json:"controlNet"`
				} `json:"generateParams"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error(err)
			}
			if inpaint {
				params := body.GenerateParams
				if r.URL.Path != "/api/generate/webui/img2img" || params.Mode != 4 || params.SourceImage != server.URL+"/oss/references/control.png" || params.InpaintParam == nil || params.InpaintParam.MaskImage != server.URL+"/oss/references/repaint.png" {
					t.Errorf("incorrect prepared inpaint request: %+v", params)
				}
			} else if r.URL.Path != "/api/generate/webui/text2img" || body.GenerateParams.InpaintParam != nil {
				t.Error("output mask or ControlNet mask enabled inpainting")
			}
			units := body.GenerateParams.ControlNet
			if len(units) != 1 || units[0].SourceImage != server.URL+"/oss/references/control.png" || units[0].MaskImage != units[0].SourceImage || units[0].Width != 3 || units[0].Height != 1 || units[0].ResizeMode != 0 {
				t.Errorf("incorrect prepared control request: %+v", units)
			}
			writeJSON(w, map[string]any{"generateUuid": "liblib-existing"})
		case "/api/generate/webui/status":
			assertSigned(r)
			var body map[string]string
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["generateUuid"] != "liblib-existing" {
				t.Error("poll lost original provider task")
			}
			poll := polls.Add(1)
			if poll == 3 {
				w.WriteHeader(http.StatusServiceUnavailable)
				return
			}
			state := 5
			if poll <= 2 {
				state = int(poll) + 2
			}
			writeJSON(w, map[string]any{"generateUuid": "liblib-existing", "generateStatus": state, "images": []any{map[string]any{"imageUrl": server.URL + "/generated.png", "auditStatus": 3}}})
		case "/generated.png":
			if polls.Load() < 4 {
				t.Error("downloaded a result before generation and audit completed")
			}
			downloads.Add(1)
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write(generatedBytes)
		default:
			t.Errorf("unexpected upstream request: %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()
	// Trust only this fixture's certificate, retaining production HTTPS checks.
	transport := OutboundHTTPClient(time.Second).Transport.(*http.Transport)
	originalTLS := transport.TLSClientConfig
	roots := x509.NewCertPool()
	roots.AddCert(server.Certificate())
	transport.TLSClientConfig = &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}
	t.Cleanup(func() { transport.CloseIdleConnections(); transport.TLSClientConfig = originalTLS })
	config := providerConfig{InterfaceType: protocol.LiblibImageProtocolID, BaseURL: server.URL, APIKey: accessKey, SecretKey: secretKey, Model: "0123456789abcdef0123456789abcdef", Size: "6x2", Count: "1", Headers: []OutboundHeader{{Name: "X-Upstream-Custom", Value: "fixture-custom-header"}}}
	task := seedMediaTask(t, db, config)
	seedTaskOutputMask(t, s, db, task, outputMaskRow(color.NRGBA{R: 255, G: 255, B: 255, A: 255}, color.NRGBA{R: 128, G: 128, B: 128, A: 255}, color.NRGBA{A: 255}), "luminance")
	resource, _, err := s.storeResource(task.UserID, "image", "control.png", "image/png", int64(len(controlBytes)), 3, 1, 0, bytes.NewReader(controlBytes), nil, true)
	if err != nil {
		t.Fatal(err)
	}
	var input canvasGenerationInput
	if err := json.Unmarshal([]byte(task.InputJSON), &input); err != nil {
		t.Fatal(err)
	}
	control := generation.Media{StorageKey: "resource:" + resource.ID, Width: 3, Height: 1, MimeType: "image/png"}
	input.ControlNet = []generation.ControlNetUnit{{ID: "screen", Image: control, Mask: &control, Parameters: generation.ControlNetParameters{Preprocessor: "canny", Model: "abcdef0123456789abcdef0123456789", Strength: .6, End: .6, ControlMode: "balanced", ResizeMode: "stretch", Canny: &generation.CannyParameters{Resolution: 512, LowThreshold: 100, HighThreshold: 200}}}}
	input.Metadata = map[string]any{"providerOptions": map[string]any{protocol.LiblibImageProtocolID: map[string]any{"family": "sd", "templateUuid": "0123456789abcdef0123456789abcdef", "steps": 20, "sampler": 0, "cfgScale": 7}}}
	if inpaint {
		maskBytes := outputMaskPNG(t, outputMaskRow(color.NRGBA{A: 255}, color.NRGBA{}, color.NRGBA{A: 255}))
		input.ReferenceImages = []providerMedia{{DataURL: dataURL("image/png", controlBytes)}}
		input.Mask = &providerMedia{DataURL: dataURL("image/png", maskBytes)}
		input.Metadata["providerOptions"].(map[string]any)[protocol.LiblibImageProtocolID].(map[string]any)["denoisingStrength"] = 0.75
	}
	encoded, _ := json.Marshal(input)
	task.InputJSON = string(encoded)
	if err := db.Model(task).Update("input_json", task.InputJSON).Error; err != nil {
		t.Fatal(err)
	}
	if err := s.hydrateControlNetMedia(task.UserID, &input); err != nil {
		t.Fatal(err)
	}
	baseContext, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	ctx := context.WithValue(withProviderAnalytics(withProtocolRegistry(baseContext, registry), s, *task), mediaExecutionTaskKey{}, *task)
	if _, err := runImageTask(ctx, input); err == nil {
		t.Fatal("injected poll failure was ignored")
	}
	if creates.Load() != 1 || signatures.Load() != wantUploads || uploads.Load() != wantUploads || polls.Load() != 3 || downloads.Load() != 0 {
		t.Fatalf("first execution counts create=%d signature=%d upload=%d poll=%d download=%d", creates.Load(), signatures.Load(), uploads.Load(), polls.Load(), downloads.Load())
	}
	saved, err := s.repo.Task(task.ID)
	if err != nil || saved.ProviderRequestID != "liblib-existing" {
		t.Fatalf("accepted provider ID was not persisted for recovery: task=%+v err=%v", saved, err)
	}
	// A new service receives only the persisted input and provider task ID. It
	// must not require hydrated controls or repeat any upload/create operation.
	restarted := &Service{repo: s.repo, dataDir: s.dataDir, activeCancels: make(map[string]context.CancelFunc), coordinator: platform.NewCoordinatorWithRedis(nil, "fixture-restarted-worker")}
	rawInput, err := restarted.decryptTaskInputJSON(saved.InputJSON)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(rawInput), &input); err != nil {
		t.Fatal(err)
	}
	ctx = context.WithValue(withProviderAnalytics(withProtocolRegistry(baseContext, restarted.protocolRegistry()), restarted, *saved), mediaExecutionTaskKey{}, *saved)
	result, err := runImageTask(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	if creates.Load() != 1 || signatures.Load() != wantUploads || uploads.Load() != wantUploads || polls.Load() != 4 || downloads.Load() != 1 {
		t.Fatal("recovery repeated upstream creation/upload or download")
	}
	if err := restarted.finishTaskMediaRecovery(saved, result, nil); err != nil {
		t.Fatal(err)
	}
	completed, _ := restarted.repo.Task(task.ID)
	if completed.Status != model.TaskStatusSucceeded || strings.Contains(completed.ResultJSON, "/generated.png") {
		t.Fatal("task did not complete with a formal local resource")
	}
	output, err := restarted.resourceForUploadKey(task.UserID, mediaUploadKey(task.ID, 0))
	if err != nil || output == nil || output.MimeType != "image/png" || output.Width != 6 || output.Height != 2 {
		t.Fatalf("bad final resource: %+v, %v", output, err)
	}
	_, body, err := restarted.OpenResource(task.UserID, output.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer body.Close()
	picture, err := png.Decode(body)
	if err != nil {
		t.Fatal(err)
	}
	for y := 0; y < 2; y++ {
		for x := 0; x < 6; x++ {
			want := []uint8{255, 255, 128, 128, 0, 0}[x]
			got := color.NRGBAModel.Convert(picture.At(x, y)).(color.NRGBA)
			if got != (color.NRGBA{R: want, G: want, B: want, A: 255}) {
				t.Errorf("masked pixel (%d,%d)=%+v, want %d", x, y, got, want)
			}
		}
	}
	var logs []model.ApiCallLog
	if err := db.Where("task_id = ?", task.ID).Find(&logs).Error; err != nil {
		t.Fatal(err)
	}
	for _, log := range logs {
		if log.RequestKind == "poll" || log.RequestKind == "upload" || log.RequestKind == "upload-signature" {
			if log.Billable || !log.CostAvailable || log.EstimatedCostMicros != 0 {
				t.Errorf("non-generation stage was not explicitly zero cost: %s", log.RequestKind)
			}
		}
		logged := log.UpstreamURL + log.RequestBody + log.ResponseBody + log.Error
		for _, secret := range []string{accessKey, secretKey, policySecret, signatureSecret, credentialSecret} {
			if strings.Contains(logged, secret) {
				t.Errorf("%s log exposed a credential", log.RequestKind)
			}
		}
	}
}
