package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"path"
	"strings"

	"yingce/backend/internal/model"
	"yingce/backend/internal/protocol"
)

const liblibPreparedMetadataKey = "liblibPreparedUploads"

type liblibUploadSignature struct {
	Key        string `json:"key"`
	Policy     string `json:"policy"`
	PostURL    string `json:"postUrl"`
	Date       string `json:"xossDate"`
	Credential string `json:"xossCredential"`
	Version    string `json:"xossSignatureVersion"`
	Signature  string `json:"xossSignature"`
}

func prepareLiblibProtocolRequest(ctx context.Context, input canvasGenerationInput, request protocol.GenerationRequest) (protocol.GenerationRequest, error) {
	if input.Config.InterfaceType != protocol.LiblibImageProtocolID {
		return request, nil
	}
	if err := protocol.ValidateLiblibRequest(request); err != nil {
		return request, err
	}
	cache := map[string]string{}
	var task *model.Task
	var stored map[string]any
	analytics, _ := ctx.Value(providerAnalyticsKey{}).(providerAnalyticsContext)
	if analytics.Service != nil && analytics.TaskID != "" {
		var err error
		task, err = analytics.Service.repo.Task(analytics.TaskID)
		if err != nil {
			return request, err
		}
		if task.UserID != analytics.UserID {
			return request, errors.New("素材准备任务归属无效")
		}
		raw, err := analytics.Service.decryptTaskInputJSON(task.InputJSON)
		if err != nil {
			return request, err
		}
		if err := json.Unmarshal([]byte(raw), &stored); err != nil {
			return request, err
		}
		metadata, _ := stored["metadata"].(map[string]any)
		if uploads, ok := metadata[liblibPreparedMetadataKey].(map[string]any); ok {
			for key, value := range uploads {
				if address, ok := value.(string); ok {
					cache[key] = address
				}
			}
		}
	}
	persist := func() error {
		if task == nil {
			return nil
		}
		metadata, _ := stored["metadata"].(map[string]any)
		if metadata == nil {
			metadata = map[string]any{}
			stored["metadata"] = metadata
		}
		metadata[liblibPreparedMetadataKey] = cache
		if err := analytics.Service.protectTaskSecrets(stored); err != nil {
			return err
		}
		encoded, err := json.Marshal(stored)
		if err != nil {
			return err
		}
		return analytics.Service.repo.SaveTaskProviderPreparation(task, string(encoded))
	}
	prepare := func(media protocol.MediaReference) (protocol.MediaReference, error) {
		value := strings.TrimSpace(media.URL)
		publicURL := strings.HasPrefix(value, "https://") || strings.HasPrefix(value, "http://")
		if publicURL {
			if _, err := ValidateOutboundURL(value); err != nil {
				return media, err
			}
			media.DataURL = ""
		}
		data, _, err := protocolMediaBytes(ctx, input.Config, media)
		if err != nil {
			return media, fmt.Errorf("读取Liblib输入图片失败：%w", err)
		}
		if len(data) == 0 || len(data) > 10<<20 {
			return media, errors.New("Liblib 图片须非空且不超过10MB")
		}
		config, format, err := image.DecodeConfig(bytes.NewReader(data))
		if err != nil || (format != "png" && format != "jpeg") {
			return media, errors.New("Liblib 上传仅支持PNG/JPEG图片")
		}
		if config.Width < 1 || config.Height < 1 || config.Width > 4096 || config.Height > 4096 {
			return media, errors.New("Liblib 参考图片宽高须为1–4096")
		}
		media.Metadata = cloneLiblibMetadata(media.Metadata)
		media.Metadata["width"], media.Metadata["height"] = config.Width, config.Height
		if publicURL {
			media.DataURL = ""
			return media, nil
		}
		// Scope deduplication to the configured provider account and exact bytes.
		hash := sha256.New()
		_, _ = hash.Write([]byte(input.Config.BaseURL + "\x00" + input.Config.APIKey + "\x00"))
		_, _ = hash.Write(data)
		key := hex.EncodeToString(hash.Sum(nil))
		address := cache[key]
		if address != "" {
			if _, err := ValidateOutboundURL(address); err != nil {
				return media, errors.New("Liblib上传缓存地址无效")
			}
		}
		if address == "" {
			address, err = uploadLiblibImage(ctx, input.Config, data, format, key)
			if err != nil {
				return media, err
			}
			cache[key] = address
			if err := persist(); err != nil {
				return media, fmt.Errorf("保存Liblib上传检查点失败：%w", err)
			}
		}
		media.URL, media.DataURL = address, ""
		return media, nil
	}
	request.Images = append([]protocol.MediaReference(nil), request.Images...)
	for i, media := range request.Images {
		prepared, err := prepare(media)
		if err != nil {
			return request, err
		}
		request.Images[i] = prepared
	}
	request.ControlNet = append([]protocol.ControlNetUnit(nil), request.ControlNet...)
	for i, unit := range request.ControlNet {
		prepared, err := prepare(unit.Image)
		if err != nil {
			return request, err
		}
		request.ControlNet[i].Image = prepared
		if unit.Mask != nil {
			prepared, err := prepare(*unit.Mask)
			if err != nil {
				return request, err
			}
			request.ControlNet[i].Mask = &prepared
		}
	}
	return request, nil
}

