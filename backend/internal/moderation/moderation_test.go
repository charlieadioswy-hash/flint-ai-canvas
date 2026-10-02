package moderation

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"

	green "github.com/alibabacloud-go/green-20220302/v3/client"
	"github.com/alibabacloud-go/tea/dara"
)

func testConfig() Config {
	return Config{Type: "aliyun", Region: "cn-shanghai", AccessKeyID: "test-key", AccessKeySecret: "test-secret", Services: []string{"aigcCheck", "aigcViolationDetection"}, TimeoutSeconds: 30, MaxCallsPerDay: 100, MinIntervalSeconds: 10}
}

func TestAggregateCoverageAndHighestRisk(t *testing.T) {
	for _, test := range []struct {
		name         string
		items        []ItemResult
		status, risk string
	}{
		{"empty", nil, "failed", "unknown"},
		{"clean", []ItemResult{{Result: Result{RiskLevel: "none"}}, {Result: Result{RiskLevel: "none"}}}, "completed", "none"},
		{"partial_clean", []ItemResult{{Result: Result{RiskLevel: "none"}}, {Err: errors.New("timeout")}}, "partial", "unknown"},
		{"partial_risk", []ItemResult{{Result: Result{RiskLevel: "medium"}}, {Err: errors.New("timeout")}}, "partial", "medium"},
		{"highest", []ItemResult{{Result: Result{RiskLevel: "low"}}, {Result: Result{RiskLevel: "high"}}}, "completed", "high"},
		{"invalid", []ItemResult{{Result: Result{RiskLevel: ""}}}, "failed", "unknown"},
	} {
		t.Run(test.name, func(t *testing.T) {
			got := Aggregate(test.items)
			if got.Status != test.status || got.RiskLevel != test.risk {
				t.Fatalf("got %s/%s", got.Status, got.RiskLevel)
			}
		})
	}
	got := Aggregate([]ItemResult{{Result: Result{RiskLevel: "low", RiskTags: []RiskTag{{Code: "risk", Label: "风险", Level: "low"}}}}, {Result: Result{RiskLevel: "high", RiskTags: []RiskTag{{Code: "risk", Label: "风险", Level: "high"}}}}})
	if len(got.RiskTags) != 1 || got.RiskTags[0].Level != "high" {
		t.Fatal("risk tags must merge by stable code and retain highest severity")
	}
}

