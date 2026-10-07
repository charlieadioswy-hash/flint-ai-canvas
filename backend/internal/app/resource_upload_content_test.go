package app

import (
	"bytes"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"strings"
	"sync/atomic"
	"testing"

	"infinite-canvas/backend/internal/model"
)

func contentUploadHeader(t *testing.T, data []byte) *multipart.FileHeader {
	t.Helper()
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	h := make(textproto.MIMEHeader)
	h.Set("Content-Disposition", `form-data; name="file"; filename="picture.png"`)
	h.Set("Content-Type", "image/png")
	p, err := w.CreatePart(h)
	if err != nil {
		t.Fatal(err)
	}
	p.Write(data)
	w.Close()
	form, err := multipart.NewReader(&buf, w.Boundary()).ReadForm(1 << 20)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { form.RemoveAll() })
	return form.File["file"][0]
}

func TestUploadContentImportSocket(t *testing.T) {
	t.Setenv("CANVAS_ALLOWED_PRIVATE_UPSTREAM_HOSTS", "127.0.0.1")
	png := mediaTestPNG(t)
	var payload atomic.Value
	payload.Store(png)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/png")
		_, _ = w.Write(payload.Load().([]byte))
	}))
	defer server.Close()
	for _, status := range []model.ResourceStatus{model.ResourceStatusReady, model.ResourceStatusFailed} {
		t.Run(string(status), func(t *testing.T) {
			s := newResourceTestService(t)
			payload.Store(png)
			r, err := s.ImportResourceURL("user", server.URL+"/picture.png", "image", 0, 0, 0, "identity")
			if err != nil {
				t.Fatal(err)
			}
			r.Status = status
			if err := s.repo.SaveResource(r); err != nil {
				t.Fatal(err)
			}
			payload.Store([]byte("<html>" + strings.Repeat(" ", len(png)-6)))
			if _, err := s.ImportResourceURL("user", server.URL+"/picture.png", "image", 0, 0, 0, "identity"); err == nil {
				t.Fatal("changed import content accepted")
			}
			fresh, err := s.ImportResourceURL("user", server.URL+"/picture.png", "image", 0, 0, 0, "fresh-identity")
			if err != nil || fresh.MimeType != "text/html" || fresh.Kind != "file" {
				t.Fatalf("spoofed import: %+v %v", fresh, err)
			}
		})
	}
}

func TestUploadContentDetection(t *testing.T) {
	data := []byte("<html><script>alert(1)</script></html>")
	s := newResourceTestService(t)
	r, err := s.UploadResource("user", contentUploadHeader(t, data), "image", 0, 0, 0)
	if err != nil {
		t.Fatal(err)
	}
	if r.MimeType != "text/html" || r.Kind != "file" {
		t.Fatalf("spoofed content stored as MIME=%s kind=%s", r.MimeType, r.Kind)
	}
}

func TestUploadContentRetryConsistency(t *testing.T) {
	for _, status := range []model.ResourceStatus{model.ResourceStatusReady, model.ResourceStatusFailed} {
		for _, chunked := range []bool{false, true} {
			name := string(status)
			if chunked {
				name += "/chunked"
			} else {
				name += "/multipart"
			}
			t.Run(name, func(t *testing.T) {
				s := newResourceTestService(t)
				png := mediaTestPNG(t)
				r, err := s.UploadResource("user", contentUploadHeader(t, png), "image", 0, 0, 0, "identity")
				if err != nil {
					t.Fatal(err)
				}
				r.Status = status
				if err := s.repo.SaveResource(r); err != nil {
					t.Fatal(err)
				}
				data := []byte("<html>" + strings.Repeat(" ", len(png)-6))
				if chunked {
					_, err = s.UploadResourceFile("user", "picture.png", int64(len(data)), "image", 0, 0, 0, bytes.NewReader(data), "identity")
				} else {
					_, err = s.UploadResource("user", contentUploadHeader(t, data), "image", 0, 0, 0, "identity")
				}
				if err == nil {
					t.Fatal("changed upload content accepted under existing identity")
				}
				stored, err := s.repo.ResourceForUser("user", r.ID)
				if err != nil || stored.Status != status || stored.MimeType != "image/png" {
					t.Fatalf("rejected retry changed resource: %+v %v", stored, err)
				}
				var same *model.Resource
				if chunked {
					same, err = s.UploadResourceFile("user", "picture.png", int64(len(png)), "image", 0, 0, 0, bytes.NewReader(png), "identity")
				} else {
					same, err = s.UploadResource("user", contentUploadHeader(t, png), "image", 0, 0, 0, "identity")
				}
				if err != nil || same.ID != r.ID || same.Status != model.ResourceStatusReady {
					t.Fatalf("valid retry failed: %+v %v", same, err)
				}
			})
		}
	}
}

