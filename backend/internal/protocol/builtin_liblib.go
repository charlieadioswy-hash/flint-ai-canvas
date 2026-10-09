package protocol

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

const LiblibImageProtocolID = "liblib-image"

func liblibImageAdapter() Adapter {
	info := metadata(LiblibImageProtocolID, "Liblib 图片与 ControlNet", "LiblibAI", CapabilityImage, "POST /api/generate/webui/text2img", "POST /api/generate/webui/status", "application/json")
	info.Version = "1.0.2"
	info.SupportsControlNet = true
	info.Parameters = []Parameter{
		{Name: "family", Type: "string", Values: []string{"f1", "sd"}, Description: "基础算法", Mapping: "providerOptions.liblib-image.family"},
		{Name: "templateUuid", Type: "string", Description: "固定模板 UUID（覆盖按生成方式选择的模板）", Mapping: "providerOptions.liblib-image.templateUuid"},
		{Name: "textToImageTemplateUuid", Type: "string", Description: "文生图模板 UUID", Mapping: "providerOptions.liblib-image.textToImageTemplateUuid"},
		{Name: "imageToImageTemplateUuid", Type: "string", Description: "图生图模板 UUID", Mapping: "providerOptions.liblib-image.imageToImageTemplateUuid"},
		{Name: "controlNetModel", Type: "string", Description: "默认 Canny 控制模型 UUID", Mapping: "providerOptions.liblib-image.controlNetModel"},
		{Name: "checkPointId", Type: "string", Description: "基础模型 UUID（留空使用渠道上游模型）", Mapping: "providerOptions.liblib-image.checkPointId"},
		{Name: "steps", Type: "integer", Description: "采样步数", Mapping: "providerOptions.liblib-image.steps"},
		{Name: "sampler", Type: "integer", Description: "采样器枚举", Mapping: "providerOptions.liblib-image.sampler"},
		{Name: "cfgScale", Type: "number", Description: "提示词引导系数", Mapping: "providerOptions.liblib-image.cfgScale"},
		{Name: "seed", Type: "integer", Description: "随机种子（-1 随机）", Mapping: "providerOptions.liblib-image.seed"},
		{Name: "negativePrompt", Type: "string", Description: "负向提示词", Mapping: "providerOptions.liblib-image.negativePrompt"},
		{Name: "denoisingStrength", Type: "number", Description: "图生图重绘幅度（0–1）", Mapping: "providerOptions.liblib-image.denoisingStrength"},
		{Name: "width", Type: "integer", Description: "输出宽度", Mapping: "providerOptions.liblib-image.width"},
		{Name: "height", Type: "integer", Description: "输出高度", Mapping: "providerOptions.liblib-image.height"},
	}
	info.Execution = "declarative"
	return builtinAdapter{info: info, create: buildLiblibCreate, parseCreate: parseLiblibCreate,
		poll: func(c PollContext) (RequestSpec, error) {
			if strings.TrimSpace(c.TaskID) == "" {
				return RequestSpec{}, fmt.Errorf("Liblib 查询缺少原生成任务 ID")
			}
			return liblibJSONSpec("/api/generate/webui/status", map[string]any{"generateUuid": c.TaskID}), nil
		}, parsePoll: parseLiblibPoll}
}

func liblibJSONSpec(path string, body any) RequestSpec {
	return RequestSpec{Method: http.MethodPost, Path: path, OriginPath: true, ContentType: "application/json", Body: body,
		Auth: ManifestAuth{Type: "liblib-hmac-sha1", Field: "apiKey", SecretField: "secretKey"}}
}

