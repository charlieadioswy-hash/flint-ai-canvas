package model3d

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

//go:embed blender_convert.py
var blenderConversionScript []byte

var ErrBlenderUnavailable = errors.New("当前服务器未安装模型格式转换工具")

type ExportOptions struct {
	Format    string `json:"format"`
	Animation string `json:"animation,omitempty"`
	FPS       int    `json:"fps,omitempty"`
}

type ConversionRequest struct {
	SourcePath   string
	SourceFormat string
	OutputDir    string
	Options      ExportOptions
}

type ConversionOutput struct {
	Path     string
	FileName string
	MimeType string
	Format   string
	Bytes    int64
}

type Converter interface {
	Convert(context.Context, ConversionRequest) (ConversionOutput, error)
}

type blenderConverter struct{ binary string }

func NormalizeExportOptions(options ExportOptions) (ExportOptions, error) {
	if options.Format != "fbx" && options.Format != "abc" {
		return options, errors.New("转换格式须为 FBX 或 ABC")
	}
	if options.FPS == 0 {
		options.FPS = 30
	}
	if options.FPS < 1 || options.FPS > 120 {
		return options, errors.New("导出帧率须为 1–120")
	}
	if len(options.Animation) > 256 || !utf8.ValidString(options.Animation) || strings.IndexFunc(options.Animation, unicode.IsControl) >= 0 {
		return options, errors.New("导出动作名称无效")
	}
	return options, nil
}

func blenderBinary(binary string) string {
	if binary != "" {
		return binary
	}
	if configured := strings.TrimSpace(os.Getenv("CANVAS_BLENDER_BIN")); configured != "" {
		return configured
	}
	return "blender"
}

func NewBlenderConverter(binary string) Converter {
	return &blenderConverter{binary: blenderBinary(binary)}
}

func BlenderAvailable() bool {
	_, err := exec.LookPath(blenderBinary(""))
	return err == nil
}

func (converter *blenderConverter) Convert(ctx context.Context, request ConversionRequest) (ConversionOutput, error) {
	if err := ctx.Err(); err != nil {
		return ConversionOutput{}, err
	}
	options, err := NormalizeExportOptions(request.Options)
	if err != nil {
		return ConversionOutput{}, err
	}
	if !Contains([]string{"glb", "gltf", "fbx", "obj", "stl"}, request.SourceFormat) {
		return ConversionOutput{}, errors.New("不支持该模型源格式")
	}
	info, err := os.Lstat(request.SourcePath)
	if err != nil || !info.Mode().IsRegular() || info.Size() == 0 || info.Size() > MaxOutputBytes {
		return ConversionOutput{}, errors.New("源模型不存在、为空或超过 128 MiB")
	}
	data, err := os.ReadFile(request.SourcePath)
	if err != nil {
		return ConversionOutput{}, errors.New("无法读取源模型")
	}
	if err := validateConversionSource(data, request.SourceFormat); err != nil {
		return ConversionOutput{}, err
	}
	outputDir, err := filepath.Abs(request.OutputDir)
	if err != nil || request.OutputDir == "" {
		return ConversionOutput{}, errors.New("模型导出目录无效")
	}
	if err := os.MkdirAll(outputDir, 0700); err != nil {
		return ConversionOutput{}, errors.New("无法准备模型导出目录")
	}
	if request.SourceFormat == options.Format {
		return saveConversionOutput(outputDir, data, options.Format)
	}
	binary, err := exec.LookPath(converter.binary)
	if err != nil {
		return ConversionOutput{}, ErrBlenderUnavailable
	}
	workDir, err := os.MkdirTemp(outputDir, ".blender-")
	if err != nil {
		return ConversionOutput{}, errors.New("无法准备模型转换文件")
	}
	defer os.RemoveAll(workDir)
	sourcePath := filepath.Join(workDir, "source."+request.SourceFormat)
	outputPath := filepath.Join(workDir, "model."+options.Format)
	statusPath := filepath.Join(workDir, "status.json")
	manifest, _ := json.Marshal(struct {
		SourcePath   string        `json:"sourcePath"`
		SourceFormat string        `json:"sourceFormat"`
		OutputPath   string        `json:"outputPath"`
		StatusPath   string        `json:"statusPath"`
		Options      ExportOptions `json:"options"`
	}{sourcePath, request.SourceFormat, outputPath, statusPath, options})
	for name, contents := range map[string][]byte{"convert.py": blenderConversionScript, "request.json": manifest, "source." + request.SourceFormat: data} {
		if err := os.WriteFile(filepath.Join(workDir, name), contents, 0600); err != nil {
			return ConversionOutput{}, errors.New("无法准备模型转换文件")
		}
	}
	// A short-lived child process keeps Blender out of the API process. User
	// preferences and automatic scripts must never run while importing a model.
	processCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	command := exec.CommandContext(processCtx, binary, "--background", "--factory-startup", "--disable-autoexec", "--threads", "1", "--python-exit-code", "2", "--python", filepath.Join(workDir, "convert.py"), "--", filepath.Join(workDir, "request.json"))
	command.Dir = workDir
	command.Env = append(os.Environ(), "BLENDER_USER_CONFIG="+filepath.Join(workDir, "config"), "BLENDER_USER_SCRIPTS="+filepath.Join(workDir, "scripts"), "PYTHONNOUSERSITE=1")
	command.Stdout, command.Stderr = io.Discard, io.Discard
	command.WaitDelay = time.Second
	done := make(chan error, 1)
	go func() { done <- command.Run() }()
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	oversized := false
	var processErr error
running:
	for {
		select {
		case processErr = <-done:
			break running
		case <-ticker.C:
			if stat, err := os.Stat(outputPath); err == nil && stat.Size() > MaxOutputBytes {
				oversized = true
				cancel()
			}
		}
	}
	if err := ctx.Err(); err != nil {
		return ConversionOutput{}, err
	}
	if oversized {
		return ConversionOutput{}, errors.New("导出模型超过 128 MiB，请减少面数或缩短动作")
	}
	var status struct {
		Code string `json:"code"`
	}
	if statusData, err := os.ReadFile(statusPath); err == nil && len(statusData) < 1024 {
		_ = json.Unmarshal(statusData, &status)
	}
	if status.Code != "ok" || processErr != nil {
		return ConversionOutput{}, conversionFailure(status.Code)
	}
	info, err = os.Lstat(outputPath)
	if err != nil || !info.Mode().IsRegular() || info.Size() == 0 || info.Size() > MaxOutputBytes {
		return ConversionOutput{}, errors.New("模型转换未产出有效文件或超过 128 MiB")
	}
	data, err = os.ReadFile(outputPath)
	if err != nil {
		return ConversionOutput{}, errors.New("无法读取转换结果")
	}
	return saveConversionOutput(outputDir, data, options.Format)
}

