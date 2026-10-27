package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	_ "image/jpeg"
	"image/png"
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
	request.Prompt = liblibLoRAPrompt(input, request.Prompt)
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
	prepare := func(media protocol.MediaReference, canny bool) (protocol.MediaReference, error) {
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
		if canny && media.Role == "control_image" && format == "png" {
			var changed bool
			data, changed, err = liblibCannyImagePNG(data)
			if err != nil {
				return media, err
			}
			if changed {
				// Canny receives visible RGB on black, never hidden RGB from alpha.
				// Only this provider upload changes; the owned resource is untouched.
				publicURL = false
				media.MIMEType = "image/png"
				media.Metadata["bytes"] = len(data)
			}
		}
		if media.Role == "mask" {
			mode, _ := request.ProviderOptions[protocol.LiblibImageProtocolID]["inpaintMaskMode"].(string)
			data, err = liblibInpaintMaskPNG(data, mode)
			if err != nil {
				return media, err
			}
			// The uploaded bytes, including a remote input mask, must use Liblib's
			// white=repaint convention rather than canvas alpha transparency.
			publicURL, format = false, "png"
			media.MIMEType = "image/png"
			media.Metadata["bytes"] = len(data)
		}
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
		prepared, err := prepare(media, false)
		if err != nil {
			return request, err
		}
		request.Images[i] = prepared
	}
	request.ControlNet = append([]protocol.ControlNetUnit(nil), request.ControlNet...)
	for i, unit := range request.ControlNet {
		prepared, err := prepare(unit.Image, unit.Parameters.Preprocessor == "canny")
		if err != nil {
			return request, err
		}
		request.ControlNet[i].Image = prepared
		if unit.Mask != nil {
			prepared, err := prepare(*unit.Mask, false)
			if err != nil {
				return request, err
			}
			request.ControlNet[i].Mask = &prepared
		}
	}
	return request, nil
}

func liblibCannyImagePNG(data []byte) ([]byte, bool, error) {
	source, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, false, errors.New("Liblib Canny 控制图不是有效 PNG 图片")
	}
	if opaque, ok := source.(interface{ Opaque() bool }); ok && opaque.Opaque() {
		return data, false, nil
	}
	bounds := source.Bounds()
	var result draw.Image = image.NewRGBA(bounds)
	switch source.(type) {
	case *image.NRGBA64, *image.RGBA64, *image.Gray16:
		result = image.NewRGBA64(bounds)
	}
	draw.Draw(result, bounds, image.NewUniform(color.Black), image.Point{}, draw.Src)
	draw.Draw(result, bounds, source, bounds.Min, draw.Over)
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, result); err != nil {
		return nil, false, err
	}
	if encoded.Len() > 10<<20 {
		return nil, false, errors.New("Liblib 黑底合成后的 Canny 控制图超过10MB")
	}
	return encoded.Bytes(), true, nil
}

func liblibInpaintMaskPNG(data []byte, mode string) ([]byte, error) {
	mode = strings.TrimSpace(mode)
	if mode != "" && mode != "alpha" && mode != "luminance" {
		return nil, errors.New("Liblib inpaintMaskMode 仅支持 alpha 或 luminance")
	}
	source, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, errors.New("Liblib 局部重绘蒙版不是有效图片")
	}
	bounds := source.Bounds()
	result := image.NewGray(image.Rect(0, 0, bounds.Dx(), bounds.Dy()))
	selected := false
	for y := 0; y < bounds.Dy(); y++ {
		for x := 0; x < bounds.Dx(); x++ {
			pixel := source.At(bounds.Min.X+x, bounds.Min.Y+y)
			_, _, _, alpha := pixel.RGBA()
			value := uint8((0xffff - alpha) >> 8)
			if mode == "luminance" {
				value = color.GrayModel.Convert(pixel).(color.Gray).Y
			}
			result.SetGray(x, y, color.Gray{Y: value})
			selected = selected || value > 0
		}
	}
	if !selected {
		return nil, errors.New("Liblib 局部重绘蒙版没有可重绘区域；透明蒙版使用 alpha，黑白蒙版使用 luminance")
	}
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, result); err != nil {
		return nil, err
	}
	if encoded.Len() > 10<<20 {
		return nil, errors.New("Liblib 转换后的局部重绘蒙版超过10MB")
	}
	return encoded.Bytes(), nil
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
		return "", liblibUploadFailure(err)
	}
	objectURL := strings.TrimRight(s.PostURL, "/") + "/" + strings.Join(liblibEscapeKey(s.Key), "/")
	return objectURL, nil
}

type liblibUploadAuthorizationError struct {
	Err     error
	message string
}

func (e liblibUploadAuthorizationError) Error() string { return e.message }

func (e liblibUploadAuthorizationError) Unwrap() error { return e.Err }

func liblibUploadFailure(err error) error {
	var httpErr providerHTTPError
	if !errors.As(err, &httpErr) || (httpErr.StatusCode != http.StatusUnauthorized && httpErr.StatusCode != http.StatusForbidden) {
		return err
	}
	message := "Liblib 素材上传被拒绝，请联系供应商或更换渠道"
	// Only classify an allowlisted OSS code; never publish its XML, message,
	// signed destination, or temporary credentials.
	var response struct {
		XMLName xml.Name `xml:"Error"`
		Code    string   `xml:"Code"`
	}
	if xml.Unmarshal([]byte(httpErr.Body), &response) == nil && response.Code == "InvalidAccessKeyId" {
		message = "Liblib 素材上传服务的存储凭据不可用，请联系供应商或更换渠道"
	}
	return liblibUploadAuthorizationError{Err: err, message: message}
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