// ValidateLiblibRequest checks configuration before upload, queueing or billing.
// Media references may still be local here; BuildCreate requires prepared URLs.
func ValidateLiblibRequest(r GenerationRequest) error {
	o := r.ProviderOptions[LiblibImageProtocolID]
	family := liblibOptionString(o, "family")
	if family != "f1" && family != "sd" {
		return fmt.Errorf("Liblib 需要配置 family 为 f1 或 sd")
	}
	if !liblibUUID(liblibOptionString(o, "templateUuid")) {
		return fmt.Errorf("Liblib 需要配置有效的 templateUuid；请使用官方模板 UUID")
	}
	model := liblibOptionString(o, "checkPointId")
	if model == "" {
		model = strings.TrimSpace(r.Model)
	}
	if family == "sd" && !liblibUUID(model) {
		return fmt.Errorf("Liblib 需要有效的基础模型 checkPointId UUID")
	}
	for _, name := range []string{"steps", "sampler", "cfgScale"} {
		if family == "f1" && name != "steps" {
			continue
		}
		value, ok := liblibNumber(o[name])
		if !ok || value < 0 || (name == "steps" && value < 1) || (name != "cfgScale" && value != math.Trunc(value)) {
			return fmt.Errorf("Liblib 参数 %s 缺失或无效", name)
		}
	}
	width, height, err := liblibOutputSize(r)
	if err != nil || width <= 0 || height <= 0 || width > 4096 || height > 4096 {
		return fmt.Errorf("Liblib 需要明确的输出宽高，范围为 1–4096")
	}
	if r.ImageCount < 0 || r.ImageCount > 4 || r.Output.Count < 0 || r.Output.Count > 4 {
		return fmt.Errorf("Liblib 单次生成图片数量须为 1–4")
	}
	if len(r.Images) > 1 {
		return fmt.Errorf("Liblib 图生图只支持一张普通参考图；控制图应通过 ControlNet 单元传入")
	}
	for _, image := range r.Images {
		if image.Role == "mask" {
			return fmt.Errorf("Liblib 常规图片蒙版编辑尚未配置；请使用控制影响蒙版或输出范围蒙版")
		}
	}
	if len(r.Images) == 1 {
		strength, ok := liblibNumber(o["denoisingStrength"])
		if !ok || strength < 0 || strength > 1 {
			return fmt.Errorf("Liblib 图生图需要 denoisingStrength，范围为 0–1")
		}
	}
	if seed, present := o["seed"]; present {
		value, ok := liblibNumber(seed)
		if !ok || value < -1 || value != math.Trunc(value) {
			return fmt.Errorf("Liblib seed 须为 -1 或非负整数")
		}
	}
	if len(r.ControlNet) > 4 {
		return fmt.Errorf("Liblib 最多支持 4 个 ControlNet 单元")
	}
	for index, unit := range r.ControlNet {
		if err := unit.Parameters.Validate(false); err != nil {
			return fmt.Errorf("ControlNet 单元 %d：%w", index+1, err)
		}
		if unit.Parameters.Preprocessor != "canny" {
			return fmt.Errorf("Liblib 首版仅支持 Canny 轮廓控制")
		}
		if !liblibUUID(unit.Parameters.Model) {
			return fmt.Errorf("ControlNet 单元 %d 需要有效的平台控制模型 UUID", index+1)
		}
	}
	return nil
}

