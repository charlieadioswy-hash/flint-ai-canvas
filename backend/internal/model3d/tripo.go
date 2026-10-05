package model3d

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"infinite-canvas/backend/internal/outbound"
)

const tripoBaseURL = "https://openapi.tripo3d.ai/v3"

type tripoProvider struct {
	client         *http.Client
	downloadClient *http.Client
}

func NewProvider() Provider {
	client := outbound.OutboundHTTPClient(120 * time.Second)
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return errors.New("Tripo API redirects are not allowed") }
	return &tripoProvider{client: client, downloadClient: newDownloadClient()}
}

func newDownloadClient() *http.Client {
	client := outbound.OutboundHTTPClient(120 * time.Second)
	check := client.CheckRedirect
	client.CheckRedirect = func(req *http.Request, via []*http.Request) error {
		if req.URL.Scheme != "https" {
			return errors.New("model download requires HTTPS")
		}
		return check(req, via)
	}
	return client
}

func (p *tripoProvider) request(ctx context.Context, config Config, method, path, contentType string, body io.Reader, output any) error {
	req, err := http.NewRequestWithContext(ctx, method, tripoBaseURL+path, body)
	if err != nil {
		return &Error{"provider_request_invalid", "3D 平台请求无效", true}
	}
	req.Header.Set("Authorization", "Bearer "+config.APIKey)
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	outbound.ApplyDefaultOutboundHeaders(req)
	response, err := p.client.Do(req)
	if err != nil {
		return &Error{"provider_request_uncertain", "3D 平台请求结果未确认", false}
	}
	defer response.Body.Close()
	var envelope struct {
		Code *int64          `json:"code"`
		Data json.RawMessage `json:"data"`
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, (1<<20)+1))
	validEnvelope := err == nil && len(data) <= 1<<20 && json.Unmarshal(data, &envelope) == nil && envelope.Code != nil && *envelope.Code >= 0
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		definite := Contains([]string{"400", "401", "403", "404", "405", "413", "415", "422", "429"}, fmt.Sprint(response.StatusCode))
		message := fmt.Sprintf("3D 平台拒绝请求（HTTP %d）", response.StatusCode)
		if validEnvelope {
			message = fmt.Sprintf("3D 平台拒绝请求（HTTP %d，上游错误码 %d）", response.StatusCode, *envelope.Code)
		}
		return &Error{"provider_request_rejected", message, definite}
	}
	if !validEnvelope {
		return &Error{"provider_response_invalid", "3D 平台响应无效", false}
	}
	if code := *envelope.Code; code != 0 {
		definite := code >= 1000 && code <= 1007
		switch code {
		case 2000, 2002, 2003, 2004, 2008, 2010, 2015, 2018:
			definite = true
		}
		return &Error{"provider_request_rejected", fmt.Sprintf("3D 平台拒绝请求（%d）", code), definite}
	}
	if len(envelope.Data) == 0 || bytes.Equal(bytes.TrimSpace(envelope.Data), []byte("null")) || json.Unmarshal(envelope.Data, output) != nil {
		return &Error{"provider_response_invalid", "3D 平台响应无效", false}
	}
	return nil
}

func (p *tripoProvider) Upload(ctx context.Context, config Config, image Image) (string, error) {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("file", image.FileName)
	if err != nil {
		return "", err
	}
	if _, err = part.Write(image.Data); err != nil {
		return "", err
	}
	if err = writer.Close(); err != nil {
		return "", err
	}
	var result struct {
		FileToken string `json:"file_token"`
	}
	if err := p.request(ctx, config, http.MethodPost, "/files", writer.FormDataContentType(), &body, &result); err != nil {
		return "", err
	}
	if strings.TrimSpace(result.FileToken) == "" || len(result.FileToken) > 4096 {
		return "", &Error{"provider_response_invalid", "图片上传未返回有效凭证", true}
	}
	return result.FileToken, nil
}

