package model3d

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"
)

const ProviderTripo = "tripo3d"
const MaxInputBytes int64 = 20 << 20
const MaxOutputBytes int64 = 128 << 20

type ModelVersion struct {
	ID               string `json:"id"`
	Label            string `json:"label"`
	SupportsAdvanced bool   `json:"supportsAdvanced"`
	MaxFacesStandard int64  `json:"maxFacesStandard"`
	MaxFacesDetailed int64  `json:"maxFacesDetailed"`
}

var modelVersions = []ModelVersion{
	{"v3.1-20260211", "Tripo H3.1", true, 1500000, 2000000},
	{"v3.0-20250812", "Tripo H3.0", true, 1000000, 2000000},
	{"v2.5-20250123", "Tripo H2.5", false, 500000, 500000},
}

func Models() []ModelVersion { return append([]ModelVersion(nil), modelVersions...) }

type Parameters struct {
	Model              string `json:"model"`
	NegativePrompt     string `json:"negativePrompt,omitempty"`
	Texture            bool   `json:"texture"`
	PBR                bool   `json:"pbr"`
	FaceLimit          *int64 `json:"faceLimit,omitempty"`
	ModelSeed          *int64 `json:"modelSeed,omitempty"`
	ImageSeed          *int64 `json:"imageSeed,omitempty"`
	TextureSeed        *int64 `json:"textureSeed,omitempty"`
	TextureQuality     string `json:"textureQuality,omitempty"`
	TextureVersion     string `json:"textureVersion,omitempty"`
	GeometryQuality    string `json:"geometryQuality,omitempty"`
	AutoSize           *bool  `json:"autoSize,omitempty"`
	Quad               *bool  `json:"quad,omitempty"`
	SmartLowPoly       *bool  `json:"smartLowPoly,omitempty"`
	Compress           string `json:"compress,omitempty"`
	ExportOrientation  string `json:"exportOrientation,omitempty"`
	ExportUV           *bool  `json:"exportUv,omitempty"`
	Delight            *bool  `json:"delight,omitempty"`
	EnableImageAutofix *bool  `json:"enableImageAutofix,omitempty"`
	TextureAlignment   string `json:"textureAlignment,omitempty"`
	Orientation        string `json:"orientation,omitempty"`
}

type Config struct {
	Type           string
	APIKey         string
	DefaultModel   string
	AllowedModels  []string
	AllowedModes   []string
	TimeoutSeconds int
	MaxTasksPerDay int
}

func Contains(values []string, value string) bool {
	for _, candidate := range values {
		if candidate == value {
			return true
		}
	}
	return false
}

func ValidateConfig(config Config) error {
	if config.Type != ProviderTripo {
		return errors.New("仅支持 Tripo3D")
	}
	if strings.TrimSpace(config.APIKey) == "" || len(config.APIKey) > 4096 || strings.ContainsAny(config.APIKey, "\r\n") {
		return errors.New("须填写有效 API Key")
	}
	if config.TimeoutSeconds < 10 || config.TimeoutSeconds > 120 {
		return errors.New("请求超时须为 10–120 秒")
	}
	if config.MaxTasksPerDay < 1 || config.MaxTasksPerDay > 100000 {
		return errors.New("每日任务上限须为 1–100000")
	}
	if len(config.AllowedModels) == 0 || len(config.AllowedModels) > len(modelVersions) || len(config.AllowedModes) == 0 || len(config.AllowedModes) > 3 {
		return errors.New("须选择可用模型和生成方式")
	}
	seen := map[string]bool{}
	for _, id := range config.AllowedModels {
		if _, ok := Model(id); !ok || seen[id] {
			return errors.New("模型版本无效或重复")
		}
		seen[id] = true
	}
	seen = map[string]bool{}
	for _, mode := range config.AllowedModes {
		if !Contains([]string{"text", "image", "multiview"}, mode) || seen[mode] {
			return errors.New("生成方式无效或重复")
		}
		seen[mode] = true
	}
	if !Contains(config.AllowedModels, config.DefaultModel) {
		return errors.New("默认模型须在可用模型中")
	}
	return nil
}

func Model(id string) (ModelVersion, bool) {
	for _, model := range modelVersions {
		if model.ID == id {
			return model, true
		}
	}
	return ModelVersion{}, false
}

func enabled(value *bool) bool { return value != nil && *value }

