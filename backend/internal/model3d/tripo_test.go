package model3d

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
)

type tripoRoundTrip func(*http.Request) (*http.Response, error)

const tripoTestBaseURL = "https://8.8.8.8/v3"

func (f tripoRoundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func tripoResponse(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body)), Header: make(http.Header)}
}

func TestTripoV3PayloadUsesLabelledViewsAndSingleSubmit(t *testing.T) {
	count := 0
	provider := &tripoProvider{client: &http.Client{Transport: tripoRoundTrip(func(r *http.Request) (*http.Response, error) {
		count++
		if r.URL.String() != tripoTestBaseURL+"/generation/multiview-to-model" || r.Method != "POST" || r.Header.Get("Authorization") != "Bearer test-key" {
			t.Fatalf("bad request: %v", r)
		}
		var payload map[string]json.RawMessage
		if json.NewDecoder(r.Body).Decode(&payload) != nil {
			t.Fatal("bad JSON")
		}
		if payload["files"] != nil || payload["file"] != nil {
			t.Fatal("used SDK legacy input")
		}
		if string(payload["inputs"]) != `[{"front":"front-token"},{"right":"right-token"}]` {
			t.Fatalf("bad mapping: %s", payload["inputs"])
		}
		return tripoResponse(200, `{"code":0,"data":{"task_id":"uuid-without-prefix"}}`), nil
	})}}
	id, err := provider.Submit(context.Background(), Config{BaseURL: tripoTestBaseURL, APIKey: "test-key"}, Request{Mode: "multiview", Parameters: Parameters{Model: "v3.1-20260211", Texture: true, PBR: true}}, map[string]string{"right": "right-token", "front": "front-token"})
	if err != nil || id != "uuid-without-prefix" || count != 1 {
		t.Fatalf("submit: %v %q calls %d", err, id, count)
	}
}

func TestTripoOfficialCreateResponse(t *testing.T) {
	for _, mode := range []string{"text", "image", "multiview"} {
		t.Run(mode, func(t *testing.T) {
			calls := 0
			provider := &tripoProvider{client: &http.Client{Transport: tripoRoundTrip(func(r *http.Request) (*http.Response, error) {
				calls++
				if r.Method != http.MethodPost || r.URL.Path != "/v3/generation/"+mode+"-to-model" {
					t.Fatalf("unexpected creation request: %s %s", r.Method, r.URL.Path)
				}
				return tripoResponse(http.StatusOK, `{"code":0,"data":{"task_id":"task_abc123"}}`), nil
			})}}
			id, err := provider.Submit(context.Background(), Config{BaseURL: tripoTestBaseURL}, Request{Mode: mode, Prompt: "toy truck", Parameters: Parameters{Model: "v3.1-20260211", Texture: true}}, map[string]string{"single": "file_abc123", "front": "file_abc123"})
			if err != nil || id != "task_abc123" || calls != 1 {
				t.Fatalf("creation response: id=%q err=%v calls=%d", id, err, calls)
			}
		})
	}
}

func TestTripoSuccessEnvelopeRequiresExplicitIntegerCodeAndData(t *testing.T) {
	for _, test := range []struct {
		name string
		body string
	}{
		{"missing code", `{"data":{"task_id":"task_abc123"}}`},
		{"null code", `{"code":null,"data":{"task_id":"task_abc123"}}`},
		{"string code", `{"code":"0","data":{"task_id":"task_abc123"}}`},
		{"fraction code", `{"code":0.0,"data":{"task_id":"task_abc123"}}`},
		{"boolean code", `{"code":false,"data":{"task_id":"task_abc123"}}`},
		{"negative code", `{"code":-1,"data":{"task_id":"task_abc123"}}`},
		{"overflow code", `{"code":9223372036854775808,"data":{"task_id":"task_abc123"}}`},
		{"missing data", `{"code":0}`},
		{"null data", `{"code":0,"data":null}`},
		{"scalar data", `{"code":0,"data":"task_abc123"}`},
		{"null body", `null`},
		{"malformed body", `{"code":0,"data":{"task_id":"task_abc123"}`},
	} {
		t.Run(test.name, func(t *testing.T) {
			calls := 0
			provider := &tripoProvider{client: &http.Client{Transport: tripoRoundTrip(func(*http.Request) (*http.Response, error) {
				calls++
				return tripoResponse(http.StatusOK, test.body), nil
			})}}
			id, err := provider.Submit(context.Background(), Config{BaseURL: tripoTestBaseURL}, Request{Mode: "text"}, nil)
			var failure *Error
			if !errors.As(err, &failure) || failure.Code != "provider_response_invalid" || failure.Definite || id != "" || calls != 1 {
				t.Fatalf("invalid response accepted or replayed: id=%q err=%v calls=%d", id, err, calls)
			}
		})
	}
}

