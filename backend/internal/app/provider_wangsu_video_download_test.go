package app

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"yingce/backend/internal/protocol"
)

func TestWangsuVideoRecoveryDownloadsOriginalTask(t *testing.T) {
	allowLoopbackProviderTest(t)
	registry := loadOfficialFallbackRegistry()
	encodedModel := hex.EncodeToString([]byte("doubao-seedance-2-5-260628"))
	taskID := "video.50623." + encodedModel + "." + hex.EncodeToString([]byte("video.56943."+encodedModel+".cgt-20261112104158-test0"))
	if len(taskID) != 243 {
		t.Fatalf("fixture task ID length = %d, want 243", len(taskID))
	}
	videoBytes := []byte("\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom")
	const rejectedBody = `{"error":{"type":"aigateway_error","code":"invalid_video_id","message":"channel not found for video id"}}`

	for _, provider := range []struct{ id, path, model string }{
		{"wangsu-videos", "/videos", "doubao-seedance-2-5-260628"},
		{"wangsu-openai-videos", "/openai/videos", "sora-2"},
	} {
		for _, rejected := range []bool{false, true} {
			name := provider.id + "/video"
			if rejected {
				name = provider.id + "/download-rejected"
			}
			t.Run(name, func(t *testing.T) {
				adapter, ok := registry.Resolve(provider.id)
				if !ok {
					t.Fatalf("official adapter %s missing", provider.id)
				}
				var creates, polls, downloads atomic.Int32
				basePath := "/v2/llm" + provider.path
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					if r.Header.Get("Authorization") != "Bearer test-key" {
						t.Error("original task query or download lost Bearer authentication")
						http.Error(w, "unauthorized", http.StatusUnauthorized)
						return
					}
					if r.Method == http.MethodPost {
						creates.Add(1)
						http.Error(w, "recovery must not create another task", http.StatusConflict)
						return
					}
					if r.Method != http.MethodGet {
						t.Errorf("unexpected recovery method: %s", r.Method)
						http.Error(w, "unexpected method", http.StatusMethodNotAllowed)
						return
					}
					switch r.URL.Path {
					case basePath + "/" + taskID:
						polls.Add(1)
						w.Header().Set("Content-Type", "application/json")
						_ = json.NewEncoder(w).Encode(map[string]any{"id": taskID, "status": "completed"})
					case basePath + "/" + taskID + "/content":
						downloads.Add(1)
						// The gateway rejects restrictive media Accept headers even
						// for completed tasks. Leave result content negotiation unset.
						if accept := r.Header.Get("Accept"); accept != "" {
							t.Errorf("download Accept = %q, want no Accept header", accept)
						}
						if rejected || r.Header.Get("Accept") != "" {
							w.Header().Set("Content-Type", "application/json")
							w.WriteHeader(http.StatusBadRequest)
							_, _ = w.Write([]byte(rejectedBody))
							return
						}
						w.Header().Set("Content-Type", "video/mp4")
						_, _ = w.Write(videoBytes)
					default:
						t.Errorf("unexpected original task path: %s", r.URL.Path)
						http.NotFound(w, r)
					}
				}))
				defer server.Close()

				input := canvasGenerationInput{
					Mode: "video",
					Config: providerConfig{
						InterfaceType: provider.id, BaseURL: server.URL + "/v2/llm",
						APIKey: "test-key", Model: provider.model,
					},
				}
				result, status, err := queryProtocolAdapterVideoTask(context.Background(), input, adapter, taskID)
				if creates.Load() != 0 || polls.Load() != 1 || downloads.Load() != 1 {
					t.Fatalf("recovery calls=create:%d poll:%d download:%d", creates.Load(), polls.Load(), downloads.Load())
				}
				if status != string(protocol.StatusSucceeded) {
					t.Fatalf("original task status = %q, want succeeded", status)
				}
				if rejected {
					var httpErr providerHTTPError
					if !errors.As(err, &httpErr) || httpErr.StatusCode != http.StatusBadRequest || httpErr.Body != rejectedBody || result != nil {
						t.Fatalf("JSON download rejection became a video: result=%#v err=%v", result, err)
					}
					return
				}
				if err != nil {
					t.Fatal(err)
				}
				video, ok := result["video"].(map[string]interface{})
				if !ok || result["mode"] != "video" || video["mimeType"] != "video/mp4" || video["dataUrl"] != dataURL("video/mp4", videoBytes) {
					t.Fatalf("original video bytes or MIME changed: %#v", result)
				}
			})
		}
	}
}