func ValidateParameters(mode, prompt string, p Parameters, config Config) error {
	version, ok := Model(p.Model)
	if !ok || !Contains(config.AllowedModels, p.Model) || !Contains(config.AllowedModes, mode) {
		return errors.New("生成方式或模型未开放")
	}
	if mode == "text" && strings.TrimSpace(prompt) == "" {
		return errors.New("文本生成须填写提示词")
	}
	if utf8.RuneCountInString(prompt) > 1024 || utf8.RuneCountInString(p.NegativePrompt) > 255 {
		return errors.New("提示词最多 1024 字，负面提示词最多 255 字")
	}
	if mode != "text" && (prompt != "" || p.NegativePrompt != "" || p.ImageSeed != nil) {
		return errors.New("图片生成不支持文本提示词或图片种子")
	}
	if p.PBR && !p.Texture {
		return errors.New("PBR 材质需要开启纹理")
	}
	if !version.SupportsAdvanced && (p.TextureQuality != "" || p.AutoSize != nil || p.Quad != nil || p.SmartLowPoly != nil || p.Compress != "") {
		return errors.New("所选高级参数仅支持 H3.0/H3.1")
	}
	if p.GeometryQuality != "" && (!version.SupportsAdvanced || !Contains([]string{"standard", "detailed"}, p.GeometryQuality)) {
		return errors.New("几何质量仅支持 H3.0/H3.1 的 standard 或 detailed")
	}
	if p.TextureQuality != "" && !Contains([]string{"standard", "detailed", "extreme", "fast"}, p.TextureQuality) {
		return errors.New("纹理质量无效")
	}
	if p.TextureQuality == "fast" && p.TextureVersion != "v3.5-20260815" {
		return errors.New("快速纹理须选择 v3.5-20260815")
	}
	if p.TextureVersion != "" && !Contains([]string{"v2.5-20250123", "v3.0-20250812", "v3.5-20260815"}, p.TextureVersion) {
		return errors.New("纹理版本无效")
	}
	if p.Delight != nil && (!p.Texture || p.TextureVersion != "v3.5-20260815") {
		return errors.New("去光照参数需要开启纹理并选择 v3.5-20260815")
	}
	if p.Compress != "" && p.Compress != "geometry" {
		return errors.New("压缩方式无效")
	}
	if p.ExportOrientation != "" && !Contains([]string{"+x", "-x", "+y", "-y"}, p.ExportOrientation) {
		return errors.New("导出方向无效")
	}
	if p.TextureAlignment != "" && !Contains([]string{"original_image", "geometry"}, p.TextureAlignment) {
		return errors.New("纹理对齐方式无效")
	}
	if p.Orientation != "" && !Contains([]string{"default", "align_image"}, p.Orientation) {
		return errors.New("模型朝向无效")
	}
	if mode == "text" && (p.EnableImageAutofix != nil || p.TextureAlignment != "" || p.Orientation != "") {
		return errors.New("文本生成不支持图片修复或图片对齐参数")
	}
	if mode == "multiview" && p.EnableImageAutofix != nil {
		return errors.New("多视图不支持单图自动修复")
	}
	if !p.Texture && (p.TextureQuality != "" || p.TextureVersion != "" || p.TextureSeed != nil || p.TextureAlignment != "" || p.Orientation != "") {
		return errors.New("纹理参数需要开启纹理")
	}
	maxFaces := version.MaxFacesStandard
	if p.GeometryQuality == "detailed" {
		maxFaces = version.MaxFacesDetailed
	}
	if enabled(p.Quad) {
		maxFaces = 150000
	}
	minFaces := int64(1)
	if enabled(p.SmartLowPoly) {
		minFaces, maxFaces = 500, 20000
		if enabled(p.Quad) {
			maxFaces = 10000
		}
	}
	if p.FaceLimit != nil && (*p.FaceLimit < minFaces || *p.FaceLimit > maxFaces) {
		return fmt.Errorf("面数须为 %d–%d", minFaces, maxFaces)
	}
	return nil
}

type Image struct {
	View        string
	FileName    string
	ContentType string
	Data        []byte
}
type Request struct {
	Mode       string
	Prompt     string
	Parameters Parameters
	Images     []Image
}
type Artifact struct {
	URL    string `json:"url"`
	Format string `json:"format"`
}
type State struct {
	Status    string
	Progress  int
	Artifact  Artifact
	ErrorCode string
}

// Provider has no hidden retries: Submit may create a billable task exactly once.
type Provider interface {
	Upload(context.Context, Config, Image) (string, error)
	Submit(context.Context, Config, Request, map[string]string) (string, error)
	Poll(context.Context, Config, string, bool) (State, error)
	Download(context.Context, Artifact) ([]byte, error)
}

type Error struct {
	Code     string
	Message  string
	Definite bool
}

func (e *Error) Error() string { return e.Message }
