package model3d

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"syscall"
	"testing"

	"infinite-canvas/backend/internal/kernel"
	"infinite-canvas/backend/internal/outbound"
)

func TestTripoUploadTransportDiagnostics(t *testing.T) {
	const secret = "secret-api-key https://secret.invalid/file?file_token=secret-token"
	for _, test := range []struct {
		name string
		err  error
		kind string
		text string
	}{
		{"dns", &net.DNSError{Err: secret, Name: "secret.invalid", Server: "secret-server"}, "dns", "DNS"},
		{"outbound dns", &kernel.AppError{Reason: kernel.ReasonUpstreamDNSFailed, Message: secret}, "dns", "DNS"},
		{"tls certificate", &tls.CertificateVerificationError{Err: errors.New(secret)}, "tls", "TLS"},
		{"tls record", tls.RecordHeaderError{Msg: secret}, "tls", "TLS"},
		{"timeout", context.DeadlineExceeded, "timeout", "超时"},
		{"cancelled", context.Canceled, "cancelled", "取消"},
		{"connection", &net.OpError{Op: secret, Net: "tcp", Err: syscall.ECONNREFUSED}, "connection", "网络"},
		{"connection closed", io.ErrUnexpectedEOF, "connection", "网络"},
		{"outbound blocked", &outbound.BadRequestError{Message: secret}, "outbound_blocked", "出站安全策略"},
		{"redirect", errTripoRedirect, "redirect", "重定向"},
		{"unknown", errors.New(secret), "", "参考图片上传失败，尚未创建生成任务"},
	} {
		t.Run(test.name, func(t *testing.T) {
			calls := 0
			provider := &tripoProvider{client: &http.Client{Transport: tripoRoundTrip(func(*http.Request) (*http.Response, error) {
				calls++
				return nil, &url.Error{Op: "Post", URL: secret, Err: test.err}
			})}}
			_, err := provider.Upload(context.Background(), Config{BaseURL: tripoTestBaseURL, APIKey: "secret-api-key"}, Image{FileName: "reference.png", ContentType: "image/png", Data: []byte("png")})
			var failure *Error
			if !errors.As(err, &failure) || failure.TransportKind != test.kind || failure.Definite || calls != 1 {
				t.Fatalf("unsafe transport classification: err=%v calls=%d", err, calls)
			}
			message := UploadFailureMessage(err)
			if !strings.Contains(message, test.text) || !strings.Contains(message, "尚未创建生成任务") || strings.Contains(message+err.Error(), "secret") || strings.Contains(message+err.Error(), "file_token") {
				t.Fatalf("unsafe or missing diagnostic: %q", message)
			}
		})
	}
}

func TestTripoUploadHTTPDiagnostics(t *testing.T) {
	for _, test := range []struct {
		status int
		code   int64
		text   string
	}{
		{401, 1000, "认证失败"},
		{403, 2010, "权限或额度"},
		{413, 2002, "大小限制"},
		{415, 2004, "图片格式"},
		{429, 1007, "请求过多"},
		{500, 1000, "暂时不可用"},
	} {
		t.Run(http.StatusText(test.status), func(t *testing.T) {
			calls := 0
			provider := &tripoProvider{client: &http.Client{Transport: tripoRoundTrip(func(*http.Request) (*http.Response, error) {
				calls++
				return tripoResponse(test.status, fmt.Sprintf(`{"code":%d,"message":"secret-api-key","suggestion":"https://secret.invalid/?file_token=secret-token","request_id":"secret-request"}`, test.code)), nil
			})}}
			_, err := provider.Upload(context.Background(), Config{BaseURL: tripoTestBaseURL}, Image{FileName: "reference.png", ContentType: "image/png", Data: []byte("png")})
			var failure *Error
			if !errors.As(err, &failure) || failure.HTTPStatus != test.status || failure.ProviderCode == nil || *failure.ProviderCode != test.code || calls != 1 {
				t.Fatalf("missing numeric diagnostics: err=%v calls=%d", err, calls)
			}
			message := UploadFailureMessage(err)
			if !strings.Contains(message, test.text) || !strings.Contains(message, fmt.Sprintf("HTTP %d", test.status)) || !strings.Contains(message, fmt.Sprintf("上游错误码 %d", test.code)) || strings.Contains(message, "secret") || strings.Contains(message, "file_token") {
				t.Fatalf("unsafe or missing diagnostic: %q", message)
			}
		})
	}
}

