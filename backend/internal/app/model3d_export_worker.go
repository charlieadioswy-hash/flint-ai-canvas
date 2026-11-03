package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"yingce/backend/internal/model"
	"yingce/backend/internal/model3d"
	"yingce/backend/internal/repository"
)

func (w *taskWorkerCoordinator) processModel3DExport(task *model.Task, parent context.Context) error {
	s := w.service
	fail := func(message string) error {
		if errors.Is(parent.Err(), context.DeadlineExceeded) {
			message = "模型导出超过 10 分钟，请简化模型后重试"
		}
		done, err := s.repo.UpdateTaskTerminalState(task.ID, task.LeaseOwner, model.TaskStatusRunning, model.TaskStatusFailed, "导出失败", message, time.Now())
		if err != nil {
			return err
		}
		if !done {
			return repository.ErrTaskStateConflict
		}
		return nil
	}
	var input model3DExportInput
	if err := json.Unmarshal([]byte(task.InputJSON), &input); err != nil {
		return fail("导出请求数据无效，请重新发起导出")
	}
	options, err := model3d.NormalizeExportOptions(input.Options)
	if err != nil {
		return fail(err.Error())
	}
	outputKey := normalizedResourceUploadKey([]string{"model3d-export:" + task.ID})
	if stored, err := s.resourceForUploadKey(task.UserID, outputKey); err != nil {
		return fail("无法读取已保存的模型导出结果")
	} else if stored != nil && stored.Status == model.ResourceStatusReady {
		defer s.cleanupModel3DExportOutput(task, stored)
		result := model3DExportResourceResult(stored, input.FileName, options.Format)
		payload, _ := json.Marshal(result)
		return s.saveTaskCompletionWithinStorageQuota(task, payload, nil, false)
	}
	// Deferring releases the general worker immediately instead of occupying a
	// worker while waiting for another memory-intensive Blender conversion.
	lease, acquired, err := s.coordinator.AcquireLease(parent, "model3d-export", 1, time.Minute)
	if err != nil {
		return fail("暂时无法取得导出执行权限，请重试")
	}
	if !acquired {
		return s.repo.DeferRunningTaskForProviderPoll(task.ID, task.LeaseOwner, "等待模型导出", 2*time.Second)
	}
	defer lease.Release()
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	done := make(chan struct{})
	defer close(done)
	go func() {
		ticker := time.NewTicker(15 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := lease.Renew(ctx); err != nil {
					cancel()
					return
				}
			}
		}
	}()
	if err := w.progress(task, "读取模型源文件", 10); err != nil {
		return err
	}
	resource, reader, err := s.OpenResource(task.UserID, input.ResourceID)
	if err != nil {
		return fail("无法读取模型源文件，可能已被删除")
	}
	defer reader.Close()
	if resource.Size <= 0 || resource.Size > model3d.MaxOutputBytes || model.ImageModerationResourceVersion(resource) != input.ResourceVersion {
		return fail("模型源文件已变化或超过 128MB，请重新导出")
	}
	dir, err := os.MkdirTemp("", "yingce-model3d-export-*")
	if err != nil {
		return fail("无法创建模型导出临时目录")
	}
	defer os.RemoveAll(dir)
	switch input.SourceFormat {
	case "glb", "gltf", "fbx", "obj", "stl":
	default:
		return fail("不支持此模型源格式")
	}
	sourcePath := filepath.Join(dir, "source."+input.SourceFormat)
	file, err := os.OpenFile(sourcePath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
	if err != nil {
		return fail("无法准备模型源文件")
	}
	size, copyErr := io.Copy(file, io.LimitReader(reader, model3d.MaxOutputBytes+1))
	closeErr := file.Close()
	if copyErr != nil || closeErr != nil || size != resource.Size || size > model3d.MaxOutputBytes {
		return fail("模型源文件不完整或超过 128MB")
	}
	if err := ctx.Err(); err != nil {
		return fail("模型导出已停止，请重试")
	}
	if err := w.progress(task, "正在导出 "+strings.ToUpper(options.Format), 30); err != nil {
		return err
	}
	converter := s.model3DConverter
	if converter == nil {
		converter = model3d.NewBlenderConverter("")
	}
	output, err := converter.Convert(ctx, model3d.ConversionRequest{SourcePath: sourcePath, SourceFormat: input.SourceFormat, OutputDir: dir, Options: options})
	if err != nil {
		return fail(err.Error())
	}
	if err := ctx.Err(); err != nil {
		return fail("模型导出已停止，请重试")
	}
	// The converter contract never authorizes reading an arbitrary output path.
	outputPath, err := filepath.Abs(output.Path)
	if err != nil || filepath.Dir(outputPath) != dir || output.Format != options.Format {
		return fail("模型导出结果无效")
	}
	stat, err := os.Lstat(outputPath)
	if err != nil || !stat.Mode().IsRegular() || stat.Size() <= 0 || stat.Size() > model3d.MaxOutputBytes {
		return fail("模型导出文件为空、无效或超过 128MB")
	}
	if err := w.progress(task, "保存导出文件", 90); err != nil {
		return err
	}
	converted, err := os.Open(outputPath)
	if err != nil {
		return fail("无法读取模型导出结果")
	}
	defer converted.Close()
	quotaDay, err := s.reserveGeneratedResourceQuota(task.UserID, stat.Size())
	if err != nil {
		return fail(err.Error())
	}
	mimeType := "application/octet-stream"
	if options.Format == "abc" {
		mimeType = "application/x-alembic"
	}
	// The task checkpoint has a stable key, but an upload belongs to one lease.
	// An expired worker may still finish its object write after task takeover.
	attemptKey := normalizedResourceUploadKey([]string{"model3d-export:" + task.ID + ":" + task.LeaseOwner + ":" + newID()})
	stored, created, err := s.storeResource(task.UserID, "model", input.FileName, mimeType, stat.Size(), 0, 0, 0, converted, attemptKey, false)
	if err != nil || !created {
		s.releaseUserUploadQuota(task.UserID, quotaDay, stat.Size())
	} else {
		s.commitUserUploadQuota(task.UserID, stat.Size())
	}
	if err != nil {
		return fail("模型导出文件保存失败，请重试")
	}
	defer s.cleanupModel3DExportOutput(task, stored)
	published, err := s.repo.PublishModel3DExportOutput(task, stored, *outputKey)
	if err != nil {
		if errors.Is(err, repository.ErrTaskStateConflict) {
			return err
		}
		return fail("模型导出结果登记失败，请重试")
	}
	if published.ID != stored.ID {
		defer s.cleanupModel3DExportOutput(task, published)
	} else {
		// cleanup must know whether this attempt became the reusable checkpoint.
		*stored = *published
	}
	result := model3DExportResourceResult(published, input.FileName, options.Format)
	payload, _ := json.Marshal(result)
	if err := ctx.Err(); err != nil {
		return fail("模型导出已停止，请重试")
	}
	if err := s.saveTaskCompletionWithinStorageQuota(task, payload, nil, false); err != nil {
		if errors.Is(err, repository.ErrTaskStateConflict) {
			return err
		}
		return fail("模型导出结果登记失败，请重试")
	}
	_ = s.log(task.UserID, task.ID, "info", fmt.Sprintf("模型已导出为 %s", strings.ToUpper(options.Format)), "")
	return nil
}

func (s *Service) cleanupModel3DExportOutput(task *model.Task, resource *model.Resource) {
	checkpointKey := normalizedResourceUploadKey([]string{"model3d-export:" + task.ID})
	checkpoint := resource.UploadKey != nil && *resource.UploadKey == *checkpointKey
	latest, err := s.repo.TaskForUser(task.UserID, task.ID)
	if err != nil || (checkpoint && latest.Status != model.TaskStatusCancelled && latest.Status != model.TaskStatusFailed) {
		return
	}
	// Unpublished attempts can be discarded even while a replacement worker is
	// running. Keep reusable checkpoints until cancellation/failure so takeover
	// can recover them; normal reference checks protect a successful task result.
	if err := s.cleanupDetachedUserResources(task.UserID, []model.Resource{*resource}); err != nil {
		_ = s.log(task.UserID, task.ID, "warn", "未使用的模型导出副本等待后台清理", "")
	}
}
