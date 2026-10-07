package moderation

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode"

	openapi "github.com/alibabacloud-go/darabonba-openapi/v2/client"
	green "github.com/alibabacloud-go/green-20220302/v3/client"
	"github.com/alibabacloud-go/tea/dara"
	"github.com/aliyun/aliyun-oss-go-sdk/oss"
	"github.com/google/uuid"
	"infinite-canvas/backend/internal/outbound"
)

type aliyunProvider struct {
	httpClient *http.Client
	// An adapter is scoped to one batch. Several services reuse one uploaded original.
	uploaded map[string]map[string]string
}

func newAliyunProvider() *aliyunProvider {
	client := outbound.OutboundHTTPClient(0)
	client.CheckRedirect = func(_ *http.Request, _ []*http.Request) error { return errors.New("检测请求不允许重定向") }
	return &aliyunProvider{httpClient: client, uploaded: make(map[string]map[string]string)}
}

func (p *aliyunProvider) Validate(config Config) error {
	if config.Type != "aliyun" {
		return errors.New("不支持的图片检测平台")
	}
	if config.Region != "cn-shanghai" && config.Region != "cn-beijing" {
		return errors.New("请选择支持的检测地域")
	}
	for _, value := range []string{config.AccessKeyID, config.AccessKeySecret} {
		if value == "" || len(value) > 256 || strings.IndexFunc(value, unicode.IsSpace) >= 0 {
			return errors.New("请配置完整有效的检测凭据")
		}
	}
	if len(config.Services) < 1 || len(config.Services) > 2 {
		return errors.New("至少启用一个支持的检测项目")
	}
	seen := make(map[string]bool)
	for _, service := range config.Services {
		if service != "aigcCheck" && service != "aigcViolationDetection" {
			return errors.New("不支持的图片检测项目")
		}
		if seen[service] {
			return errors.New("检测项目不能重复")
		}
		seen[service] = true
	}
	if config.TimeoutSeconds < 5 || config.TimeoutSeconds > 120 {
		return errors.New("检测超时须为 5–120 秒")
	}
	if config.MaxCallsPerDay < 1 || config.MaxCallsPerDay > 100000 {
		return errors.New("每日调用上限须为 1–100000")
	}
	if config.MinIntervalSeconds < 1 || config.MinIntervalSeconds > 3600 {
		return errors.New("复检间隔须为 1–3600 秒")
	}
	return nil
}

// The SDK signs requests, while the application retains its normal SSRF and
// cancellation boundary. No raw SDK error (which may contain signed URLs) escapes.
type aliyunHTTPClient struct {
	ctx    context.Context
	client *http.Client
}

func (c aliyunHTTPClient) Call(request *http.Request, _ *http.Transport) (*http.Response, error) {
	return c.client.Do(request.WithContext(c.ctx))
}

