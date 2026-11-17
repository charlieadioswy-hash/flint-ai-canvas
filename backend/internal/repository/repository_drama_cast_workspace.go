package repository

import (
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"yingce/backend/internal/model"
)

// 与资产保存共用同一事务，锁定被校验的版本，防止媒体调度在校验与写入之间修改资产。
func (r *Repository) DramaCastForUpdate(projectID, castID string) (*model.DramaCast, error) {
	var cast model.DramaCast
	err := r.db.Clauses(clause.Locking{Strength: "UPDATE"}).Where("project_id = ? AND id = ?", projectID, castID).First(&cast).Error
	if err != nil {
		return nil, err
	}
	return &cast, r.resolveDramaCastParentName(&cast)
}

// 造型保存的姓名只是创建快照；读取身份始终使用所属角色的当前姓名，不改写图片配置或历史文本。
func inheritDramaCastParentNames(casts []model.DramaCast) {
	parents := make(map[string]string, len(casts))
	for _, cast := range casts {
		if cast.Kind == "character" && cast.ParentID == "" {
			parents[cast.ID] = cast.Name
		}
	}
	for i := range casts {
		if name, ok := parents[casts[i].ParentID]; ok && casts[i].Kind == "character" {
			casts[i].Name = name
		}
	}
}

func (r *Repository) resolveDramaCastParentName(cast *model.DramaCast) error {
	if cast.Kind != "character" || cast.ParentID == "" {
		return nil
	}
	var parent model.DramaCast
	result := r.db.Select("name").Where("project_id = ? AND id = ? AND kind = ? AND parent_id = ?", cast.ProjectID, cast.ParentID, "character", "").Find(&parent)
	if result.Error == nil && result.RowsAffected > 0 {
		cast.Name = parent.Name
	}
	return result.Error
}

// 声音不参与参考图版本；独立写入避免取消图片任务或拒绝它的已付费结果。
func (r *Repository) UpdateDramaCastVoice(projectID, castID, profileID, sampleID string) error {
	result := r.db.Model(&model.DramaCast{}).Where("project_id = ? AND id = ? AND kind = ? AND parent_id = ?", projectID, castID, "character", "").
		Updates(map[string]any{"voice_profile_id": profileID, "voice_sample_resource_id": sampleID, "updated_at": time.Now()})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return gorm.ErrRecordNotFound
	}
	return nil
}
