package model3d

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"syscall"

	"yingce/backend/internal/kernel"
	"yingce/backend/internal/outbound"
)

// Retain only error categories; URLs, addresses and the original error chain
// must not survive into the provider error or persisted task failure.
func classifyTransportError(err error) string {
	var networkError net.Error
	if errors.Is(err, context.DeadlineExceeded) || errors.As(err, &networkError) && networkError.Timeout() {
		return "timeout"
	}
	if errors.Is(err, context.Canceled) {
		return "cancelled"
	}
	var dnsError *net.DNSError
	var appError *kernel.AppError
	if errors.As(err, &dnsError) || errors.As(err, &appError) && appError.Reason == kernel.ReasonUpstreamDNSFailed {
		return "dns"
	}
	var certificateError *tls.CertificateVerificationError
	var unknownAuthority x509.UnknownAuthorityError
	var hostnameError x509.HostnameError
	var invalidCertificate x509.CertificateInvalidError
	var recordError tls.RecordHeaderError
	if errors.As(err, &certificateError) || errors.As(err, &unknownAuthority) || errors.As(err, &hostnameError) || errors.As(err, &invalidCertificate) || errors.As(err, &recordError) {
		return "tls"
	}
	var outboundError *outbound.BadRequestError
	if errors.As(err, &outboundError) {
		return "outbound_blocked"
	}
	if errors.Is(err, errTripoRedirect) {
		return "redirect"
	}
	var operationError *net.OpError
	if errors.As(err, &operationError) || errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, syscall.ECONNREFUSED) || errors.Is(err, syscall.ECONNRESET) || errors.Is(err, syscall.EPIPE) || errors.Is(err, syscall.ENETUNREACH) || errors.Is(err, syscall.EHOSTUNREACH) {
		return "connection"
	}
	return ""
}

// UploadFailureMessage is the persistence boundary: never copy err.Error() or
// Error.Message, even from a typed provider error. Only allowlisted categories
// and validated numeric diagnostics may reach users or task records.
func UploadFailureMessage(err error) string {
	const fallback = "参考图片上传失败，尚未创建生成任务"
	var failure *Error
	if !errors.As(err, &failure) || failure == nil {
		return fallback
	}
	detail := ""
	switch failure.Code {
	case "provider_request_uncertain", "provider_request_invalid":
		if failure.Code == "provider_request_invalid" {
			detail = "上传请求无效，请联系管理员"
		}
		switch failure.TransportKind {
		case "dns":
			detail = "服务器无法解析 3D 平台域名，请管理员检查 DNS"
		case "tls":
			detail = "与 3D 平台的安全连接失败，请管理员检查 TLS 配置"
		case "timeout":
			detail = "上传请求超时，请稍后重试或联系管理员"
		case "connection":
			detail = "服务器无法连接 3D 平台，请管理员检查网络"
		case "outbound_blocked":
			detail = "服务器出站安全策略阻止连接，请联系管理员"
		case "cancelled":
			detail = "上传请求已取消"
		case "redirect":
			detail = "3D 平台返回了不允许的重定向，请联系管理员"
		}
	case "provider_request_rejected":
		detail = "3D 平台拒绝上传，请联系管理员"
		switch failure.HTTPStatus {
		case 400, 422:
			detail = "3D 平台不接受上传参数，请联系管理员"
		case 401:
			detail = "3D 平台认证失败，请管理员检查服务配置"
		case 403:
			detail = "3D 平台拒绝访问，请管理员检查权限或额度"
		case 413:
			detail = "参考图片超过平台大小限制"
		case 415:
			detail = "3D 平台不接受该图片格式"
		case 429:
			detail = "3D 平台请求过多，请稍后重试"
		}
		if failure.HTTPStatus >= 500 && failure.HTTPStatus <= 599 {
			detail = "3D 平台暂时不可用，请稍后重试"
		}
		diagnostics := []string{}
		if failure.HTTPStatus >= 100 && failure.HTTPStatus <= 599 {
			diagnostics = append(diagnostics, fmt.Sprintf("HTTP %d", failure.HTTPStatus))
		}
		if failure.ProviderCode != nil && *failure.ProviderCode >= 0 {
			diagnostics = append(diagnostics, fmt.Sprintf("上游错误码 %d", *failure.ProviderCode))
		}
		if len(diagnostics) > 0 {
			detail += "（" + strings.Join(diagnostics, "，") + "）"
		}
	case "provider_response_invalid":
		detail = "3D 平台上传响应无效，请联系管理员"
	case "provider_upload_mime_invalid":
		detail = "参考图必须使用 PNG 或 JPEG"
	}
	if detail == "" {
		return fallback
	}
	return "参考图片上传失败：" + detail + "；尚未创建生成任务"
}
