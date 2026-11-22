package repository

import "yingce/backend/internal/model"

// 范围标记由服务端生成，不依赖各数据库的 JSON 扩展；普通全量 Bible 不进入独立查漏队列。
const dramaAssetExtractionPayloadLike = `%"scope":"asset_extraction"%`

func (r *Repository) DramaAssetExtractionJobs(projectID string, statuses ...string) ([]model.DramaJob, error) {
	var jobs []model.DramaJob
	err := r.db.Where("project_id = ? AND kind = ? AND payload_json LIKE ? AND status IN ?", projectID,
		model.DramaJobBible, dramaAssetExtractionPayloadLike, statuses).Order("created_at asc").Find(&jobs).Error
	return jobs, err
}

func (r *Repository) ClearDramaAssetExtractionWait(projectID, reason string) error {
	return r.db.Model(&model.DramaJob{}).
		Where("project_id = ? AND kind = ? AND payload_json LIKE ? AND status = ? AND error = ?",
			projectID, model.DramaJobBible, dramaAssetExtractionPayloadLike, model.DramaJobQueued, reason).
		Update("error", "").Error
}