func (p *aliyunProvider) Detect(ctx context.Context, config Config, image Image, service string) (Result, error) {
	if err := p.Validate(config); err != nil {
		return Result{}, err
	}
	enabled := false
	for _, item := range config.Services {
		if item == service {
			enabled = true
		}
	}
	if !enabled {
		return Result{}, errors.New("检测项目未启用")
	}
	ctx, cancel := context.WithTimeout(ctx, time.Duration(config.TimeoutSeconds)*time.Second)
	defer cancel()
	if err := ctx.Err(); err != nil {
		return Result{}, errors.New("检测已取消或超时")
	}
	if len(image.Data) == 0 || len(image.Data) > 20<<20 {
		return Result{}, errors.New("图片为空或超过检测大小限制")
	}
	client, err := green.NewClient(&openapi.Config{
		AccessKeyId: dara.String(config.AccessKeyID), AccessKeySecret: dara.String(config.AccessKeySecret),
		Endpoint: dara.String("green-cip." + config.Region + ".aliyuncs.com"), RegionId: dara.String(config.Region),
		Protocol: dara.String("https"), HttpClient: aliyunHTTPClient{ctx: ctx, client: p.httpClient},
		RetryOptions: &dara.RetryOptions{Retryable: false},
	})
	if err != nil {
		return Result{}, errors.New("检测客户端配置无效")
	}
	// A timeout has an uncertain billing outcome. Never silently repeat a paid call.
	runtime := &dara.RuntimeOptions{Autoretry: dara.Bool(false), MaxAttempts: dara.Int(1), ConnectTimeout: dara.Int(config.TimeoutSeconds * 1000), ReadTimeout: dara.Int(config.TimeoutSeconds * 1000)}
	digest := sha256.Sum256(image.Data)
	key := config.Region + ":" + config.AccessKeyID + ":" + hex.EncodeToString(digest[:])
	params, ok := p.uploaded[key]
	if !ok {
		tokenResponse, tokenErr := client.DescribeUploadTokenWithOptions(runtime)
		if tokenErr != nil || tokenResponse == nil || tokenResponse.Body == nil || tokenResponse.Body.Data == nil || dara.Int32Value(tokenResponse.StatusCode) != 200 || dara.Int32Value(tokenResponse.Body.Code) != 200 {
			return Result{}, errors.New("无法获取检测图片上传凭据")
		}
		token := tokenResponse.Body.Data
		endpoint, endpointErr := safeAliyunOSSEndpoint(dara.StringValue(token.OssInternetEndPoint))
		if endpointErr != nil || dara.StringValue(token.BucketName) == "" || dara.StringValue(token.AccessKeyId) == "" || dara.StringValue(token.AccessKeySecret) == "" || dara.StringValue(token.SecurityToken) == "" {
			return Result{}, errors.New("检测图片上传配置无效")
		}
		ossClient, ossErr := oss.New(endpoint, dara.StringValue(token.AccessKeyId), dara.StringValue(token.AccessKeySecret), oss.SecurityToken(dara.StringValue(token.SecurityToken)), oss.HTTPClient(p.httpClient))
		if ossErr != nil {
			return Result{}, errors.New("无法创建检测图片上传客户端")
		}
		bucket, bucketErr := ossClient.Bucket(dara.StringValue(token.BucketName))
		if bucketErr != nil {
			return Result{}, errors.New("检测图片上传空间无效")
		}
		objectName := dara.StringValue(token.FileNamePrefix) + uuid.NewString()
		if err := bucket.PutObject(objectName, bytes.NewReader(image.Data), oss.WithContext(ctx), oss.ContentType(image.ContentType)); err != nil {
			return Result{}, errors.New("检测图片上传失败")
		}
		params = map[string]string{"ossBucketName": dara.StringValue(token.BucketName), "ossObjectName": objectName, "dataId": uuid.NewString()}
		p.uploaded[key] = params
	}
	payload, err := json.Marshal(params)
	if err != nil {
		return Result{}, errors.New("无法构建图片检测请求")
	}
	response, err := client.ImageModerationWithContext(ctx, &green.ImageModerationRequest{Service: dara.String(service), ServiceParameters: dara.String(string(payload))}, runtime)
	if err != nil || response == nil || response.Body == nil {
		return Result{}, errors.New("图片检测请求失败或超时")
	}
	if dara.Int32Value(response.StatusCode) != 200 || dara.Int32Value(response.Body.Code) != 200 {
		return Result{}, fmt.Errorf("图片检测未成功（状态 %d）", dara.Int32Value(response.Body.Code))
	}
	return normalizeAliyunResult(response.Body)
}

func safeAliyunOSSEndpoint(raw string) (string, error) {
	if !strings.Contains(raw, "://") {
		raw = "https://" + raw
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || parsed.User != nil || parsed.Port() != "" || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.Path != "" && parsed.Path != "/" {
		return "", errors.New("检测上传地址无效")
	}
	host := strings.ToLower(parsed.Hostname())
	if host != "oss-cn-shanghai.aliyuncs.com" && host != "oss-cn-beijing.aliyuncs.com" {
		return "", errors.New("不支持的检测上传地址")
	}
	return "https://" + host, nil
}

func normalizeAliyunResult(body *green.ImageModerationResponseBody) (Result, error) {
	if body == nil || body.Data == nil {
		return Result{}, errors.New("检测结果缺少数据")
	}
	level := dara.StringValue(body.Data.RiskLevel)
	if riskOrder(level) < 0 {
		return Result{}, errors.New("检测结果缺少有效风险等级")
	}
	result := Result{RiskLevel: level, RequestID: dara.StringValue(body.RequestId), RiskTags: []RiskTag{}}
	if level == "none" {
		return result, nil
	}
	for _, item := range body.Data.Result {
		if item == nil {
			continue
		}
		code := strings.TrimSpace(dara.StringValue(item.Label))
		if code == "" {
			continue
		}
		label := strings.TrimSpace(dara.StringValue(item.Description))
		if label == "" {
			label = "图片内容风险"
		}
		if len(code) > 160 {
			code = code[:160]
		}
		if len([]rune(label)) > 200 {
			label = string([]rune(label)[:200])
		}
		result.RiskTags = append(result.RiskTags, RiskTag{Code: code, Label: label, Level: level})
	}
	return result, nil
}
