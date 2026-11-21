package repository

import (
	"slices"
	"time"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"yingce/backend/internal/model"
)

// 调用方已锁定主体，并在同一事务中按这次图片切换的绑定更新剧情段。
func (r *Repository) SetDramaCastImageTake(cast model.DramaCast, take model.DramaTake) error {
	return r.db.Model(&model.DramaCast{}).Where("id = ? AND project_id = ?", cast.ID, cast.ProjectID).
		Updates(map[string]any{
			"image_resource_id": take.ResourceID, "image_take_id": take.ID, "image_status": model.DramaMediaReady,
			"image_version": gorm.Expr("image_version + 1"), "revision": gorm.Expr("revision + 1"), "updated_at": time.Now(),
		}).Error
}

func (r *Repository) DramaProjectImageBindings(projectID string) ([]model.DramaShot, []model.DramaSegment, error) {
	var shots []model.DramaShot
	if err := r.db.Select("episode_id", "segment_index", "cast_ids_json", "look_cast_ids_json", "prop_ids_json", "scene_cast_id").
		Where("project_id = ?", projectID).Order("episode_id, position, id").Find(&shots).Error; err != nil {
		return nil, nil, err
	}
	var rows []model.DramaSegment
	err := r.db.Select("episode_id", "segment_index", "reference_cast_ids_json").
		Where("project_id = ?", projectID).Order("episode_id, segment_index").Find(&rows).Error
	return shots, rows, err
}

// 每段至多处理一次，包括依赖较早剧情段尾帧的后续段。
func (r *Repository) InvalidateDramaEpisodeImageVideos(episodeID string, indexes []int, restyle bool) (int, error) {
	if len(indexes) == 0 {
		return 0, nil
	}
	cascade, err := dramaSegmentVideoCascades(r.db, episodeID)
	if err != nil {
		return 0, err
	}
	query := r.db.Clauses(clause.Locking{Strength: "UPDATE"}).Select("id", "segment_index", "video_status").Where("episode_id = ?", episodeID)
	if cascade {
		query = query.Where("segment_index >= ?", slices.Min(indexes))
	} else {
		query = query.Where("segment_index IN ?", indexes)
	}
	var segments []model.DramaSegment
	if err := query.Order("segment_index").Find(&segments).Error; err != nil {
		return 0, err
	}
	if len(segments) == 0 {
		return 0, nil
	}
	ids := make([]string, 0, len(segments))
	direct := make(map[int]bool, len(indexes))
	for _, index := range indexes {
		direct[index] = true
	}
	marked := 0
	tailChanged := false
	for _, segment := range segments {
		if !direct[segment.SegmentIndex] && !tailChanged {
			continue
		}
		ids = append(ids, segment.ID)
		if segment.VideoStatus == model.DramaMediaRunning || restyle && segment.VideoStatus == model.DramaMediaReady {
			marked++
			tailChanged = cascade
		}
		// 保留已就绪的视频也保留它的尾帧，之后的生成继续使用这个尾帧。
		if !restyle && segment.VideoStatus == model.DramaMediaReady {
			tailChanged = false
		}
	}
	return marked, invalidateDramaAssetVideoRows(r.db, episodeID, ids, restyle, marked > 0)
}

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
	return r.db.Transaction(func(tx *gorm.DB) error {
		var cast model.DramaCast
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("project_id = ? AND id = ? AND kind = ? AND parent_id = ?", projectID, castID, "character", "").First(&cast).Error; err != nil {
			return err
		}
		if cast.VoiceProfileID == profileID && cast.VoiceSampleResourceID == sampleID {
			return nil
		}
		if err := tx.Model(&model.DramaCast{}).Where("id = ?", cast.ID).
			Updates(map[string]any{"voice_profile_id": profileID, "voice_sample_resource_id": sampleID, "updated_at": time.Now()}).Error; err != nil {
			return err
		}
		return invalidateDramaCastAssetVideos(tx, cast, true)
	})
}