func TestTripoErrorEnvelopeKeepsOnlySafeNumericCode(t *testing.T) {
	for _, test := range []struct {
		name     string
		status   int
		body     string
		message  string
		definite bool
	}{
		{"insufficient credits", 403, `{"code":2010,"message":"secret-key","suggestion":"https://private.invalid/?token=secret-token","request_id":"secret-request"}`, "3D 平台拒绝请求（HTTP 403，上游错误码 2010）", true},
		{"invalid parameters", 400, `{"code":2002,"message":"secret-input"}`, "3D 平台拒绝请求（HTTP 400，上游错误码 2002）", true},
		{"rate limit", 429, `{"code":1007,"message":"secret-input"}`, "3D 平台拒绝请求（HTTP 429，上游错误码 1007）", true},
		{"concurrency limit", 429, `{"code":2000,"suggestion":"secret-input"}`, "3D 平台拒绝请求（HTTP 429，上游错误码 2000）", true},
		{"uncertain server error", 500, `{"code":2010,"message":"secret-key"}`, "3D 平台拒绝请求（HTTP 500，上游错误码 2010）", false},
		{"unknown provider code", 200, `{"code":9999,"message":"secret-input"}`, "3D 平台拒绝请求（9999）", false},
		{"business rejection", 200, `{"code":2010,"message":"secret-input"}`, "3D 平台拒绝请求（2010）", true},
		{"string code", 403, `{"code":"2010","message":"secret-key"}`, "3D 平台拒绝请求（HTTP 403）", true},
		{"negative code", 403, `{"code":-2010,"message":"secret-key"}`, "3D 平台拒绝请求（HTTP 403）", true},
		{"null code", 403, `{"code":null,"message":"secret-key"}`, "3D 平台拒绝请求（HTTP 403）", true},
		{"missing code", 403, `{"message":"secret-key"}`, "3D 平台拒绝请求（HTTP 403）", true},
		{"malformed body", 429, `<html>secret-key</html>`, "3D 平台拒绝请求（HTTP 429）", true},
		{"oversized body", 403, strings.Repeat("x", (1<<20)+1), "3D 平台拒绝请求（HTTP 403）", true},
	} {
		t.Run(test.name, func(t *testing.T) {
			calls := 0
			provider := &tripoProvider{client: &http.Client{Transport: tripoRoundTrip(func(*http.Request) (*http.Response, error) {
				calls++
				return tripoResponse(test.status, test.body), nil
			})}}
			id, err := provider.Submit(context.Background(), Config{BaseURL: tripoTestBaseURL, APIKey: "secret-api-key"}, Request{Mode: "text"}, nil)
			var failure *Error
			if !errors.As(err, &failure) || failure.Code != "provider_request_rejected" || failure.Definite != test.definite || failure.Message != test.message || id != "" || calls != 1 {
				t.Fatalf("unexpected rejection: id=%q err=%v calls=%d", id, err, calls)
			}
			if strings.Contains(err.Error(), "secret") || strings.Contains(err.Error(), "private.invalid") {
				t.Fatal("upstream description or credential exposed")
			}
		})
	}
}

func TestTripoPaidPostDoesNotRetryAndTimeoutIsUncertain(t *testing.T) {
	for _, status := range []int{408, 500, 503} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			count := 0
			provider := &tripoProvider{client: &http.Client{Transport: tripoRoundTrip(func(*http.Request) (*http.Response, error) {
				count++
				return tripoResponse(status, `{"code":1000}`), nil
			})}}
			_, err := provider.Submit(context.Background(), Config{BaseURL: tripoTestBaseURL}, Request{Mode: "text"}, nil)
			var value *Error
			if !errors.As(err, &value) || value.Definite || count != 1 {
				t.Fatalf("unsafe replay classification %v count%d", err, count)
			}
		})
	}
	count := 0
	provider := &tripoProvider{client: &http.Client{Transport: tripoRoundTrip(func(*http.Request) (*http.Response, error) { count++; return nil, errors.New("connection lost secret") })}}
	_, err := provider.Submit(context.Background(), Config{BaseURL: tripoTestBaseURL, APIKey: "private-key"}, Request{Mode: "text"}, nil)
	var failure *Error
	if !errors.As(err, &failure) || failure.Definite || failure.Code != "provider_request_uncertain" || count != 1 || strings.Contains(err.Error(), "secret") || strings.Contains(err.Error(), "private-key") {
		t.Fatal("retry or secret exposure")
	}
}