func buildLiblibCreate(r GenerationRequest) (RequestSpec, error) {
	if err := ValidateLiblibRequest(r); err != nil {
		return RequestSpec{}, err
	}
	o := r.ProviderOptions[LiblibImageProtocolID]
	width, height, _ := liblibOutputSize(r)
	model := liblibOptionString(o, "checkPointId")
	if model == "" {
		model = r.Model
	}
	count := r.Output.Count
	if count == 0 {
		count = r.ImageCount
	}
	if count == 0 {
		count = 1
	}
	params := map[string]any{"prompt": r.Prompt, "imgCount": count, "steps": o["steps"], "seed": -1}
	if liblibOptionString(o, "family") == "sd" {
		params["checkPointId"] = model
		params["sampler"] = o["sampler"]
		params["cfgScale"] = o["cfgScale"]
	}
	for _, name := range []string{"seed", "negativePrompt", "vaeId", "clipSkip", "randnSource", "restoreFaces", "denoisingStrength"} {
		if value, ok := o[name]; ok {
			params[name] = value
		}
	}
	path := "/api/generate/webui/text2img"
	if len(r.Images) == 1 {
		imageURL, err := liblibPublicURL(r.Images[0])
		if err != nil {
			return RequestSpec{}, err
		}
		params["sourceImage"] = imageURL
		// Liblib img2img uses resized dimensions; mode 0 is ordinary image editing.
		params["resizedWidth"], params["resizedHeight"] = width, height
		params["resizeMode"], params["mode"] = 0, 0
		path = "/api/generate/webui/img2img"
	} else {
		params["width"], params["height"] = width, height
	}
	units := make([]any, 0, len(r.ControlNet))
	for index, unit := range r.ControlNet {
		imageURL, err := liblibPublicURL(unit.Image)
		if err != nil {
			return RequestSpec{}, fmt.Errorf("ControlNet 单元 %d：%w", index+1, err)
		}
		w, h := liblibMediaDimension(unit.Image, "width"), liblibMediaDimension(unit.Image, "height")
		if w < 1 || h < 1 || w > 4096 || h > 4096 {
			return RequestSpec{}, fmt.Errorf("ControlNet 参考图必须提供真实宽高，分别不超过4096")
		}
		p := unit.Parameters
		wire := map[string]any{"unitOrder": index + 1, "sourceImage": imageURL, "width": w, "height": h, "preprocessor": 1,
			"annotationParameters": map[string]any{"canny": map[string]any{"preprocessorResolution": p.Canny.Resolution, "lowThreshold": p.Canny.LowThreshold, "highThreshold": p.Canny.HighThreshold}},
			"model":                p.Model, "controlWeight": p.Strength, "startingControlStep": p.Start, "endingControlStep": p.End,
			"pixelPerfect": liblibBool(p.PixelPerfect), "controlMode": map[string]int{"balanced": 0, "prompt": 1, "control": 2}[p.ControlMode], "resizeMode": map[string]int{"stretch": 0, "crop": 1, "fill": 2}[p.ResizeMode]}
		if unit.Mask != nil {
			maskURL, err := liblibPublicURL(*unit.Mask)
			if err != nil {
				return RequestSpec{}, err
			}
			if liblibMediaDimension(*unit.Mask, "width") != w || liblibMediaDimension(*unit.Mask, "height") != h {
				return RequestSpec{}, fmt.Errorf("ControlNet 蒙版须与参考图同尺寸")
			}
			wire["maskImage"] = maskURL
		}
		units = append(units, wire)
	}
	if len(units) > 0 {
		params["controlNet"] = units
	}
	return liblibJSONSpec(path, map[string]any{"templateUuid": o["templateUuid"], "generateParams": params}), nil
}

func parseLiblibCreate(payload map[string]any) (CreateResult, error) {
	data, err := liblibEnvelope(payload)
	if err != nil {
		return CreateResult{}, err
	}
	id := strings.TrimSpace(firstString(data, "generateUuid"))
	if id == "" {
		return CreateResult{}, fmt.Errorf("Liblib 创建响应缺少 generateUuid")
	}
	return CreateResult{TaskID: id, Status: StatusPending}, nil
}

func parseLiblibPoll(c PollContext, payload map[string]any) (PollResult, error) {
	data, err := liblibEnvelope(payload)
	if err != nil {
		return PollResult{}, err
	}
	id := strings.TrimSpace(firstString(data, "generateUuid"))
	if id == "" || id != c.TaskID {
		return PollResult{}, fmt.Errorf("Liblib 查询响应的 generateUuid 与原任务不一致")
	}
	state, ok := liblibNumber(data["generateStatus"])
	if !ok || state != math.Trunc(state) {
		return PollResult{}, fmt.Errorf("Liblib 查询缺少有效 generateStatus")
	}
	result := PollResult{TaskID: id, Message: firstString(data, "generateMsg")}
	switch int(state) {
	case 1:
		result.Status = StatusPending
	case 2, 3, 4:
		result.Status = StatusProcessing
	case 6, 7:
		result.Status = StatusFailed
		if result.Message == "" {
			result.Message = "Liblib 图片任务失败或超时"
		}
	case 5:
		result.Status = StatusSucceeded
		media := []MediaReference{}
		images, _ := data["images"].([]any)
		for _, raw := range images {
			item, _ := raw.(map[string]any)
			if audit, present := item["auditStatus"]; present {
				value, valid := liblibNumber(audit)
				if !valid || value != 3 {
					continue
				}
			}
			imageURL := strings.TrimSpace(firstString(item, "imageUrl"))
			if imageURL == "" {
				continue
			}
			if _, err := liblibPublicURL(MediaReference{URL: imageURL}); err != nil {
				return PollResult{}, err
			}
			media = append(media, MediaReference{URL: imageURL, Kind: "image", Metadata: map[string]any{"seed": item["seed"], "auditStatus": item["auditStatus"]}})
		}
		if len(media) == 0 {
			return PollResult{}, fmt.Errorf("Liblib 任务成功但没有可用且审核通过的图片")
		}
		result.Result = &Result{Images: media}
	default:
		return PollResult{}, fmt.Errorf("Liblib 返回未知生成状态 %d", int(state))
	}
	return result, nil
}