func TestUploadFailureMessageIgnoresUntrustedErrorText(t *testing.T) {
	const secret = "secret https://private.invalid/?file_token=credential"
	negative := int64(-1)
	for _, test := range []struct {
		name string
		err  error
		want string
	}{
		{"unknown", errors.New(secret), "参考图片上传失败，尚未创建生成任务"},
		{"unknown provider code", &Error{Code: secret, Message: secret, TransportKind: "dns"}, "参考图片上传失败，尚未创建生成任务"},
		{"unknown transport", &Error{Code: "provider_request_uncertain", Message: secret, TransportKind: secret}, "参考图片上传失败，尚未创建生成任务"},
		{"nil provider", (*Error)(nil), "参考图片上传失败，尚未创建生成任务"},
		{"invalid numeric metadata", &Error{Code: "provider_request_rejected", Message: secret, HTTPStatus: -1, ProviderCode: &negative}, "参考图片上传失败：3D 平台拒绝上传，请联系管理员；尚未创建生成任务"},
		{"wrapped response error", fmt.Errorf("%s: %w", secret, &Error{Code: "provider_response_invalid", Message: secret}), "参考图片上传失败：3D 平台上传响应无效，请联系管理员；尚未创建生成任务"},
	} {
		t.Run(test.name, func(t *testing.T) {
			if got := UploadFailureMessage(test.err); got != test.want {
				t.Fatalf("unsafe message: %q", got)
			}
		})
	}
}

func TestTripoUploadUsesDetectedMIME(t *testing.T) {
	for _, test := range []struct {
		mime string
		name string
	}{
		{"image/png", "reference.png"},
		{"image/jpeg", "reference.jpg"},
		{"image/webp", "reference.webp"},
		{"application/octet-stream", "reference.png"},
		{"image/png\r\nX-Secret: secret", "reference.png"},
		{"", "reference.png"},
	} {
		t.Run(test.mime, func(t *testing.T) {
			calls := 0
			provider := &tripoProvider{client: &http.Client{Transport: tripoRoundTrip(func(r *http.Request) (*http.Response, error) {
				calls++
				if r.URL.Path != "/v3/files" || r.Method != http.MethodPost {
					t.Fatal("wrong upload endpoint")
				}
				if err := r.ParseMultipartForm(1024); err != nil {
					t.Fatal(err)
				}
				part, header, err := r.FormFile("file")
				if err != nil {
					t.Fatal(err)
				}
				defer part.Close()
				data, err := io.ReadAll(part)
				if err != nil || string(data) != "image bytes" || header.Filename != test.name || header.Header.Get("Content-Type") != test.mime {
					t.Fatal("filename, MIME or body changed")
				}
				return tripoResponse(200, `{"code":0,"data":{"file_token":"file_abc123"}}`), nil
			})}}
			token, err := provider.Upload(context.Background(), Config{BaseURL: tripoTestBaseURL}, Image{FileName: test.name, ContentType: test.mime, Data: []byte("image bytes")})
			valid := test.mime == "image/png" || test.mime == "image/jpeg"
			if valid && (err != nil || token != "file_abc123" || calls != 1) {
				t.Fatalf("valid upload failed: err=%v calls=%d", err, calls)
			}
			if !valid && (err == nil || token != "" || calls != 0) {
				t.Fatal("unsupported MIME reached transport")
			}
		})
	}
}
