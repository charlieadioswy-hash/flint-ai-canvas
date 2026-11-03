package app

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"path/filepath"
	"strings"
	"time"
	"unicode"

	"gorm.io/gorm"
	"yingce/backend/internal/model"
	"yingce/backend/internal/model3d"
	"yingce/backend/internal/repository"
)

type Model3DExportRequest struct {
	RequestID    string `json:"requestId"`
	ResourceID   string `json:"resourceId"`
	SourceFormat string `json:"sourceFormat"`
	FileName     string `json:"fileName,omitempty"`
	Format       string `json:"format"`
	Animation    string `json:"animation,omitempty"`
	FPS          int    `json:"fps,omitempty"`
}

type Model3DExportCapabilities struct {
	Available bool     `json:"available"`
	Formats   []string `json:"formats"`
}

type Model3DExportResult struct {
	ResourceID string `json:"resourceId"`
	StorageKey string `json:"storageKey"`
	URL        string `json:"url"`
	Format     string `json:"format"`
	FileName   string `json:"fileName"`
	MimeType   string `json:"mimeType"`
	Bytes      int64  `json:"bytes"`
}

type Model3DExportView struct {
	ID       string               `json:"id"`
	Status   model.TaskStatus     `json:"status"`
	Stage    string               `json:"stage"`
	Progress int                  `json:"progress"`
	Error    string               `json:"error,omitempty"`
	Result   *Model3DExportResult `json:"result,omitempty"`
}

type model3DExportInput struct {
	ResourceID      string                `json:"resourceId"`
	ResourceVersion string                `json:"resourceVersion"`
	SourceFormat    string                `json:"sourceFormat"`
	FileName        string                `json:"fileName"`
	Options         model3d.ExportOptions `json:"options"`
}

func (s *Service) Model3DExportCapabilities(userID string) (*Model3DExportCapabilities, error) {
	if _, err := s.repo.User(userID); err != nil {
		return nil, err
	}
	return &Model3DExportCapabilities{Available: s.model3DConverter != nil || model3d.BlenderAvailable(), Formats: []string{"fbx", "abc"}}, nil
}

func normalizeModel3DExportRequest(req Model3DExportRequest) (Model3DExportRequest, error) {
	req.RequestID = strings.TrimSpace(req.RequestID)
	if err := validateModel3DExportRequestID(req.RequestID); err != nil {
		return req, err
	}
	req.SourceFormat = strings.ToLower(strings.TrimSpace(req.SourceFormat))
	switch req.SourceFormat {
	case "glb", "gltf", "fbx", "obj", "stl":
	default:
		return req, BadAuthRequest("不支持此模型源格式")
	}
	options, err := model3d.NormalizeExportOptions(model3d.ExportOptions{Format: req.Format, Animation: req.Animation, FPS: req.FPS})
	if err != nil {
		return req, BadAuthRequest(err.Error())
	}
	req.Format, req.Animation, req.FPS = options.Format, options.Animation, options.FPS
	req.ResourceID = strings.TrimSpace(req.ResourceID)
	req.FileName = model3DExportFileName(req.FileName, req.Format)
	return req, nil
}

func validateModel3DExportRequestID(id string) error {
	if len(id) == 0 || len(id) > 80 {
		return BadAuthRequest("导出请求标识须为 1–80 个字符")
	}
	for _, ch := range id {
		if !(ch >= 'a' && ch <= 'z' || ch >= 'A' && ch <= 'Z' || ch >= '0' && ch <= '9' || ch == '-' || ch == '_') {
			return BadAuthRequest("导出请求标识只能包含字母、数字、横线和下划线")
		}
	}
	return nil
}

func model3DExportFileName(name, format string) string {
	name = filepath.Base(strings.ReplaceAll(strings.TrimSpace(name), "\\", "/"))
	name = strings.TrimSuffix(name, filepath.Ext(name))
	name = strings.Map(func(ch rune) rune {
		if unicode.IsControl(ch) || strings.ContainsRune(`<>:"/\|?*`, ch) {
			return '_'
		}
		return ch
	}, name)
	if name == "" || name == "." || name == ".." {
		name = "model"
	}
	return string([]rune(name)[:min(len([]rune(name)), 100)]) + "." + format
}

func (s *Service) cancelledModel3DExportRequest(userID, requestID string) (*Model3DExportView, error) {
	request, err := s.repo.Model3DRequestForUser(userID, "export:"+requestID)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if request.RequestHash == repository.Model3DExportCancelledHash {
		return s.Model3DExport(userID, request.TaskID)
	}
	return nil, nil
}

