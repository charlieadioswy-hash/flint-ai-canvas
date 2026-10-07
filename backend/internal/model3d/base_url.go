package model3d

import (
	"errors"
	"net"
	"net/url"
	"strconv"
	"strings"
)

const DefaultBaseURL = "https://openapi.tripo3d.ai/v3"

// NormalizeBaseURL only removes surrounding whitespace and trailing slashes.
// DNS and outbound policy are rechecked immediately before each API request.
func NormalizeBaseURL(value string) (string, error) {
	value = strings.TrimRight(strings.TrimSpace(value), "/")
	invalid := errors.New("API 地址须为有效 HTTPS 地址，以 /v3 结尾，不能包含账号、查询参数或片段")
	if value == "" || len(value) > 2048 || strings.ContainsAny(value, "\r\n\t#") {
		return "", invalid
	}
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme != "https" || parsed.Opaque != "" || parsed.User != nil || parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" || parsed.Path != "/v3" || parsed.RawPath != "" {
		return "", invalid
	}
	host := parsed.Hostname()
	if host == "" || strings.Contains(host, "%") || strings.HasSuffix(parsed.Host, ":") {
		return "", invalid
	}
	if port := parsed.Port(); port != "" {
		number, err := strconv.Atoi(port)
		if err != nil || number < 1 || number > 65535 {
			return "", invalid
		}
	}
	if net.ParseIP(host) == nil {
		host = strings.TrimSuffix(host, ".")
		if len(host) == 0 || len(host) > 253 || strings.ContainsAny(parsed.Host, "[]") {
			return "", invalid
		}
		for _, label := range strings.Split(host, ".") {
			if len(label) == 0 || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
				return "", invalid
			}
			for _, character := range label {
				if character != '-' && (character < 'a' || character > 'z') && (character < 'A' || character > 'Z') && (character < '0' || character > '9') {
					return "", invalid
				}
			}
		}
	}
	return value, nil
}