func generationPayload(request Request, tokens map[string]string) (string, map[string]any) {
	p := request.Parameters
	value := map[string]any{"model": p.Model, "texture": p.Texture, "pbr": p.PBR}
	optional := map[string]any{"face_limit": p.FaceLimit, "model_seed": p.ModelSeed, "image_seed": p.ImageSeed, "texture_seed": p.TextureSeed, "auto_size": p.AutoSize, "quad": p.Quad, "smart_low_poly": p.SmartLowPoly, "export_uv": p.ExportUV, "delight": p.Delight, "enable_image_autofix": p.EnableImageAutofix}
	for key, item := range optional {
		switch typed := item.(type) {
		case *int64:
			if typed != nil {
				value[key] = *typed
			}
		case *bool:
			if typed != nil {
				value[key] = *typed
			}
		}
	}
	for key, item := range map[string]string{"negative_prompt": p.NegativePrompt, "texture_quality": p.TextureQuality, "texture_version": p.TextureVersion, "geometry_quality": p.GeometryQuality, "compress": p.Compress, "export_orientation": p.ExportOrientation, "texture_alignment": p.TextureAlignment, "orientation": p.Orientation} {
		if item != "" {
			value[key] = item
		}
	}
	switch request.Mode {
	case "text":
		value["prompt"] = request.Prompt
		return "/generation/text-to-model", value
	case "image":
		value["input"] = tokens["single"]
		return "/generation/image-to-model", value
	default:
		inputs := []map[string]string{}
		for _, view := range []string{"front", "left", "back", "right"} {
			if token := tokens[view]; token != "" {
				inputs = append(inputs, map[string]string{view: token})
			}
		}
		value["inputs"] = inputs
		return "/generation/multiview-to-model", value
	}
}

func (p *tripoProvider) Submit(ctx context.Context, config Config, request Request, tokens map[string]string) (string, error) {
	path, payload := generationPayload(request, tokens)
	encoded, err := json.Marshal(payload)
	if err != nil {
		return "", &Error{"provider_request_invalid", "3D 平台请求无效", true}
	}
	var result struct {
		TaskID string `json:"task_id"`
	}
	if err := p.request(ctx, config, http.MethodPost, path, "application/json", bytes.NewReader(encoded), &result); err != nil {
		return "", err
	}
	if strings.TrimSpace(result.TaskID) == "" || len(result.TaskID) > 160 {
		return "", &Error{"provider_response_invalid", "3D 平台未返回任务标识", false}
	}
	return result.TaskID, nil
}

func (p *tripoProvider) Poll(ctx context.Context, config Config, id string, quad bool) (State, error) {
	var result struct {
		Status    string          `json:"status"`
		Progress  float64         `json:"progress"`
		ErrorCode json.RawMessage `json:"error_code"`
		Output    struct {
			ModelURL string `json:"model_url"`
		} `json:"output"`
	}
	if err := p.request(ctx, config, http.MethodGet, "/tasks/"+url.PathEscape(id), "", nil, &result); err != nil {
		return State{}, err
	}
	state := State{Status: result.Status, Progress: max(0, min(100, int(result.Progress))), Artifact: Artifact{URL: result.Output.ModelURL, Format: "glb"}}
	if quad {
		state.Artifact.Format = "fbx"
	}
	if len(result.ErrorCode) > 0 && len(result.ErrorCode) <= 64 {
		code := strings.Trim(string(result.ErrorCode), "\"")
		if numeric, err := strconv.Atoi(code); err == nil && numeric >= 0 {
			state.ErrorCode = strconv.Itoa(numeric)
		}
	}
	if state.Status == "success" && state.Artifact.URL == "" {
		return state, &Error{"provider_output_missing", "3D 平台未返回模型文件", false}
	}
	if !Contains([]string{"queued", "running", "success", "failed", "cancelled", "banned", "expired"}, state.Status) {
		return state, &Error{"provider_response_invalid", "3D 平台任务状态无效", false}
	}
	return state, nil
}

func (p *tripoProvider) Download(ctx context.Context, artifact Artifact) ([]byte, error) {
	parsed, err := outbound.ValidateOutboundURL(artifact.URL)
	if err != nil || parsed.Scheme != "https" {
		return nil, &Error{"provider_output_invalid", "模型下载地址无效", true}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), nil)
	if err != nil {
		return nil, err
	}
	// Artifact URLs are signed independently and must never receive the API key.
	outbound.ApplyDefaultOutboundHeaders(req)
	client := p.downloadClient
	if client == nil {
		client = newDownloadClient()
	}
	response, err := client.Do(req)
	if err != nil {
		return nil, &Error{"model_download_failed", "模型文件下载失败，可恢复原任务", false}
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || response.ContentLength > MaxOutputBytes {
		return nil, &Error{"model_download_failed", "模型文件下载失败或超过大小限制", false}
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, MaxOutputBytes+1))
	if err != nil || len(data) == 0 || int64(len(data)) > MaxOutputBytes {
		return nil, &Error{"model_download_failed", "模型文件下载失败或超过大小限制", false}
	}
	if err := ValidateFile(data, artifact.Format); err != nil {
		return nil, &Error{"model_output_invalid", "模型文件格式或外部依赖无效", true}
	}
	return data, nil
}