func TestAliyunValidationMakesNoRequests(t *testing.T) {
	p := newAliyunProvider()
	p.httpClient.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) {
		t.Fatal("validation must never call upstream")
		return nil, nil
	})
	if err := p.Validate(testConfig()); err != nil {
		t.Fatal(err)
	}
	for _, config := range []Config{
		{Type: "aliyun"},
		func() Config { c := testConfig(); c.Services = []string{"aigcDetector"}; return c }(),
		func() Config { c := testConfig(); c.Services = []string{"aigcCheck", "aigcCheck"}; return c }(),
		func() Config { c := testConfig(); c.MinIntervalSeconds = 0; return c }(),
	} {
		if p.Validate(config) == nil {
			t.Fatal("invalid configuration accepted")
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := p.Detect(ctx, testConfig(), Image{Data: []byte("image")}, "aigcCheck"); err == nil {
		t.Fatal("cancelled request accepted")
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func jsonResponse(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Header: http.Header{"Content-Type": {"application/json"}}, Body: io.NopCloser(strings.NewReader(body))}
}

func sdkAction(req *http.Request) string {
	// SDK headers are lower case until net/http serializes them on the wire.
	for key, values := range req.Header {
		if strings.EqualFold(key, "x-acs-action") && len(values) > 0 {
			return values[0]
		}
	}
	return ""
}

func TestAliyunSDKUsesOneUploadAndOneCallPerService(t *testing.T) {
	p := newAliyunProvider()
	tokens, uploads, calls := 0, 0, 0
	p.httpClient.Transport = roundTripFunc(func(req *http.Request) (*http.Response, error) {
		if req.Context().Err() != nil {
			return nil, req.Context().Err()
		}
		switch sdkAction(req) {
		case "DescribeUploadToken":
			tokens++
			return jsonResponse(200, `{"Code":200,"Data":{"AccessKeyId":"temporary-key","AccessKeySecret":"temporary-secret","SecurityToken":"temporary-token","BucketName":"oss-cip-test","OssInternetEndPoint":"https://oss-cn-shanghai.aliyuncs.com","FileNamePrefix":"upload/test/"}}`), nil
		case "ImageModeration":
			calls++
			if req.Method != http.MethodPost || req.URL.Scheme != "https" {
				t.Fatal("unexpected moderation request")
			}
			return jsonResponse(200, `{"Code":200,"RequestId":"test-request","Data":{"RiskLevel":"none","Result":[]}}`), nil
		default:
			if req.Method != http.MethodPut || !strings.HasSuffix(req.URL.Hostname(), ".oss-cn-shanghai.aliyuncs.com") {
				t.Fatalf("unexpected upload request: method=%s host=%s action=%s", req.Method, req.URL.Hostname(), req.Header.Get("x-acs-action"))
			}
			uploads++
			return jsonResponse(200, ""), nil
		}
	})
	for _, service := range testConfig().Services {
		result, err := p.Detect(context.Background(), testConfig(), Image{Data: []byte("original-image"), ContentType: "image/png"}, service)
		if err != nil {
			t.Fatal(err)
		}
		if result.RiskLevel != "none" {
			t.Fatal("unexpected risk")
		}
	}
	if tokens != 1 || uploads != 1 || calls != 2 {
		t.Fatalf("calls token=%d upload=%d paid=%d", tokens, uploads, calls)
	}
}

func TestAliyunSDKDoesNotRetryPaidFailure(t *testing.T) {
	p := newAliyunProvider()
	digestConfig := testConfig()
	// Token and upload exchanges are stubbed; only the paid API may fail.
	calls := 0
	p.httpClient.Transport = roundTripFunc(func(req *http.Request) (*http.Response, error) {
		switch sdkAction(req) {
		case "DescribeUploadToken":
			return jsonResponse(200, `{"Code":200,"Data":{"AccessKeyId":"temporary-key","AccessKeySecret":"temporary-secret","SecurityToken":"temporary-token","BucketName":"oss-cip-test","OssInternetEndPoint":"https://oss-cn-shanghai.aliyuncs.com","FileNamePrefix":"upload/test/"}}`), nil
		case "ImageModeration":
			calls++
			return jsonResponse(500, `{"Code":"InternalError","Message":"do not expose temporary-secret","RequestId":"test"}`), nil
		default:
			return jsonResponse(200, ""), nil
		}
	})
	_, err := p.Detect(context.Background(), digestConfig, Image{Data: []byte("original-image"), ContentType: "image/png"}, "aigcCheck")
	if err == nil || strings.Contains(err.Error(), "temporary-secret") {
		t.Fatal("failed request must produce a sanitized error")
	}
	if calls != 1 {
		t.Fatalf("expected one paid request, got %d: %v", calls, err)
	}
}

func TestAliyunRejectsMissingRiskAndUnsafeUploadEndpoints(t *testing.T) {
	if _, err := normalizeAliyunResult(&green.ImageModerationResponseBody{Data: &green.ImageModerationResponseBodyData{}}); err == nil {
		t.Fatal("missing risk cannot become clean")
	}
	result, err := normalizeAliyunResult(&green.ImageModerationResponseBody{Data: &green.ImageModerationResponseBodyData{RiskLevel: dara.String("medium"), Result: []*green.ImageModerationResponseBodyDataResult{{Label: dara.String("risk-code"), Description: dara.String("风险说明")}}}})
	if err != nil || len(result.RiskTags) != 1 || result.RiskTags[0].Level != "medium" {
		t.Fatal("risk normalization failed")
	}
	for _, endpoint := range []string{"http://oss-cn-shanghai.aliyuncs.com", "https://127.0.0.1", "https://attacker.aliyuncs.com", "https://oss-cn-shanghai.aliyuncs.com/?secret=x", "https://user:secret@oss-cn-shanghai.aliyuncs.com"} {
		if _, err := safeAliyunOSSEndpoint(endpoint); err == nil {
			t.Fatal("unsafe upload endpoint accepted")
		}
	}
}