func cloneLiblibMetadata(original map[string]any) map[string]any {
	result := make(map[string]any, len(original)+2)
	for key, value := range original {
		result[key] = value
	}
	return result
}

func uploadLiblibImage(ctx context.Context, config providerConfig, data []byte, format, key string) (string, error) {
	extension := "png"
	if format == "jpeg" {
		extension = "jpg"
	}
	name := "yingce-" + key[:24] + "." + extension
	spec := protocol.RequestSpec{Method: http.MethodPost, Path: "/api/generate/upload/signature", OriginPath: true, ContentType: "application/json", Body: map[string]any{"name": name, "extension": extension}, Auth: protocol.ManifestAuth{Type: "liblib-hmac-sha1", Field: "apiKey", SecretField: "secretKey"}}
	response, err := executeProtocolRequest(withProviderRequestKind(ctx, "upload-signature"), config, spec)
	if err != nil {
		return "", err
	}
	var envelope struct {
		Code *int                  `json:"code"`
		Data liblibUploadSignature `json:"data"`
	}
	if err := json.Unmarshal(response, &envelope); err != nil {
		return "", errors.New("Liblib上传签名响应格式无效")
	}
	if envelope.Code == nil || *envelope.Code != 0 {
		return "", errors.New("Liblib上传签名请求失败")
	}
	s := envelope.Data
	if s.Key == "" || s.Policy == "" || s.PostURL == "" || s.Date == "" || s.Credential == "" || s.Version != "OSS4-HMAC-SHA256" || s.Signature == "" {
		return "", errors.New("Liblib上传签名缺少完整OSS V4凭证")
	}
	destination, err := url.Parse(s.PostURL)
	if err != nil || destination.Scheme != "https" || destination.Host == "" || destination.User != nil || destination.RawQuery != "" || destination.Fragment != "" {
		return "", errors.New("Liblib上传目的地址无效")
	}
	if _, err := ValidateOutboundURL(s.PostURL); err != nil {
		return "", err
	}
	if strings.HasPrefix(s.Key, "/") || strings.Contains(s.Key, "\\") || path.Clean(s.Key) != s.Key || strings.HasPrefix(s.Key, "../") {
		return "", errors.New("Liblib上传对象key无效")
	}
	body, contentType, err := liblibUploadMultipart(s, name, data, "image/"+format)
	if err != nil {
		return "", err
	}
	// OSS receives only its temporary form credentials, never channel AK/SK or headers.
	req, err := http.NewRequestWithContext(withProviderRequestKind(ctx, "upload"), http.MethodPost, s.PostURL, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", contentType)
	if _, _, err := doBinary(req); err != nil {
		return "", err
	}
	objectURL := strings.TrimRight(s.PostURL, "/") + "/" + strings.Join(liblibEscapeKey(s.Key), "/")
	return objectURL, nil
}

func liblibUploadMultipart(s liblibUploadSignature, name string, data []byte, mimeType string) ([]byte, string, error) {
	if mimeType != "image/png" && mimeType != "image/jpeg" {
		return nil, "", errors.New("Liblib 上传仅支持PNG/JPEG图片")
	}
	var buffer bytes.Buffer
	writer := multipart.NewWriter(&buffer)
	for _, field := range [][2]string{{"key", s.Key}, {"policy", s.Policy}, {"x-oss-date", s.Date}, {"x-oss-credential", s.Credential}, {"x-oss-signature-version", s.Version}, {"x-oss-signature", s.Signature}} {
		if err := writer.WriteField(field[0], field[1]); err != nil {
			return nil, "", err
		}
	}
	// OSS checks the file part's media type. CreateFormFile defaults to
	// application/octet-stream, which Liblib's image-only policy rejects.
	header := make(textproto.MIMEHeader)
	// OSS also requires quoted disposition parameters, even for token-safe names.
	quotedName := strings.NewReplacer("\\", "\\\\", "\"", "\\\"").Replace(name)
	header.Set("Content-Disposition", fmt.Sprintf("form-data; name=\"file\"; filename=\"%s\"", quotedName))
	header.Set("Content-Type", mimeType)
	file, err := writer.CreatePart(header)
	if err != nil {
		return nil, "", err
	}
	if _, err := file.Write(data); err != nil {
		return nil, "", err
	}
	if err := writer.Close(); err != nil {
		return nil, "", err
	}
	return buffer.Bytes(), writer.FormDataContentType(), nil
}

func liblibEscapeKey(key string) []string {
	parts := strings.Split(key, "/")
	for i := range parts {
		parts[i] = url.PathEscape(parts[i])
	}
	return parts
}