func conversionFailure(code string) error {
	messages := map[string]string{
		"external":          "模型包含外部依赖，请先打包为自包含 GLB",
		"compression":       "源模型使用当前转换器不支持的压缩，请先导出未压缩 GLB",
		"multiple_clips":    "模型含多个动作，请选择要导出的动作",
		"missing_clip":      "模型中不存在所选动作，请重新选择",
		"invalid_animation": "模型动作无法完整转换，请更换动作或模型",
		"complex_animation": "多个对象的多动作无法完整导出 FBX，请先在建模软件中拆分动作或合并动画",
		"no_geometry":       "模型没有可导出的几何体",
		"unsupported":       "当前转换工具缺少该格式的导入或导出能力",
		"invalid_source":    "模型文件格式无效或无法解析",
	}
	if message := messages[code]; message != "" {
		return errors.New(message)
	}
	return errors.New("模型格式转换失败，请检查源模型后重试")
}

func saveConversionOutput(directory string, data []byte, format string) (ConversionOutput, error) {
	if len(data) == 0 || int64(len(data)) > MaxOutputBytes {
		return ConversionOutput{}, errors.New("导出模型为空或超过 128 MiB")
	}
	if format == "fbx" {
		if ValidateFile(data, "fbx") != nil {
			return ConversionOutput{}, errors.New("转换结果不是有效的 FBX 文件")
		}
	} else if len(data) < 16 || !bytes.HasPrefix(data, []byte("Ogawa")) || data[5] != 0xff {
		return ConversionOutput{}, errors.New("转换结果不是完整的 Alembic 文件")
	}
	name := "model." + format
	path := filepath.Join(directory, name)
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return ConversionOutput{}, errors.New("无法保存模型导出文件")
	}
	_, writeErr := file.Write(data)
	closeErr := file.Close()
	if writeErr != nil || closeErr != nil {
		_ = os.Remove(path)
		return ConversionOutput{}, errors.New("无法保存模型导出文件")
	}
	mimeType := "application/octet-stream"
	if format == "fbx" {
		mimeType = "application/vnd.autodesk.fbx"
	}
	return ConversionOutput{Path: path, FileName: name, MimeType: mimeType, Format: format, Bytes: int64(len(data))}, nil
}

func validateConversionSource(data []byte, format string) error {
	invalid := errors.New("模型文件格式无效或无法解析")
	external := errors.New("模型包含外部依赖，请先打包为自包含 GLB")
	switch format {
	case "fbx":
		if ValidateFile(data, format) != nil {
			return invalid
		}
	case "glb", "gltf":
		jsonData := data
		if format == "glb" {
			if ValidateFile(data, "glb") != nil {
				return invalid
			}
			jsonData = bytes.TrimRight(data[20:20+int(binary.LittleEndian.Uint32(data[12:16]))], " \x00")
		}
		var document struct {
			Asset struct {
				Version string `json:"version"`
			} `json:"asset"`
			Buffers []struct {
				URI string `json:"uri"`
			} `json:"buffers"`
			Images []struct {
				URI string `json:"uri"`
			} `json:"images"`
			ExtensionsRequired []string `json:"extensionsRequired"`
		}
		if json.Unmarshal(jsonData, &document) != nil || document.Asset.Version != "2.0" {
			return invalid
		}
		for _, buffer := range document.Buffers {
			if buffer.URI != "" && !strings.HasPrefix(buffer.URI, "data:") {
				return external
			}
		}
		for _, image := range document.Images {
			if image.URI != "" && !strings.HasPrefix(image.URI, "data:image/") {
				return external
			}
		}
		for _, extension := range document.ExtensionsRequired {
			if extension == "EXT_meshopt_compression" || extension == "KHR_draco_mesh_compression" {
				return conversionFailure("compression")
			}
		}
	case "obj":
		if !utf8.Valid(data) || bytes.IndexByte(data, 0) >= 0 {
			return invalid
		}
		for _, line := range bytes.Split(data, []byte{'\n'}) {
			fields := strings.Fields(string(line))
			if len(fields) > 0 && Contains([]string{"mtllib", "usemap", "maplib", "call", "csh", "shadow_obj", "trace_obj"}, strings.ToLower(fields[0])) {
				return external
			}
		}
	case "stl":
		binarySTL := len(data) >= 84 && uint64(binary.LittleEndian.Uint32(data[80:84]))*50+84 == uint64(len(data))
		asciiSTL := bytes.HasPrefix(bytes.TrimSpace(data), []byte("solid")) && bytes.Contains(data, []byte("facet")) && bytes.Contains(data, []byte("endsolid"))
		if !binarySTL && !asciiSTL {
			return invalid
		}
	}
	return nil
}