func TestTripoUploadMultipartAndPollFormat(t *testing.T) {
	calls := 0
	provider := &tripoProvider{client: &http.Client{Transport: tripoRoundTrip(func(r *http.Request) (*http.Response, error) {
		calls++
		if r.Method == "POST" {
			if r.URL.Path != "/v3/files" {
				t.Fatal(r.URL.Path)
			}
			if err := r.ParseMultipartForm(1 << 20); err != nil {
				t.Fatal(err)
			}
			file, header, err := r.FormFile("file")
			if err != nil {
				t.Fatal(err)
			}
			defer file.Close()
			data, _ := io.ReadAll(file)
			if header.Filename != "reference.png" || header.Header.Get("Content-Type") != "image/png" || string(data) != "png" {
				t.Fatal("wrong multipart field")
			}
			return tripoResponse(200, `{"code":0,"data":{"file_token":"file_abc123"}}`), nil
		}
		if r.URL.Path != "/v3/tasks/opaque-id" {
			t.Fatal(r.URL.Path)
		}
		return tripoResponse(200, `{"code":0,"data":{"task_id":"opaque-id","type":"image_to_model","status":"success","progress":100,"output":{"model_url":"https://public.invalid/model","rendered_image_url":"https://public.invalid/preview.png"},"credits_consumed":20.00,"created_at":"2026-04-28T12:00:00Z","completed_at":"2026-04-28T12:01:30Z"}}`), nil
	})}}
	token, err := provider.Upload(context.Background(), Config{BaseURL: tripoTestBaseURL}, Image{FileName: "reference.png", ContentType: "image/png", Data: []byte("png")})
	if err != nil || token != "file_abc123" || calls != 1 {
		t.Fatal(err)
	}
	state, err := provider.Poll(context.Background(), Config{BaseURL: tripoTestBaseURL}, "opaque-id", true)
	if err != nil || state.Artifact.Format != "fbx" || state.Artifact.URL != "https://public.invalid/model" || state.Status != "success" || state.Progress != 100 || calls != 2 {
		t.Fatalf("quad must preserve FBX: %v %+v", err, state)
	}
}

func testGLB(document string) []byte {
	chunk := []byte(document)
	for len(chunk)%4 != 0 {
		chunk = append(chunk, ' ')
	}
	data := make([]byte, 20+len(chunk))
	copy(data, "glTF")
	binary.LittleEndian.PutUint32(data[4:], 2)
	binary.LittleEndian.PutUint32(data[8:], uint32(len(data)))
	binary.LittleEndian.PutUint32(data[12:], uint32(len(chunk)))
	binary.LittleEndian.PutUint32(data[16:], 0x4e4f534a)
	copy(data[20:], chunk)
	return data
}
func TestModelFileFormatAndExternalDependencies(t *testing.T) {
	valid := testGLB(`{"asset":{"version":"2.0"},"images":[{"uri":"data:image/png;base64,AA=="}]}`)
	if err := ValidateFile(valid, "glb"); err != nil {
		t.Fatal(err)
	}
	for _, document := range []string{`{"asset":{"version":"2.0"},"images":[{"uri":"https://tracker.invalid/texture.png"}]}`, `{"asset":{"version":"2.0"},"buffers":[{"uri":"../buffer.bin"}]}`} {
		if ValidateFile(testGLB(document), "glb") == nil {
			t.Fatal("external dependency accepted")
		}
	}
	if ValidateFile(valid, "fbx") == nil || ValidateFile([]byte("not model"), "glb") == nil {
		t.Fatal("extension disguised bytes")
	}
	broken := bytes.Clone(valid)
	binary.LittleEndian.PutUint32(broken[8:], uint32(len(broken)+1))
	if ValidateFile(broken, "glb") == nil {
		t.Fatal("truncated GLB accepted")
	}
}

func TestModel3DParameterApplicability(t *testing.T) {
	config := Config{AllowedModels: []string{"v2.5-20250123", "v3.1-20260211"}, AllowedModes: []string{"text", "image", "multiview"}}
	on := true
	for _, parameters := range []Parameters{{Model: "v2.5-20250123", Texture: true, PBR: true, Quad: &on}, {Model: "v2.5-20250123", Texture: true, PBR: true, TextureQuality: "detailed"}, {Model: "v3.1-20260211", Texture: false, PBR: true}, {Model: "v3.1-20260211", Texture: true, PBR: true, TextureQuality: "fast"}} {
		if ValidateParameters("text", "cup", parameters, config) == nil {
			t.Fatalf("invalid params accepted: %+v", parameters)
		}
	}
	if err := ValidateParameters("text", "cup", Parameters{Model: "v2.5-20250123", Texture: true, PBR: true, TextureVersion: "v2.5-20250123"}, config); err != nil {
		t.Fatal(err)
	}
}

func TestModelDownloadNeverForwardsAPIKeyAndRejectsPrivateURL(t *testing.T) {
	data := testGLB(`{"asset":{"version":"2.0"}}`)
	calls := 0
	provider := &tripoProvider{downloadClient: &http.Client{Transport: tripoRoundTrip(func(r *http.Request) (*http.Response, error) {
		calls++
		if r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" {
			t.Fatal("download leaked upstream credential")
		}
		return &http.Response{StatusCode: 200, ContentLength: int64(len(data)), Body: io.NopCloser(bytes.NewReader(data)), Header: make(http.Header)}, nil
	})}}
	result, err := provider.Download(context.Background(), Artifact{URL: "https://8.8.8.8/model?signature=opaque", Format: "glb"})
	if err != nil || !bytes.Equal(result, data) || calls != 1 {
		t.Fatalf("download: %v calls%d", err, calls)
	}
	for _, address := range []string{"https://127.0.0.1/model", "https://169.254.169.254/model", "http://8.8.8.8/model", "https://user:password@8.8.8.8/model"} {
		if _, err := provider.Download(context.Background(), Artifact{URL: address, Format: "glb"}); err == nil {
			t.Fatalf("unsafe URL accepted: %s", address)
		}
	}
	if calls != 1 {
		t.Fatal("invalid URL reached transport")
	}
}
