package model3d

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
)

func TestModel3DBaseURLNormalization(t *testing.T) {
	for _, value := range []string{DefaultBaseURL, "https://openapi.tripo3d.com/v3", "https://EXAMPLE.com:443/v3", "https://8.8.8.8:9443/v3", "https://[2606:4700:4700::1111]/v3"} {
		actual, err := NormalizeBaseURL(" \t" + value + "/// \n")
		if err != nil || actual != value {
			t.Fatalf("valid URL not preserved: %q %v", actual, err)
		}
	}
	for _, value := range []string{"", "http://example.com/v3", "https://user:secret@example.com/v3", "https://example.com/v3?", "https://example.com/v3?key=secret", "https://example.com/v3#", "https://example.com/v3#secret", "https://example.com", "https://example.com/v2", "https://example.com/proxy/v3", "https://example.com/v%33", "https://example.com:/v3", "https://example.com:0/v3", "https://example.com:65536/v3", "https://bad_host/v3", "https://-bad.example/v3", "https://bad..example/v3", "https:///v3", "https://[fe80::1%25eth0]/v3", "https://example.com/\nv3"} {
		if _, err := NormalizeBaseURL(value); err == nil {
			t.Errorf("invalid URL accepted: %q", value)
		} else if strings.Contains(err.Error(), "secret") {
			t.Fatal("invalid URL exposed credential")
		}
	}
}

func TestTripoConfiguredBaseURLAppliesToEveryEndpoint(t *testing.T) {
	for _, baseURL := range []string{"https://8.8.8.8/v3", "https://1.1.1.1:9443/v3"} {
		t.Run(baseURL, func(t *testing.T) {
			paths := []string{}
			provider := &tripoProvider{client: &http.Client{Transport: tripoRoundTrip(func(r *http.Request) (*http.Response, error) {
				if !strings.HasPrefix(r.URL.String(), baseURL+"/") {
					t.Fatalf("ignored config snapshot: %s", r.URL.String())
				}
				paths = append(paths, r.URL.Path)
				switch r.URL.Path {
				case "/v3/files":
					return tripoResponse(200, `{"code":0,"data":{"file_token":"file_fixture"}}`), nil
				case "/v3/tasks/task_fixture":
					return tripoResponse(200, `{"code":0,"data":{"status":"queued","progress":0}}`), nil
				default:
					return tripoResponse(200, `{"code":0,"data":{"task_id":"task_fixture"}}`), nil
				}
			})}}
			config := Config{BaseURL: baseURL + "/"}
			if _, err := provider.Upload(context.Background(), config, Image{FileName: "reference.png", ContentType: "image/png", Data: []byte("png")}); err != nil {
				t.Fatal(err)
			}
			for _, mode := range []string{"text", "image", "multiview"} {
				if _, err := provider.Submit(context.Background(), config, Request{Mode: mode}, map[string]string{"single": "file_fixture", "front": "file_fixture"}); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := provider.Poll(context.Background(), config, "task_fixture", false); err != nil {
				t.Fatal(err)
			}
			if strings.Join(paths, ",") != "/v3/files,/v3/generation/text-to-model,/v3/generation/image-to-model,/v3/generation/multiview-to-model,/v3/tasks/task_fixture" {
				t.Fatalf("request path or count changed: %v", paths)
			}
		})
	}
}

func TestTripoBaseURLBlocksUnsafeTargetsBeforeProxyTransport(t *testing.T) {
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:9999")
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "")
	for _, baseURL := range []string{"", "http://8.8.8.8/v3", "https://user:secret@8.8.8.8/v3", "https://8.8.8.8/v3?token=secret", "https://localhost/v3", "https://127.0.0.1/v3", "https://169.254.169.254/v3", "https://10.0.0.1/v3", "https://[::1]/v3"} {
		t.Run(baseURL, func(t *testing.T) {
			calls := 0
			provider := &tripoProvider{client: &http.Client{Transport: tripoRoundTrip(func(*http.Request) (*http.Response, error) {
				calls++
				return tripoResponse(200, `{"code":0,"data":{"task_id":"unsafe"}}`), nil
			})}}
			_, err := provider.Submit(context.Background(), Config{BaseURL: baseURL, APIKey: "secret-api-key"}, Request{Mode: "text"}, nil)
			var failure *Error
			if !errors.As(err, &failure) || !failure.Definite || calls != 0 || strings.Contains(err.Error(), "secret") {
				t.Fatalf("unsafe URL reached proxy or exposed input: err=%v calls=%d", err, calls)
			}
		})
	}
}