// Uploads are ordinary quota-controlled owned resources. Only an explicit
// export uploads a local source; generated sources reference their original ID.
func (s *Service) CreateModel3DExportUpload(ctx context.Context, userID string, req Model3DExportRequest, header *multipart.FileHeader) (*Model3DExportView, error) {
	req, err := normalizeModel3DExportRequest(req)
	if err != nil {
		return nil, err
	}
	if header == nil || header.Size <= 0 || header.Size > model3d.MaxOutputBytes || req.ResourceID != "" {
		return nil, BadAuthRequest("请选择不超过 128MB 的模型文件，且不要同时指定已有资源")
	}
	if view, err := s.cancelledModel3DExportRequest(userID, req.RequestID); view != nil || err != nil {
		return view, err
	}
	if !(req.SourceFormat == "fbx" && req.Format == "fbx") && s.model3DConverter == nil && !model3d.BlenderAvailable() {
		return nil, NewAppError(503, "服务器尚未配置 Blender，暂时无法转换 FBX／ABC")
	}
	file, err := header.Open()
	if err != nil {
		return nil, BadAuthRequest("无法读取模型文件")
	}
	defer file.Close()
	hash := sha256.New()
	if count, err := io.Copy(hash, io.LimitReader(file, model3d.MaxOutputBytes+1)); err != nil || count != header.Size {
		return nil, BadAuthRequest("模型文件不完整或超过 128MB")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if view, err := s.cancelledModel3DExportRequest(userID, req.RequestID); view != nil || err != nil {
		return view, err
	}
	resource, err := s.UploadResource(userID, header, "model", 0, 0, 0, "model3d-export-source:"+hex.EncodeToString(hash.Sum(nil)))
	if err != nil {
		return nil, err
	}
	req.ResourceID = resource.ID
	return s.CreateModel3DExport(userID, req)
}

func (s *Service) CreateModel3DExport(userID string, req Model3DExportRequest) (*Model3DExportView, error) {
	req, err := normalizeModel3DExportRequest(req)
	if err != nil {
		return nil, err
	}
	if view, err := s.cancelledModel3DExportRequest(userID, req.RequestID); view != nil || err != nil {
		return view, err
	}
	if s.IsDraining() {
		return nil, NewAppError(503, "服务正在维护，暂不接受新的导出任务")
	}
	resource, err := s.Resource(userID, req.ResourceID)
	if err != nil || resource == nil || resource.Status != model.ResourceStatusReady {
		return nil, BadAuthRequest("模型源文件不存在或无权访问")
	}
	if resource.Size <= 0 || resource.Size > model3d.MaxOutputBytes {
		return nil, BadAuthRequest("模型源文件必须为 1 字节至 128MB")
	}
	input := model3DExportInput{ResourceID: resource.ID, ResourceVersion: model.ImageModerationResourceVersion(resource), SourceFormat: req.SourceFormat, FileName: req.FileName, Options: model3d.ExportOptions{Format: req.Format, Animation: req.Animation, FPS: req.FPS}}
	encoded, _ := json.Marshal(input)
	hash := sha256.Sum256(encoded)
	request := model.Model3DRequest{UserID: userID, RequestID: "export:" + req.RequestID, RequestHash: hex.EncodeToString(hash[:])}
	// Replay still works when Blender was removed after the original export.
	if existing, lookupErr := s.repo.Model3DRequestForUser(userID, request.RequestID); lookupErr == nil {
		if existing.RequestHash != request.RequestHash {
			return nil, NewAppError(409, "相同 requestId 不能用于不同导出请求")
		}
		return s.Model3DExport(userID, existing.TaskID)
	} else if !errors.Is(lookupErr, gorm.ErrRecordNotFound) {
		return nil, lookupErr
	}
	passthrough := req.SourceFormat == "fbx" && req.Format == "fbx"
	if passthrough {
		_, reader, err := s.OpenResource(userID, resource.ID)
		if err != nil {
			return nil, BadAuthRequest("无法读取原生 FBX 文件")
		}
		header, readErr := io.ReadAll(io.LimitReader(reader, 4096))
		_ = reader.Close()
		if readErr != nil || model3d.ValidateFile(header, "fbx") != nil {
			return nil, BadAuthRequest("源文件不是有效的 FBX，请选择正确的模型格式")
		}
	}
	if !passthrough && s.model3DConverter == nil && !model3d.BlenderAvailable() {
		return nil, NewAppError(503, "服务器尚未配置 Blender，暂时无法转换 FBX／ABC")
	}
	policy, err := s.RuntimePolicy()
	if err != nil {
		return nil, err
	}
	task := model.Task{ID: newID(), UserID: userID, Type: model.TaskTypeModel3DExport, Provider: "local", Model: "blender", Prompt: "3D 模型导出", Status: model.TaskStatusQueued, Stage: "等待导出", Progress: 0, InputJSON: string(encoded)}
	if passthrough {
		result := model3DExportResourceResult(resource, req.FileName, "fbx")
		data, _ := json.Marshal(result)
		task.Status, task.Stage, task.Progress, task.ResultJSON, task.CompletedAt = model.TaskStatusSucceeded, "原生 FBX 可直接下载", 100, string(data), ptr(time.Now())
	}
	request.TaskID = task.ID
	s.storageMu.Lock()
	admitted, err := s.repo.AdmitModel3DExport(&task, &request, resource.ID, input.ResourceVersion, func(repo *repository.Repository) error {
		return createModel3DExportTask(repo, &task, policy)
	})
	s.storageMu.Unlock()
	if err != nil {
		if errors.Is(err, repository.ErrModel3DConflict) {
			return nil, NewAppError(409, "导出请求或源文件已变化，请重新导出")
		}
		if errors.Is(err, repository.ErrActiveTaskLimit) {
			return nil, BadAuthRequest(fmt.Sprintf("同时排队或运行的任务最多 %d 个", policy.Task.ActiveTaskLimit))
		}
		return nil, err
	}
	s.wakeTaskDispatcher()
	return model3DExportView(admitted)
}

func model3DExportResourceResult(resource *model.Resource, fileName, format string) Model3DExportResult {
	return Model3DExportResult{ResourceID: resource.ID, StorageKey: "resource:" + resource.ID, URL: resourceFileURL(resource.ID), Format: format, FileName: fileName, MimeType: resource.MimeType, Bytes: resource.Size}
}

func model3DExportView(task *model.Task) (*Model3DExportView, error) {
	if task.Type != model.TaskTypeModel3DExport {
		return nil, gorm.ErrRecordNotFound
	}
	view := &Model3DExportView{ID: task.ID, Status: task.Status, Stage: task.Stage, Progress: task.Progress, Error: task.Error}
	if task.Status == model.TaskStatusSucceeded {
		if err := json.Unmarshal([]byte(task.ResultJSON), &view.Result); err != nil {
			return nil, err
		}
	}
	return view, nil
}

func (s *Service) Model3DExport(userID, id string) (*Model3DExportView, error) {
	task, err := s.repo.TaskForUser(userID, id)
	if err != nil {
		return nil, err
	}
	return model3DExportView(task)
}

func (s *Service) CancelModel3DExport(userID, id string) (*Model3DExportView, error) {
	task, err := s.repo.CancelModel3DExport(userID, id)
	if err != nil {
		return nil, err
	}
	s.cancelActiveTask(task.ID)
	return model3DExportView(task)
}

func (s *Service) CancelModel3DExportByRequest(userID, requestID string) (*Model3DExportView, error) {
	if err := validateModel3DExportRequestID(requestID); err != nil {
		return nil, err
	}
	if _, err := s.repo.User(userID); err != nil {
		return nil, err
	}
	policy, err := s.RuntimePolicy()
	if err != nil {
		return nil, err
	}
	now := time.Now()
	task := model.Task{ID: newID(), UserID: userID, Type: model.TaskTypeModel3DExport, Provider: "local", Model: "blender", Prompt: "3D 模型导出", InputJSON: "{}", Status: model.TaskStatusCancelled, Stage: "导出已取消", CompletedAt: &now, CancellationSource: model.TaskCancellationUserRequest, CancellationActorID: userID, CancellationRequestedAt: &now}
	request := model.Model3DRequest{UserID: userID, RequestID: "export:" + requestID, TaskID: task.ID, RequestHash: repository.Model3DExportCancelledHash}
	s.storageMu.Lock()
	cancelled, err := s.repo.CancelModel3DExportByRequest(&request, &task, func(repo *repository.Repository) error {
		return createModel3DExportTask(repo, &task, policy)
	})
	s.storageMu.Unlock()
	if err != nil {
		return nil, err
	}
	s.cancelActiveTask(cancelled.ID)
	return model3DExportView(cancelled)
}

func createModel3DExportTask(repo *repository.Repository, task *model.Task, policy RuntimePolicySetting) error {
	if task.Status == model.TaskStatusQueued {
		return createTaskWithStorageQuotaRepository(repo, task, nil, policy)
	}
	usage, err := repo.UserStorageUsage(task.UserID)
	if err != nil {
		return err
	}
	if err := validateTaskStorageQuotaWithPolicy(usage, int64(len(task.Prompt)+len(task.InputJSON)+len(task.ResultJSON)), policy.Resource); err != nil {
		return err
	}
	return repo.CreateModel3DExportTerminalTask(task)
}