func liblibEnvelope(payload map[string]any) (map[string]any, error) {
	code, ok := liblibNumber(payload["code"])
	if !ok {
		return nil, fmt.Errorf("Liblib 响应缺少业务状态码")
	}
	if code != 0 {
		return nil, fmt.Errorf("Liblib 拒绝请求（code=%v）：%s", payload["code"], firstString(payload, "msg"))
	}
	data, ok := payload["data"].(map[string]any)
	if !ok {
		return nil, fmt.Errorf("Liblib 响应缺少 data")
	}
	return data, nil
}

func liblibPublicURL(media MediaReference) (string, error) {
	value := strings.TrimSpace(media.URL)
	u, err := url.Parse(value)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" || u.User != nil {
		return "", fmt.Errorf("Liblib 图片需要准备为公网 HTTP(S) URL")
	}
	return value, nil
}

func liblibMediaDimension(media MediaReference, key string) int {
	value, ok := liblibNumber(media.Metadata[key])
	if !ok || value != math.Trunc(value) {
		return 0
	}
	return int(value)
}

func liblibOutputSize(r GenerationRequest) (int, int, error) {
	if r.Output.Width > 0 && r.Output.Height > 0 {
		return r.Output.Width, r.Output.Height, nil
	}
	o := r.ProviderOptions[LiblibImageProtocolID]
	if w, ok := liblibNumber(o["width"]); ok {
		if h, valid := liblibNumber(o["height"]); valid && w == math.Trunc(w) && h == math.Trunc(h) {
			return int(w), int(h), nil
		}
	}
	parts := strings.Split(strings.ToLower(strings.TrimSpace(r.AspectRatio)), "x")
	if len(parts) != 2 {
		return 0, 0, fmt.Errorf("输出尺寸不是明确像素宽高")
	}
	w, ew := strconv.Atoi(parts[0])
	h, eh := strconv.Atoi(parts[1])
	if ew != nil || eh != nil {
		return 0, 0, fmt.Errorf("输出尺寸无效")
	}
	return w, h, nil
}

func liblibOptionString(o map[string]any, key string) string {
	value, _ := o[key].(string)
	return strings.TrimSpace(value)
}
func liblibUUID(value string) bool {
	value = strings.ReplaceAll(strings.TrimSpace(value), "-", "")
	if len(value) != 32 {
		return false
	}
	_, err := hex.DecodeString(value)
	return err == nil
}
func liblibBool(value bool) int {
	if value {
		return 1
	}
	return 0
}
func liblibNumber(value any) (float64, bool) {
	var number float64
	switch v := value.(type) {
	case float64:
		number = v
	case float32:
		number = float64(v)
	case int:
		number = float64(v)
	case int64:
		number = float64(v)
	case json.Number:
		parsed, err := v.Float64()
		if err != nil {
			return 0, false
		}
		number = parsed
	default:
		return 0, false
	}
	return number, !math.IsNaN(number) && !math.IsInf(number, 0)
}

// LiblibImageAdapter is available to plugin installers and isolated protocol tests.
func LiblibImageAdapter() Adapter { return liblibImageAdapter() }
