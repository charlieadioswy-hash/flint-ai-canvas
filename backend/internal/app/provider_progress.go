package app

import (
	"context"
	"log"

	"yingce/backend/internal/protocol"
)

// Progress is written after protocol validation, never by inspecting log payloads.
// A failed observation must not turn an accepted provider request into a failure.
func syncProviderTaskProgress(ctx context.Context, status protocol.Status, progress *int) {
	metadata, ok := ctx.Value(providerAnalyticsKey{}).(providerAnalyticsContext)
	if !ok || metadata.Service == nil || metadata.TaskID == "" || (metadata.Capability != "image" && metadata.Capability != "video") {
		return
	}
	stage := ""
	switch status {
	case protocol.StatusPending:
		stage = "上游排队中"
	case protocol.StatusProcessing:
		stage = "上游生成中"
	case protocol.StatusSucceeded:
		stage, progress = "作品已生成，正在保存", nil
	case protocol.StatusFailed, protocol.StatusCancelled:
		stage, progress = "上游生成结束", nil
	default:
		return
	}
	// A supplier's 100% is not a delivered local resource.
	if progress != nil && (*progress < 0 || *progress >= 100) {
		progress = nil
	}
	if err := metadata.Service.repo.UpdateTaskProviderProgress(metadata.TaskID, metadata.LeaseOwner, stage, progress); err != nil {
		log.Printf("provider progress sync failed: task_id=%s error=%v", metadata.TaskID, err)
	}
}