func TestUploadContentAcceptsAttachments(t *testing.T) {
	for _, tc := range []struct {
		name     string
		data     []byte
		mimeType string
	}{
		{"pdf", []byte("%PDF-1.7\nexample"), "application/pdf"},
		{"svg", []byte(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`), "image/svg+xml"},
		{"unknown", []byte{0, 1, 0, 2, 0, 3}, "application/octet-stream"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s := newResourceTestService(t)
			r, err := s.UploadResourceFile("user", "picture.png", int64(len(tc.data)), "image", 0, 0, 0, bytes.NewReader(tc.data))
			if err != nil {
				t.Fatal(err)
			}
			if r.MimeType != tc.mimeType || r.Kind != "file" {
				t.Fatalf("attachment detection: %+v", r)
			}
			_, body, err := s.OpenResource("user", r.ID)
			if err != nil {
				t.Fatal(err)
			}
			defer body.Close()
			got, err := io.ReadAll(body)
			if err != nil || !bytes.Equal(got, tc.data) {
				t.Fatalf("stored bytes changed: %v", err)
			}
		})
	}
}

func TestUploadContentPreservesModelIdentity(t *testing.T) {
	for _, tc := range []struct {
		name     string
		data     []byte
		mimeType string
		kind     string
	}{
		{"glb", model3DTestGLB(), "model/gltf-binary", "model"},
		{"binary-fbx", append([]byte("Kaydara FBX Binary  \x00\x1a\x00"), 0, 0, 0, 0), "application/octet-stream", "model"},
		{"ascii-fbx", []byte("; FBX 7.4.0 project file\nFBXHeaderExtension: {}"), "application/octet-stream", "model"},
		{"html", []byte("<html><script>alert(1)</script></html>"), "text/html", "file"},
		{"unknown", []byte{0, 1, 0, 2, 0, 3}, "application/octet-stream", "file"},
	} {
		for _, multipartUpload := range []bool{false, true} {
			name := tc.name + "/chunked"
			if multipartUpload {
				name = tc.name + "/multipart"
			}
			t.Run(name, func(t *testing.T) {
				s := newResourceTestService(t)
				var resource *model.Resource
				var err error
				if multipartUpload {
					header := contentUploadHeader(t, tc.data)
					header.Filename = "model.fbx"
					resource, err = s.UploadResource("user", header, "model", 0, 0, 0, "model-upload")
				} else {
					resource, err = s.UploadResourceFile("user", "model.fbx", int64(len(tc.data)), "model", 0, 0, 0, bytes.NewReader(tc.data), "model-upload")
				}
				if err != nil || resource.MimeType != tc.mimeType || resource.Kind != tc.kind {
					t.Fatalf("model content classification: %+v %v", resource, err)
				}
				retried, err := s.UploadResourceFile("user", "model.glb", int64(len(tc.data)), "image", 0, 0, 0, bytes.NewReader(tc.data), "model-upload")
				if err != nil || retried.ID != resource.ID {
					t.Fatalf("content identity changed on retry: %+v %v", retried, err)
				}
				_, body, err := s.OpenResource("user", resource.ID)
				if err != nil {
					t.Fatal(err)
				}
				defer body.Close()
				data, err := io.ReadAll(body)
				if err != nil || !bytes.Equal(data, tc.data) {
					t.Fatalf("stored model bytes changed: %v", err)
				}
			})
		}
	}
}
