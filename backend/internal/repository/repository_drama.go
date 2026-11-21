package repository

import (
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"yingce/backend/internal/kernel"
	"yingce/backend/internal/model"

	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// ErrDramaPlanPending 表示还有章节在等待分集规划，此时不能逐集追加。
var ErrDramaPlanPending = errors.New("drama plan pending")

func (r *Repository) DramaProduction(projectID string) (*model.DramaProduction, error) {
	var production model.DramaProduction
	if err := r.db.First(&production, "project_id = ?", projectID).Error; err != nil {
		return nil, err
	}
	return &production, nil
}

// RunningDramaProductions 返回需要调度循环推进的项目：运行中的项目，以及暂停或已完成但仍有已派发任务的项目。
// 后者回收已付费结果；另允许派发用户显式提交、与全局制作状态独立的资产查漏文字任务。
func (r *Repository) RunningDramaProductions(limit int) ([]model.DramaProduction, error) {
	var productions []model.DramaProduction
	pending := r.db.Model(&model.DramaJob{}).Select("project_id").Where("status = ? OR (status = ? AND kind = ? AND payload_json LIKE ?)", model.DramaJobRunning,
		model.DramaJobQueued, model.DramaJobBible, dramaAssetExtractionPayloadLike)
	err := r.db.Where("status = ? OR project_id IN (?)", model.DramaStatusRunning, pending).Order("updated_at asc").Limit(limit).Find(&productions).Error
	return productions, err
}

// CreateDramaProject 在同一事务内写入项目、章节与制作控制面，避免出现无章节的半成品项目。
// episodes 非空表示每章直接成为一集（逐集制作），不经过分集规划。
func (r *Repository) CreateDramaProject(project *model.Project, chapters []model.ProjectUnit, production *model.DramaProduction, episodes ...model.DramaEpisode) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		result := tx.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "user_id"}, {Name: "name"}}, DoNothing: true}).Create(project)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected == 0 {
			return ErrProjectNameConflict
		}
		if len(chapters) > 0 {
			if err := tx.CreateInBatches(&chapters, 200).Error; err != nil {
				return err
			}
		}
		if len(episodes) > 0 {
			if err := tx.CreateInBatches(&episodes, 200).Error; err != nil {
				return err
			}
		}
		return tx.Create(production).Error
	})
}

// ErrDramaDraftStarted 表示要重存的草稿已经开工（状态不是草稿或已有作业）。
var ErrDramaDraftStarted = errors.New("drama draft started")

// ReplaceDramaDraft 在同一事务内整体替换草稿：项目名称与画幅、原著章节、按章分集的集和制作控制面。
// 只在作品仍是草稿且没有任何作业时替换；名称与同用户其他项目重复时返回 ErrProjectNameConflict。
func (r *Repository) ReplaceDramaDraft(project *model.Project, chapters []model.ProjectUnit, production *model.DramaProduction, episodes []model.DramaEpisode) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		var current model.DramaProduction
		if err := tx.First(&current, "project_id = ? AND user_id = ?", project.ID, project.UserID).Error; err != nil {
			return err
		}
		var jobs int64
		if err := tx.Model(&model.DramaJob{}).Where("project_id = ?", project.ID).Count(&jobs).Error; err != nil {
			return err
		}
		if current.Status != model.DramaStatusDraft || jobs > 0 {
			return ErrDramaDraftStarted
		}
		var taken int64
		if err := tx.Model(&model.Project{}).Where("user_id = ? AND name = ? AND id <> ?", project.UserID, project.Name, project.ID).Count(&taken).Error; err != nil {
			return err
		}
		if taken > 0 {
			return ErrProjectNameConflict
		}
		if err := tx.Model(&model.Project{}).Where("id = ? AND user_id = ?", project.ID, project.UserID).Updates(map[string]any{
			"name": project.Name, "aspect_ratio": project.AspectRatio, "source_type": project.SourceType,
			"revision": gorm.Expr("revision + 1"), "updated_at": project.UpdatedAt,
		}).Error; err != nil {
			return err
		}
		if err := tx.Where("project_id = ? AND kind IN ?", project.ID, []model.ProjectUnitKind{model.ProjectUnitKindChapter, model.ProjectUnitKindSourceReference}).Delete(&model.ProjectUnit{}).Error; err != nil {
			return err
		}
		if err := tx.Where("project_id = ?", project.ID).Delete(&model.DramaEpisode{}).Error; err != nil {
			return err
		}
		if len(chapters) > 0 {
			if err := tx.CreateInBatches(&chapters, 200).Error; err != nil {
				return err
			}
		}
		if len(episodes) > 0 {
			if err := tx.CreateInBatches(&episodes, 200).Error; err != nil {
				return err
			}
		}
		production.Revision = current.Revision + 1
		return tx.Select("*").Where("project_id = ?", project.ID).Updates(production).Error
	})
}

// DramaEpisodePlacement 指定新的一集插在哪一集之前或之后。
type DramaEpisodePlacement struct {
	AnchorEpisodeID string
	Before          bool
}

// AddDramaEpisodeSource 写入一章原文和对应的一集，并把分集游标推过这一章，调度循环不会再把它交给分集规划。
// placement 为 nil 时追加到末尾；否则插到锚点集之前或之后：后续集号顺延，原文插到锚点集章节的前后，
// 之后的章节位置与造型的默认适用章节号一起后移。标题为空时按最终集号取默认标题。
// 只允许在分集规划完成后写入，否则游标会把新章节并入规划批次。
func (r *Repository) AddDramaEpisodeSource(projectID string, chapter *model.ProjectUnit, episode *model.DramaEpisode, placement *DramaEpisodePlacement) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		var production model.DramaProduction
		if err := tx.First(&production, "project_id = ?", projectID).Error; err != nil {
			return err
		}
		if !production.PlanDone {
			return ErrDramaPlanPending
		}
		// 规划游标只数已加入制作的章节；追加时位置仍排在全部章节（含预留章节）之后。
		var count int64
		if err := tx.Model(&model.ProjectUnit{}).Where("project_id = ? AND kind = ? AND status NOT IN ?", projectID, model.ProjectUnitKindChapter, []model.ProjectUnitStatus{model.ProjectUnitStatusReserved, model.ProjectUnitStatusRemoved}).Count(&count).Error; err != nil {
			return err
		}
		var position int
		if err := tx.Model(&model.ProjectUnit{}).Where("project_id = ? AND kind = ?", projectID, model.ProjectUnitKindChapter).Select("COALESCE(MAX(position), -1)").Scan(&position).Error; err != nil {
			return err
		}
		var number int
		if err := tx.Model(&model.DramaEpisode{}).Where("project_id = ?", projectID).Select("COALESCE(MAX(number), 0)").Scan(&number).Error; err != nil {
			return err
		}
		chapter.Position = position + 1
		episode.Number = number + 1
		if placement != nil {
			var anchor model.DramaEpisode
			if err := tx.Select("id", "number", "chapter_ids_json").First(&anchor, "id = ? AND project_id = ?", placement.AnchorEpisodeID, projectID).Error; err != nil {
				return err
			}
			episode.Number = anchor.Number + 1
			if placement.Before {
				episode.Number = anchor.Number
			}
			var positions []int
			if ids := decodeDramaIDs(anchor.ChapterIDsJSON); len(ids) > 0 {
				if err := tx.Model(&model.ProjectUnit{}).Where("project_id = ? AND kind = ? AND id IN ?", projectID, model.ProjectUnitKindChapter, ids).Pluck("position", &positions).Error; err != nil {
					return err
				}
			}
			// 锚点集没有关联章节时原文仍排到末尾，只调整集号。
			if len(positions) > 0 {
				chapter.Position = slices.Max(positions) + 1
				if placement.Before {
					chapter.Position = slices.Min(positions)
				}
				if err := shiftDramaChaptersForInsert(tx, projectID, chapter.Position); err != nil {
					return err
				}
			}
			if err := shiftDramaEpisodeNumbers(tx, projectID, episode.Number, 1); err != nil {
				return err
			}
		}
		if chapter.Title == "" {
			chapter.Title = model.DramaEpisodeDefaultTitle(episode.Number)
		}
		if episode.Title == "" {
			episode.Title = model.DramaEpisodeDefaultTitle(episode.Number)
		}
		if err := tx.Create(chapter).Error; err != nil {
			return err
		}
		if err := tx.Create(episode).Error; err != nil {
			return err
		}
		return tx.Model(&model.DramaProduction{}).Where("project_id = ?", projectID).
			Updates(map[string]any{"plan_cursor": count + 1, "plan_done": true, "updated_at": time.Now()}).Error
	})
}

var (
	// ErrDramaLastEpisode 表示作品只剩这一集，不能再删。
	ErrDramaLastEpisode = errors.New("drama last episode")
	// ErrDramaEpisodeBusy 表示这一集还有已提交的生成任务在进行，结果回写前不能删除。
	ErrDramaEpisodeBusy = errors.New("drama episode busy")
	// ErrDramaEpisodeConfirmRequired 表示这一集生成过视频，删除需要用户输入确认。
	ErrDramaEpisodeConfirmRequired = errors.New("drama episode confirm required")
)

// DeleteDramaEpisode 删除一集及其镜头、剧情段、段视频与成片的版本记录和调度作业，后续集号前移一位。
// releaseChapterIDs 是只被这一集使用的章节，退回预留状态（原文保留，可在原著章节里重新加入制作），规划游标随之重算。
// 这一集生成过视频且 confirmed=false 时返回 ErrDramaEpisodeConfirmRequired，不做任何修改。
func (r *Repository) DeleteDramaEpisode(projectID, episodeID string, releaseChapterIDs []string, confirmed bool) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		var production model.DramaProduction
		if err := tx.First(&production, "project_id = ?", projectID).Error; err != nil {
			return err
		}
		if !production.PlanDone {
			return ErrDramaPlanPending
		}
		var episode model.DramaEpisode
		if err := tx.Select("id", "number", "final_resource_id").First(&episode, "id = ? AND project_id = ?", episodeID, projectID).Error; err != nil {
			return err
		}
		var total int64
		if err := tx.Model(&model.DramaEpisode{}).Where("project_id = ?", projectID).Count(&total).Error; err != nil {
			return err
		}
		if total <= 1 {
			return ErrDramaLastEpisode
		}
		// 已提交的任务已经计费，结果要回写到本集的剧情段；等它们结束再删，避免付费结果无处落地。
		var running int64
		if err := tx.Model(&model.DramaJob{}).Where("project_id = ? AND episode_id = ? AND status = ?", projectID, episode.ID, model.DramaJobRunning).Count(&running).Error; err != nil {
			return err
		}
		if running > 0 {
			return ErrDramaEpisodeBusy
		}
		var pendingImages int64
		if err := tx.Model(&model.DramaCast{}).Where("project_id = ? AND image_episode_id = ? AND image_status IN ?", projectID, episode.ID, []string{model.DramaMediaQueued, model.DramaMediaRunning}).Count(&pendingImages).Error; err != nil {
			return err
		}
		if pendingImages > 0 {
			return ErrDramaEpisodeBusy
		}
		if !confirmed {
			generated, err := dramaEpisodeHasVideo(tx, projectID, episode)
			if err != nil {
				return err
			}
			if generated {
				return ErrDramaEpisodeConfirmRequired
			}
		}
		segments := tx.Model(&model.DramaSegment{}).Select("id").Where("episode_id = ?", episode.ID)
		if err := tx.Where("project_id = ? AND ((kind = ? AND owner_id IN (?)) OR (kind = ? AND owner_id = ?))", projectID, "video", segments, "final", episode.ID).Delete(&model.DramaTake{}).Error; err != nil {
			return err
		}
		if err := tx.Where("project_id = ? AND episode_id = ?", projectID, episode.ID).Delete(&model.DramaJob{}).Error; err != nil {
			return err
		}
		if err := tx.Model(&model.DramaCast{}).Where("project_id = ? AND image_episode_id = ?", projectID, episode.ID).UpdateColumn("image_episode_id", "").Error; err != nil {
			return err
		}
		for _, entity := range []any{&model.DramaSegment{}, &model.DramaShot{}, &model.DramaSceneRevision{}} {
			if err := tx.Where("project_id = ? AND episode_id = ?", projectID, episode.ID).Delete(entity).Error; err != nil {
				return err
			}
		}
		if err := tx.Where("id = ? AND project_id = ?", episode.ID, projectID).Delete(&model.DramaEpisode{}).Error; err != nil {
			return err
		}
		if err := shiftDramaEpisodeNumbers(tx, projectID, episode.Number+1, -1); err != nil {
			return err
		}
		now := time.Now()
		if len(releaseChapterIDs) > 0 {
			status := model.ProjectUnitStatusReserved
			var settings struct {
				EpisodeMode string `json:"episodeMode"`
			}
			_ = json.Unmarshal([]byte(production.SettingsJSON), &settings)
			if production.GuideStep != "" || settings.EpisodeMode == "chapter" {
				status = model.ProjectUnitStatusRemoved
			}
			if err := tx.Model(&model.ProjectUnit{}).Where("project_id = ? AND kind = ? AND id IN ?", projectID, model.ProjectUnitKindChapter, releaseChapterIDs).
				Updates(map[string]any{"status": status, "updated_at": now}).Error; err != nil {
				return err
			}
		}
		var count int64
		if err := tx.Model(&model.ProjectUnit{}).Where("project_id = ? AND kind = ? AND status NOT IN ?", projectID, model.ProjectUnitKindChapter, []model.ProjectUnitStatus{model.ProjectUnitStatusReserved, model.ProjectUnitStatusRemoved}).Count(&count).Error; err != nil {
			return err
		}
		return tx.Model(&model.DramaProduction{}).Where("project_id = ?", projectID).Updates(map[string]any{"plan_cursor": count, "updated_at": now}).Error
	})
}

// dramaEpisodeHasVideo 判断一集是否生成过视频：成片、当前段视频、段视频与成片的历史版本，
// 以及成功的段视频或合成作业（重新改编会删掉旧剧情段，旧段视频只能从作业记录对上本集）。
func dramaEpisodeHasVideo(tx *gorm.DB, projectID string, episode model.DramaEpisode) (bool, error) {
	if episode.FinalResourceID != "" {
		return true, nil
	}
	segments := tx.Model(&model.DramaSegment{}).Select("id").Where("episode_id = ?", episode.ID)
	checks := []*gorm.DB{
		tx.Model(&model.DramaSegment{}).Where("project_id = ? AND episode_id = ? AND video_resource_id <> ''", projectID, episode.ID),
		tx.Model(&model.DramaTake{}).Where("project_id = ? AND ((kind = ? AND owner_id IN (?)) OR (kind = ? AND owner_id = ?))", projectID, "video", segments, "final", episode.ID),
		tx.Model(&model.DramaJob{}).Where("project_id = ? AND episode_id = ? AND kind IN ? AND status = ?", projectID, episode.ID, []string{model.DramaJobSegmentVideo, model.DramaJobRender}, model.DramaJobSucceeded),
	}
	for _, check := range checks {
		var count int64
		if err := check.Count(&count).Error; err != nil {
			return false, err
		}
		if count > 0 {
			return true, nil
		}
	}
	return false, nil
}

// shiftDramaChaptersForInsert 为插到 position 的新章节腾位置：之后的章节（含预留章节）后移一位，
// 造型的默认适用章节号（从 1 起，0 表示不限）同步后移，仍对应原来那些章节。
func shiftDramaChaptersForInsert(tx *gorm.DB, projectID string, position int) error {
	if err := tx.Model(&model.ProjectUnit{}).Where("project_id = ? AND kind = ? AND position >= ?", projectID, model.ProjectUnitKindChapter, position).
		Update("position", gorm.Expr("position + 1")).Error; err != nil {
		return err
	}
	for _, column := range []string{"look_from_chapter", "look_to_chapter"} {
		if err := tx.Model(&model.DramaCast{}).Where("project_id = ? AND "+column+" >= ?", projectID, position+1).
			Update(column, gorm.Expr(column+" + 1")).Error; err != nil {
			return err
		}
	}
	return nil
}

// shiftDramaEpisodeNumbers 把 from 号及之后各集的集号加 delta（插入 +1，删除 -1）。(project_id, number) 唯一，
// 逐行加减会和相邻集号冲突，所以先翻成负数再写回。仍是默认标题的集随新集号改名，以“第 N 集”开头的作业标签同步改号。
func shiftDramaEpisodeNumbers(tx *gorm.DB, projectID string, from, delta int) error {
	var episodes []model.DramaEpisode
	if err := tx.Select("id", "number", "title").Where("project_id = ? AND number >= ?", projectID, from).Find(&episodes).Error; err != nil {
		return err
	}
	if len(episodes) == 0 {
		return nil
	}
	if err := tx.Model(&model.DramaEpisode{}).Where("project_id = ? AND number >= ?", projectID, from).
		Update("number", gorm.Expr(fmt.Sprintf("-(number + %d)", delta))).Error; err != nil {
		return err
	}
	if err := tx.Model(&model.DramaEpisode{}).Where("project_id = ? AND number < 0", projectID).Update("number", gorm.Expr("-number")).Error; err != nil {
		return err
	}
	for _, episode := range episodes {
		before, after := model.DramaEpisodeDefaultTitle(episode.Number), model.DramaEpisodeDefaultTitle(episode.Number+delta)
		if episode.Title == before {
			if err := tx.Model(&model.DramaEpisode{}).Where("id = ?", episode.ID).Update("title", after).Error; err != nil {
				return err
			}
		}
		// “第 3 集%”不会匹配“第 30 集”：集号后面紧跟空格。
		// 只改标签不动 updated_at，队列历史仍按原来的时间排序。
		if err := tx.Model(&model.DramaJob{}).Where("project_id = ? AND episode_id = ? AND label LIKE ?", projectID, episode.ID, before+"%").
			UpdateColumn("label", gorm.Expr(fmt.Sprintf("CAST(? AS TEXT) || SUBSTR(label, %d)", utf8.RuneCountInString(before)+1), after)).Error; err != nil {
			return err
		}
	}
	return nil
}

func decodeDramaIDs(raw string) []string {
	var ids []string
	_ = json.Unmarshal([]byte(raw), &ids)
	return ids
}

// UpdateDramaChapterSource 修改一章原文与字数。
func (r *Repository) UpdateDramaChapterSource(projectID, chapterID string, fields map[string]any) error {
	fields["updated_at"] = time.Now()
	return r.db.Model(&model.ProjectUnit{}).Where("id = ? AND project_id = ? AND kind = ?", chapterID, projectID, model.ProjectUnitKindChapter).Updates(fields).Error
}

// InsertDramaShot 在同一剧情段内插入镜头：后续镜头顺延，本段提示词与视频过期。
func (r *Repository) InsertDramaShot(shot model.DramaShot) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Model(&model.DramaShot{}).Where("episode_id = ? AND position >= ?", shot.EpisodeID, shot.Position).
			Update("position", gorm.Expr("position + 1")).Error; err != nil {
			return err
		}
		if err := tx.Create(&shot).Error; err != nil {
			return err
		}
		return refreshDramaSegmentAfterShotChange(tx, shot)
	})
}

// DeleteDramaShot 删除镜头并前移后续镜头；调用方保证本段还剩其他镜头。
func (r *Repository) DeleteDramaShot(shot model.DramaShot) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("id = ? AND project_id = ?", shot.ID, shot.ProjectID).Delete(&model.DramaShot{}).Error; err != nil {
			return err
		}
		if err := tx.Model(&model.DramaShot{}).Where("episode_id = ? AND position > ?", shot.EpisodeID, shot.Position).
			Update("position", gorm.Expr("position - 1")).Error; err != nil {
			return err
		}
		return refreshDramaSegmentAfterShotChange(tx, shot)
	})
}

func refreshDramaSegmentAfterShotChange(tx *gorm.DB, shot model.DramaShot) error {
	var segment model.DramaSegment
	if err := tx.Where("episode_id = ? AND segment_index = ?", shot.EpisodeID, shot.SegmentIndex).First(&segment).Error; err != nil {
		return err
	}
	if err := invalidateDramaSegment(tx, segment, map[string]any{"prompt_status": promptStatusAfterInputChange(segment.PromptStatus), "video_prompt_override": ""}, true); err != nil {
		return err
	}
	if err := tx.Model(&model.DramaEpisode{}).Where("id = ?", shot.EpisodeID).Update("duration_ms", tx.Model(&model.DramaShot{}).Select("COALESCE(SUM(duration_ms),0)").Where("episode_id = ?", shot.EpisodeID)).Error; err != nil {
		return err
	}
	return tx.Model(&model.DramaEpisode{}).Where("id = ?", shot.EpisodeID).Update("shot_count", tx.Model(&model.DramaShot{}).Select("COUNT(*)").Where("episode_id = ?", shot.EpisodeID)).Error
}

// DramaChapters 返回已加入制作的章节（不含预留章节），供资产提取与分集规划读取原文。
func (r *Repository) DramaChapters(projectID string) ([]model.ProjectUnit, error) {
	var units []model.ProjectUnit
	err := r.db.Where("project_id = ? AND kind = ? AND status NOT IN ?", projectID, model.ProjectUnitKindChapter, []model.ProjectUnitStatus{model.ProjectUnitStatusReserved, model.ProjectUnitStatusRemoved}).Order("position asc").Find(&units).Error
	return units, err
}

// DramaChapterSummaries 与 DramaChapters 同一范围但不读原文；分集规划游标按这个列表计数。
func (r *Repository) DramaChapterSummaries(projectID string) ([]model.ProjectUnit, error) {
	var units []model.ProjectUnit
	err := dramaChapterSummaryQuery(r.db, projectID).Where("status NOT IN ?", []model.ProjectUnitStatus{model.ProjectUnitStatusReserved, model.ProjectUnitStatusRemoved}).Find(&units).Error
	return units, err
}

// DramaChapterOutline 返回全部原著章节（含预留章节）的目录，不读原文。
func (r *Repository) DramaChapterOutline(projectID string) ([]model.ProjectUnit, error) {
	var units []model.ProjectUnit
	err := dramaChapterSummaryQuery(r.db, projectID).Find(&units).Error
	return units, err
}

func dramaChapterSummaryQuery(db *gorm.DB, projectID string) *gorm.DB {
	return db.Select("id", "project_id", "kind", "title", "word_count", "position", "status", "created_at", "updated_at").
		Where("project_id = ? AND kind = ?", projectID, model.ProjectUnitKindChapter).Order("position asc")
}

// ErrDramaChaptersChanged 表示要加入制作的章节已不是预留状态（已被加入或不属于本作品）。
var ErrDramaChaptersChanged = errors.New("drama chapters changed")

// ProduceDramaChapters 把预留章节加入制作，并在同一事务内追加对应的集（编号接在现有分集之后）、
// 把规划游标推到已加入制作的章节数。只在分集规划完成后允许：在途的规划按游标批次读取章节，中途插入会错位。
func (r *Repository) ProduceDramaChapters(projectID string, chapterIDs []string, episodes []model.DramaEpisode) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		production, err := New(tx).DramaProductionForUpdate(projectID)
		if err != nil {
			return err
		}
		if !production.PlanDone {
			return ErrDramaPlanPending
		}
		now := time.Now()
		result := tx.Model(&model.ProjectUnit{}).Where("project_id = ? AND kind = ? AND status = ? AND id IN ?", projectID, model.ProjectUnitKindChapter, model.ProjectUnitStatusReserved, chapterIDs).
			Updates(map[string]any{"status": model.ProjectUnitStatusReady, "updated_at": now})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != int64(len(chapterIDs)) {
			return ErrDramaChaptersChanged
		}
		var count int64
		if err := tx.Model(&model.ProjectUnit{}).Where("project_id = ? AND kind = ? AND status NOT IN ?", projectID, model.ProjectUnitKindChapter, []model.ProjectUnitStatus{model.ProjectUnitStatusReserved, model.ProjectUnitStatusRemoved}).Count(&count).Error; err != nil {
			return err
		}
		var number int
		if err := tx.Model(&model.DramaEpisode{}).Where("project_id = ?", projectID).Select("COALESCE(MAX(number), 0)").Scan(&number).Error; err != nil {
			return err
		}
		for i := range episodes {
			episodes[i].Number = number + 1 + i
		}
		if len(episodes) > 0 {
			if err := tx.CreateInBatches(&episodes, 200).Error; err != nil {
				return err
			}
		}
		return tx.Model(&model.DramaProduction{}).Where("project_id = ?", projectID).
			Updates(map[string]any{"plan_cursor": count, "plan_done": true, "updated_at": now}).Error
	})
}

func (r *Repository) DramaChaptersByIDs(projectID string, ids []string) ([]model.ProjectUnit, error) {
	var units []model.ProjectUnit
	if len(ids) == 0 {
		return units, nil
	}
	err := r.db.Where("project_id = ? AND kind = ? AND id IN ?", projectID, model.ProjectUnitKindChapter, ids).Order("position asc").Find(&units).Error
	return units, err
}

func (r *Repository) DramaSourceReference(projectID string) (*model.ProjectUnit, error) {
	var unit model.ProjectUnit
	err := r.db.Where("project_id = ? AND kind = ?", projectID, model.ProjectUnitKindSourceReference).Take(&unit).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &unit, nil
}

func (r *Repository) DramaCasts(projectID string) ([]model.DramaCast, error) {
	var casts []model.DramaCast
	err := r.db.Where("project_id = ?", projectID).Order("kind asc, position asc").Find(&casts).Error
	if err == nil {
		inheritDramaCastParentNames(casts)
	}
	return casts, err
}

func (r *Repository) DramaCast(projectID string, id string) (*model.DramaCast, error) {
	var cast model.DramaCast
	if err := r.db.First(&cast, "id = ? AND project_id = ?", id, projectID).Error; err != nil {
		return nil, err
	}
	return &cast, r.resolveDramaCastParentName(&cast)
}

func (r *Repository) CreateDramaCasts(casts []model.DramaCast) error {
	if len(casts) == 0 {
		return nil
	}
	return r.db.Create(&casts).Error
}

func (r *Repository) DramaEpisodes(projectID string) ([]model.DramaEpisode, error) {
	var episodes []model.DramaEpisode
	err := r.db.Omit("subtitle_srt").Where("project_id = ?", projectID).Order("number asc").Find(&episodes).Error
	return episodes, err
}

func (r *Repository) DramaEpisode(projectID string, id string) (*model.DramaEpisode, error) {
	var episode model.DramaEpisode
	if err := r.db.First(&episode, "id = ? AND project_id = ?", id, projectID).Error; err != nil {
		return nil, err
	}
	return &episode, nil
}

func (r *Repository) MaxDramaEpisodeNumber(projectID string) (int, error) {
	var number int
	err := r.db.Model(&model.DramaEpisode{}).Where("project_id = ?", projectID).Select("COALESCE(MAX(number), 0)").Scan(&number).Error
	return number, err
}

func (r *Repository) LastDramaEpisode(projectID string) (*model.DramaEpisode, error) {
	var episode model.DramaEpisode
	err := r.db.Where("project_id = ?", projectID).Order("number desc").First(&episode).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &episode, nil
}

// AppendDramaEpisodes 写入规划出的分集并推进规划游标，保证重复回填不会生成重复集。
func (r *Repository) AppendDramaEpisodes(production *model.DramaProduction, episodes []model.DramaEpisode, expectedCursor int) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		result := tx.Model(&model.DramaProduction{}).Where("project_id = ? AND plan_cursor = ?", production.ProjectID, expectedCursor).
			Updates(map[string]any{"plan_cursor": production.PlanCursor, "plan_done": production.PlanDone, "updated_at": time.Now()})
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return gorm.ErrInvalidData
		}
		if len(episodes) == 0 {
			return nil
		}
		return tx.Create(&episodes).Error
	})
}

func (r *Repository) DramaShots(episodeID string) ([]model.DramaShot, error) {
	var shots []model.DramaShot
	err := r.db.Where("episode_id = ?", episodeID).Order("position asc").Find(&shots).Error
	return shots, err
}

func (r *Repository) DramaShot(projectID string, id string) (*model.DramaShot, error) {
	var shot model.DramaShot
	if err := r.db.First(&shot, "id = ? AND project_id = ?", id, projectID).Error; err != nil {
		return nil, err
	}
	return &shot, nil
}

func (r *Repository) CreateDramaTake(take *model.DramaTake) error {
	if take.TaskID != "" {
		var count int64
		if err := r.db.Model(&model.DramaTake{}).Where("task_id = ? AND owner_id = ? AND kind = ?", take.TaskID, take.OwnerID, take.Kind).Count(&count).Error; err != nil {
			return err
		}
		if count > 0 {
			return nil
		}
	}
	return r.db.Transaction(func(tx *gorm.DB) error {
		var current int
		if err := tx.Model(&model.DramaTake{}).Where("owner_id = ? AND kind = ?", take.OwnerID, take.Kind).Select("COALESCE(MAX(version), 0)").Scan(&current).Error; err != nil {
			return err
		}
		take.Version = current + 1
		return tx.Create(take).Error
	})
}

func (r *Repository) DramaJobsByStatus(projectID string, statuses ...string) ([]model.DramaJob, error) {
	var jobs []model.DramaJob
	err := r.db.Where("project_id = ? AND status IN ?", projectID, statuses).Order("priority desc, created_at asc").Find(&jobs).Error
	return jobs, err
}

func (r *Repository) DramaJob(projectID string, id string) (*model.DramaJob, error) {
	var job model.DramaJob
	if err := r.db.First(&job, "id = ? AND project_id = ?", id, projectID).Error; err != nil {
		return nil, err
	}
	return &job, nil
}

// LatestDramaJob 返回某集某类工作的最近一条记录，用于回看剧本改编的提示词与模型返回。
func (r *Repository) LatestDramaJob(projectID string, kind string, episodeID string) (*model.DramaJob, error) {
	var job model.DramaJob
	err := r.db.Where("project_id = ? AND kind = ? AND episode_id = ?", projectID, kind, episodeID).Order("created_at desc").First(&job).Error
	if err != nil {
		return nil, err
	}
	return &job, nil
}

func (r *Repository) RecentDramaJobs(projectID string, limit int) ([]model.DramaJob, error) {
	return r.RecentDramaJobsFiltered(projectID, limit, DramaQueueFilter{})
}

func (r *Repository) RecentDramaJobsFiltered(projectID string, limit int, filter DramaQueueFilter) ([]model.DramaJob, error) {
	var jobs []model.DramaJob
	err := filter.apply(r.db.Model(&model.DramaJob{}).Where("project_id = ?", projectID), "drama_jobs", "drama_jobs.kind").Order("updated_at desc, id desc").Limit(limit).Find(&jobs).Error
	return jobs, err
}

func (r *Repository) DramaJobCounts(projectID string) (map[string]int64, error) {
	var rows []struct {
		Status string
		Count  int64
	}
	if err := r.db.Model(&model.DramaJob{}).Select("status, COUNT(*) AS count").Where("project_id = ?", projectID).Group("status").Scan(&rows).Error; err != nil {
		return nil, err
	}
	counts := map[string]int64{}
	for _, row := range rows {
		counts[row.Status] = row.Count
	}
	return counts, nil
}

func (r *Repository) CreateDramaJobs(jobs []model.DramaJob) error {
	if len(jobs) == 0 {
		return nil
	}
	return r.db.Create(&jobs).Error
}

func (r *Repository) SaveDramaJob(job *model.DramaJob) error {
	job.UpdatedAt = time.Now()
	return r.db.Save(job).Error
}

// RecordDramaJobCost 按 attempts_json 乐观锁写入本次任务的去重记录与作业花费：结算后先落库再应用结果，
// 中断恢复时已记录的任务不会再记一次。作品花费按订单汇总（DramaBillingTotals），这里不改 drama_productions。
func (r *Repository) RecordDramaJobCost(job *model.DramaJob, previousAttempts string) error {
	result := r.db.Model(&model.DramaJob{}).
		Where("id = ? AND project_id = ? AND task_id = ? AND COALESCE(attempts_json, '') = ?", job.ID, job.ProjectID, job.TaskID, previousAttempts).
		Updates(map[string]any{"attempts_json": job.AttemptsJSON, "cost_microcredits": job.CostMicrocredits, "updated_at": time.Now()})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrDramaJobChanged
	}
	return nil
}

// ErrDramaJobChanged 表示作业在读取后已被取消、重试或绑定到其他任务，本次写入作废。
var ErrDramaJobChanged = errors.New("短剧作业已变化，请重新读取")

// BindDramaJobTask 只在作业仍是派发前读到的状态与任务时写入新的绑定（整行写回），
// 防止用户在派发期间取消或重试后被覆盖回运行中，或复活已删除的作业。
func (r *Repository) BindDramaJobTask(job *model.DramaJob, expectedStatus, expectedTaskID string) error {
	job.UpdatedAt = time.Now()
	result := r.db.Model(job).
		Where("project_id = ? AND status = ? AND COALESCE(task_id, '') = ?", job.ProjectID, expectedStatus, expectedTaskID).
		Select("*").Omit("id", "project_id", "created_at").Updates(job)
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return ErrDramaJobChanged
	}
	return nil
}

// CancelDramaJobs 取消尚未派发的排队工作；已提交的任务由任务中心各自收尾。
func (r *Repository) CancelQueuedDramaJobs(projectID string, filter func(*gorm.DB) *gorm.DB) error {
	query := r.db.Model(&model.DramaJob{}).Where("project_id = ? AND status = ?", projectID, model.DramaJobQueued)
	if filter != nil {
		query = filter(query)
	}
	return query.Updates(map[string]any{"status": model.DramaJobCanceled, "updated_at": time.Now()}).Error
}

func (r *Repository) CancelUnboundDramaRenderJob(projectID, jobID string) (bool, error) {
	result := r.db.Model(&model.DramaJob{}).
		Where("id = ? AND project_id = ? AND kind = ? AND status = ? AND COALESCE(task_id, '') = ''", jobID, projectID, model.DramaJobRender, model.DramaJobQueued).
		Updates(map[string]any{"status": model.DramaJobCanceled, "updated_at": time.Now()})
	return result.RowsAffected == 1, result.Error
}

func (r *Repository) DeleteDramaProductionData(projectID string) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if err := New(tx).DeleteDramaShotMediaForProject(projectID); err != nil {
			return err
		}
		if err := New(tx).DeleteDramaStoryboardForProject(projectID); err != nil {
			return err
		}
		if err := New(tx).DeleteDramaCastViews(projectID); err != nil {
			return err
		}
		for _, entity := range []any{&model.DramaJob{}, &model.DramaTake{}, &model.DramaSegment{}, &model.DramaShot{}, &model.DramaSceneRevision{}, &model.DramaEpisode{}, &model.DramaCast{}, &model.DramaProduction{}} {
			if err := tx.Where("project_id = ?", projectID).Delete(entity).Error; err != nil {
				return err
			}
		}
		return nil
	})
}

// FailedDramaCastErrors 返回各角色/场景最近一次参考图失败的原因，供收件箱展示真实错误。
func (r *Repository) FailedDramaCastErrors(projectID string) (map[string]string, error) {
	var jobs []model.DramaJob
	err := r.db.Select("cast_id", "error").
		Where("project_id = ? AND kind = ? AND status = ? AND cast_id <> ''", projectID, model.DramaJobCastImage, model.DramaJobFailed).
		Order("updated_at asc").Find(&jobs).Error
	errors := make(map[string]string, len(jobs))
	for _, job := range jobs {
		errors[job.CastID] = job.Error
	}
	return errors, err
}

// AttentionDramaShots 返回需要人工处理的失败镜头，供“待处理”收件箱使用。

func (r *Repository) DramaProjectsPage(userID string, search string, status string, page int, pageSize int) ([]model.Project, int64, error) {
	query := r.db.Model(&model.Project{}).
		Joins("JOIN drama_productions ON drama_productions.project_id = projects.id").
		Where("projects.user_id = ?", userID)
	if search = strings.TrimSpace(search); search != "" {
		query = query.Where("LOWER(projects.name) LIKE ? ESCAPE '\\'", "%"+strings.ToLower(escapeLike(search))+"%")
	}
	if status != "" {
		query = query.Where("drama_productions.status = ?", status)
	}
	var total int64
	if err := query.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	var projects []model.Project
	err := query.Select("projects.*").Order("projects.updated_at desc").Offset((page - 1) * pageSize).Limit(pageSize).Find(&projects).Error
	return projects, total, err
}

// DramaStatusCounts 统计用户各状态的短剧数量，供列表筛选标签显示。
func (r *Repository) DramaStatusCounts(userID string) (map[string]int64, error) {
	var rows []struct {
		Status string
		Count  int64
	}
	err := r.db.Model(&model.DramaProduction{}).Select("status, COUNT(*) AS count").Where("user_id = ?", userID).Group("status").Scan(&rows).Error
	result := map[string]int64{}
	for _, row := range rows {
		result[row.Status] = row.Count
	}
	return result, err
}

func escapeLike(value string) string {
	return strings.NewReplacer(`\`, `\\`, "%", `\%`, "_", `\_`).Replace(value)
}

func (r *Repository) DramaProductionsForUser(userID string, projectIDs []string) (map[string]model.DramaProduction, error) {
	var productions []model.DramaProduction
	if len(projectIDs) == 0 {
		return map[string]model.DramaProduction{}, nil
	}
	if err := r.db.Where("user_id = ? AND project_id IN ?", userID, projectIDs).Find(&productions).Error; err != nil {
		return nil, err
	}
	result := make(map[string]model.DramaProduction, len(productions))
	for _, production := range productions {
		result[production.ProjectID] = production
	}
	return result, nil
}

// DramaEpisodeCounts 汇总项目列表卡片所需的集数与完成数。
func (r *Repository) DramaEpisodeCounts(projectIDs []string) (map[string][2]int64, error) {
	var rows []struct {
		ProjectID string
		Total     int64
		Done      int64
	}
	result := map[string][2]int64{}
	if len(projectIDs) == 0 {
		return result, nil
	}
	err := r.db.Model(&model.DramaEpisode{}).Select("project_id, COUNT(*) AS total, SUM(CASE WHEN stage = 'done' THEN 1 ELSE 0 END) AS done").
		Where("project_id IN ?", projectIDs).Group("project_id").Scan(&rows).Error
	for _, row := range rows {
		result[row.ProjectID] = [2]int64{row.Total, row.Done}
	}
	return result, err
}

// DramaCoverResources 取每个项目前几张已就绪的角色参考图，列表卡片拼成封面。
func (r *Repository) DramaCoverResources(projectIDs []string, limit int) (map[string][]string, error) {
	var casts []model.DramaCast
	result := map[string][]string{}
	if len(projectIDs) == 0 {
		return result, nil
	}
	err := r.db.Select("project_id", "image_resource_id", "position").Where("project_id IN ? AND kind = ? AND image_status = ?", projectIDs, "character", model.DramaMediaReady).
		Order("position asc").Find(&casts).Error
	for _, cast := range casts {
		if len(result[cast.ProjectID]) < limit {
			result[cast.ProjectID] = append(result[cast.ProjectID], cast.ImageResourceID)
		}
	}
	return result, err
}

// ===== 定向更新 =====
// 调度循环与用户操作并发写同一行时，整行 Save 会互相覆盖；以下方法只写各自负责的列，
// 并用状态或版本号做条件，过期的写入直接失效，由下一轮调度重新推导。

// UpdateDramaProduction 写入用户侧控制字段，并递增版本。
func (r *Repository) UpdateDramaProduction(projectID string, fields map[string]any) error {
	fields["updated_at"] = time.Now()
	fields["revision"] = gorm.Expr("revision + 1")
	return r.db.Model(&model.DramaProduction{}).Where("project_id = ?", projectID).Updates(fields).Error
}

// SaveDramaProductionProgress 写入调度循环负责的进度字段；状态只在仍处于 expectedStatus 时改变。
func (r *Repository) SaveDramaProductionProgress(production *model.DramaProduction, expectedStatus string, statusChanged bool) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		now := time.Now()
		if err := tx.Model(&model.DramaProduction{}).Where("project_id = ?", production.ProjectID).Updates(map[string]any{
			"stage": production.Stage, "bible_json": production.BibleJSON, "spent_microcredits": production.SpentMicrocredits,
			"plan_done": production.PlanDone, "last_tick_at": production.LastTickAt, "updated_at": now,
		}).Error; err != nil {
			return err
		}
		if !statusChanged {
			return nil
		}
		return tx.Model(&model.DramaProduction{}).Where("project_id = ? AND status = ?", production.ProjectID, expectedStatus).
			Updates(map[string]any{"status": production.Status, "pause_reason": production.PauseReason}).Error
	})
}

// UpdateDramaEpisodeIfRevision 只在集未被用户改动（版本未变）时写入调度结果。
func (r *Repository) UpdateDramaEpisodeIfRevision(id string, revision int64, fields map[string]any) (bool, error) {
	fields["updated_at"] = time.Now()
	result := r.db.Model(&model.DramaEpisode{}).Where("id = ? AND revision = ?", id, revision).Updates(fields)
	return result.RowsAffected == 1, result.Error
}

// UpdateDramaEpisodeUser 写入用户修改并递增版本，使调度循环基于旧版本的写入失效。
func (r *Repository) UpdateDramaEpisodeUser(id string, fields map[string]any) error {
	fields["updated_at"] = time.Now()
	fields["revision"] = gorm.Expr("revision + 1")
	return r.db.Model(&model.DramaEpisode{}).Where("id = ?", id).Updates(fields).Error
}

// UpdateDramaShotIf 只在槽位状态仍为 allowed 之一时写入，防止旧任务结果覆盖用户刚发起的重做。

func (r *Repository) UpdateDramaCastIf(id string, allowed []string, fields map[string]any) (bool, error) {
	return r.updateDramaCastMediaConditional(id, fields, func(db *gorm.DB) *gorm.DB {
		return db.Where("image_status IN ?", allowed)
	})
}

// ApplyDramaScript 写入一集的新镜头；revision 不为 nil 时要求集版本未变。
func (r *Repository) ApplyDramaScript(episodeID string, revision *int64, fields map[string]any, shots []model.DramaShot) (bool, error) {
	applied := false
	err := r.db.Transaction(func(tx *gorm.DB) error {
		fields["updated_at"] = time.Now()
		query := tx.Model(&model.DramaEpisode{}).Where("id = ?", episodeID)
		if revision != nil {
			query = query.Where("revision = ?", *revision)
		} else {
			fields["revision"] = gorm.Expr("revision + 1")
		}
		result := query.Updates(fields)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected != 1 {
			return nil
		}
		if err := tx.Where("episode_id = ?", episodeID).Delete(&model.DramaShot{}).Error; err != nil {
			return err
		}
		// 剧情段随镜头重新切分，旧段的提示词不再对得上，重建为待撰写。
		if err := tx.Where("episode_id = ?", episodeID).Delete(&model.DramaSegment{}).Error; err != nil {
			return err
		}
		if len(shots) > 0 {
			if err := tx.CreateInBatches(&shots, 100).Error; err != nil {
				return err
			}
			segments := []model.DramaSegment{}
			seen := map[int]bool{}
			now := time.Now()
			for _, shot := range shots {
				if !seen[shot.SegmentIndex] {
					seen[shot.SegmentIndex] = true
					segments = append(segments, model.DramaSegment{ID: kernel.NewID(), ProjectID: shot.ProjectID, EpisodeID: episodeID, SegmentIndex: shot.SegmentIndex, CreatedAt: now, UpdatedAt: now})
				}
			}
			if err := tx.Create(&segments).Error; err != nil {
				return err
			}
		}
		applied = true
		return nil
	})
	return applied, err
}

func (r *Repository) UpdateDramaCastFields(id string, fields map[string]any) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		var cast model.DramaCast
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&cast, "id = ?", id).Error; err != nil {
			return err
		}
		if name, ok := fields["name"].(string); ok && name != cast.Name && strings.TrimSpace(cast.Name) != "" {
			aliasesJSON := cast.AliasesJSON
			if raw, ok := fields["aliases_json"].(string); ok {
				aliasesJSON = raw
			}
			var aliases []string
			_ = json.Unmarshal([]byte(aliasesJSON), &aliases)
			seen := map[string]bool{name: true}
			merged := make([]string, 0, len(aliases)+1)
			for _, alias := range append(aliases, cast.Name) {
				alias = strings.TrimSpace(alias)
				if alias != "" && !seen[alias] {
					seen[alias] = true
					merged = append(merged, alias)
				}
			}
			raw, _ := json.Marshal(merged)
			fields["aliases_json"] = string(raw)
		}
		fields["updated_at"] = time.Now()
		fields["revision"] = gorm.Expr("revision + 1")
		clearDramaCastTakeOnImageReplace(fields)
		// 任何版本变更都会拒绝旧图片结果，待生成槽位也必须退出等待，避免永久显示运行中。
		imageStatus, explicitImageStatus := fields["image_status"]
		if !explicitImageStatus {
			fields["image_status"] = gorm.Expr("CASE WHEN image_status IN ? THEN ? ELSE image_status END", []string{model.DramaMediaQueued, model.DramaMediaRunning}, model.DramaMediaStale)
		}
		if !explicitImageStatus || imageStatus == model.DramaMediaStale {
			if err := tx.Model(&model.DramaJob{}).Where("cast_id = ? AND kind = ? AND status = ?", id, model.DramaJobCastImage, model.DramaJobQueued).
				Updates(map[string]any{"status": model.DramaJobCanceled, "updated_at": time.Now()}).Error; err != nil {
				return err
			}
		}
		if err := tx.Model(&model.DramaCast{}).Where("id = ?", id).Updates(fields).Error; err != nil {
			return err
		}
		// Asset definitions are attached when submitting video, rather than baked into segment drafts.
		changed := false
		for key, previous := range map[string]string{"name": cast.Name, "appearance": cast.Appearance, "description": cast.Description, "voice_instructions": cast.VoiceInstructions, "voice_profile_id": cast.VoiceProfileID, "voice_sample_resource_id": cast.VoiceSampleResourceID, "aliases_json": cast.AliasesJSON} {
			if value, ok := fields[key]; ok && value != previous {
				changed = true
			}
		}
		if !changed && !dramaCastVideoImageChanged(cast, fields) {
			return nil
		}
		return invalidateDramaCastAssetVideos(tx, cast, changed)
	})
}

func dramaCastVideoImageChanged(cast model.DramaCast, fields map[string]any) bool {
	resourceID := cast.ImageResourceID
	if value, ok := fields["image_resource_id"].(string); ok {
		if value != resourceID {
			return true
		}
		resourceID = value
	}
	return fields["image_status"] == model.DramaMediaReady && cast.ImageStatus != model.DramaMediaReady && resourceID != ""
}

func (r *Repository) updateDramaCastMediaConditional(id string, fields map[string]any, condition func(*gorm.DB) *gorm.DB) (bool, error) {
	fields["updated_at"] = time.Now()
	clearDramaCastTakeOnImageReplace(fields)
	if _, imageResource := fields["image_resource_id"]; !imageResource && fields["image_status"] != model.DramaMediaReady {
		result := condition(r.db.Model(&model.DramaCast{}).Where("id = ?", id)).Updates(fields)
		return result.RowsAffected == 1, result.Error
	}
	applied := false
	err := r.db.Transaction(func(tx *gorm.DB) error {
		var cast model.DramaCast
		err := condition(tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("id = ?", id)).First(&cast).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil
		}
		if err != nil {
			return err
		}
		result := condition(tx.Model(&model.DramaCast{}).Where("id = ?", id)).Updates(fields)
		if result.Error != nil {
			return result.Error
		}
		applied = result.RowsAffected == 1
		if applied && dramaCastVideoImageChanged(cast, fields) {
			return invalidateDramaCastAssetVideos(tx, cast, false)
		}
		return nil
	})
	return applied, err
}

func clearDramaCastTakeOnImageReplace(fields map[string]any) {
	_, hasImage := fields["image_resource_id"]
	_, hasTake := fields["image_take_id"]
	if hasImage && !hasTake {
		fields["image_take_id"] = ""
	}
}

func invalidateDramaCastAssetVideos(tx *gorm.DB, cast model.DramaCast, staleReady bool) error {
	shots, err := (&Repository{db: tx}).DramaShotsReferencingCast(cast.ProjectID, cast.ID)
	if err != nil {
		return err
	}
	seen := map[string]bool{}
	for _, shot := range shots {
		key := shot.EpisodeID + ":" + fmt.Sprint(shot.SegmentIndex)
		if seen[key] {
			continue
		}
		seen[key] = true
		var segment model.DramaSegment
		if err := tx.Where("episode_id = ? AND segment_index = ?", shot.EpisodeID, shot.SegmentIndex).First(&segment).Error; err != nil {
			return err
		}
		if _, err := invalidateDramaSegmentAssetVideo(tx, segment, staleReady); err != nil {
			return err
		}
	}
	return nil
}

// Asset updates leave the segment draft and its revision intact, including in-flight writing.
// Running video jobs remain active for billing and history; VideoRevision prevents stale adoption.
func invalidateDramaSegmentAssetVideo(tx *gorm.DB, segment model.DramaSegment, staleReady bool) (bool, error) {
	cascade, err := dramaSegmentVideoCascades(tx, segment.EpisodeID)
	if err != nil {
		return false, err
	}
	segments := tx.Model(&model.DramaSegment{}).Where("episode_id = ?", segment.EpisodeID)
	if cascade {
		segments = segments.Where("segment_index >= ?", segment.SegmentIndex)
	} else {
		segments = segments.Where("id = ?", segment.ID)
	}
	var affected []model.DramaSegment
	if err := segments.Find(&affected).Error; err != nil {
		return false, err
	}
	ids, marked := make([]string, 0, len(affected)), false
	for _, current := range affected {
		ids = append(ids, current.ID)
		if current.VideoStatus == model.DramaMediaRunning || staleReady && (current.VideoStatus != "" || current.VideoResourceID != "") {
			marked = true
		}
	}
	return marked, invalidateDramaAssetVideoRows(tx, segment.EpisodeID, ids, staleReady, marked)
}

func invalidateDramaAssetVideoRows(tx *gorm.DB, episodeID string, ids []string, staleReady, marked bool) error {
	staleStatuses := []string{model.DramaMediaRunning}
	if staleReady {
		staleStatuses = append(staleStatuses, model.DramaMediaReady)
	}
	if err := tx.Model(&model.DramaSegment{}).Where("id IN ?", ids).Updates(map[string]any{
		"video_status":   gorm.Expr("CASE WHEN video_status IN ? THEN ? ELSE video_status END", staleStatuses, model.DramaMediaStale),
		"video_revision": gorm.Expr("video_revision + 1"),
		"updated_at":     time.Now(),
	}).Error; err != nil {
		return err
	}
	jobs := tx.Model(&model.DramaJob{}).Where("episode_id = ? AND status = ?", episodeID, model.DramaJobQueued)
	if marked {
		jobs = jobs.Where("(kind = ? AND shot_id IN ?) OR kind = ?", model.DramaJobSegmentVideo, ids, model.DramaJobRender)
	} else {
		jobs = jobs.Where("kind = ? AND shot_id IN ?", model.DramaJobSegmentVideo, ids)
	}
	if err := jobs.Updates(map[string]any{"status": model.DramaJobCanceled, "updated_at": time.Now()}).Error; err != nil {
		return err
	}
	if !marked {
		return nil
	}
	return tx.Model(&model.DramaEpisode{}).Where("id = ?", episodeID).Updates(map[string]any{
		"stage":       gorm.Expr("CASE WHEN stage IN ? THEN ? ELSE stage END", []string{model.DramaEpisodeRender, model.DramaEpisodeDone}, model.DramaEpisodeVideo),
		"final_stale": true,
		"revision":    gorm.Expr("revision + 1"),
		"updated_at":  time.Now(),
	}).Error
}

// promptStatusAfterInputChange 决定撰写素材变化后的提示词状态：写好的才标记过期、等用户确认重写；
// 待撰写或撰写中的退回待撰写，由调度按新素材自动写；失败保持失败，等用户重试。
func promptStatusAfterInputChange(current string) string {
	switch current {
	case model.DramaMediaReady, model.DramaMediaStale:
		return model.DramaMediaStale
	case model.DramaMediaFailed:
		return model.DramaMediaFailed
	}
	return ""
}
func (r *Repository) UpdateDramaCastRevision(id string, revision int64, fields map[string]any) (bool, error) {
	return r.updateDramaCastMediaConditional(id, fields, func(db *gorm.DB) *gorm.DB {
		return db.Where("revision = ?", revision)
	})
}

// UpdateDramaEpisodeMeta 修改不影响已生成内容的集字段（标题、素材类型），不递增版本，避免打断调度写入。
func (r *Repository) UpdateDramaEpisodeMeta(episodeID string, fields map[string]any) error {
	fields["updated_at"] = time.Now()
	return r.db.Model(&model.DramaEpisode{}).Where("id = ?", episodeID).Updates(fields).Error
}

func (r *Repository) DramaSegments(episodeID string) ([]model.DramaSegment, error) {
	var segments []model.DramaSegment
	err := r.db.Where("episode_id = ?", episodeID).Order("segment_index asc").Find(&segments).Error
	return segments, err
}

// SaveDramaSegmentOverride 一次保存改写及其参考图编号。
func (r *Repository) SaveDramaSegmentOverride(segment model.DramaSegment) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		var current model.DramaSegment
		if err := tx.Where("episode_id = ? AND segment_index = ?", segment.EpisodeID, segment.SegmentIndex).First(&current).Error; err != nil {
			return err
		}
		if current.VideoPromptOverride == segment.VideoPromptOverride && current.ReferenceLabelsJSON == segment.ReferenceLabelsJSON {
			return nil
		}
		return invalidateDramaSegment(tx, current, map[string]any{"video_prompt_override": segment.VideoPromptOverride, "reference_labels_json": segment.ReferenceLabelsJSON}, true)
	})
}

// SaveDramaSegmentReferenceFields 一次保存图片与音色选择，并使在途作业按修订号失效。
func (r *Repository) SaveDramaSegmentReferenceFields(episodeID string, index int, fields map[string]any, keepReadyPrompt bool) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		var current model.DramaSegment
		if err := tx.Where("episode_id = ? AND segment_index = ?", episodeID, index).First(&current).Error; err != nil {
			return err
		}
		values := map[string]string{"reference_cast_ids_json": current.ReferenceCastIDsJSON, "reference_images_json": current.ReferenceImagesJSON, "audio_cast_ids_json": current.AudioCastIDsJSON, "reference_labels_json": current.ReferenceLabelsJSON}
		changed := false
		for key, value := range fields {
			if values[key] != value {
				changed = true
			}
		}
		if !changed {
			return nil
		}
		keepReadyPrompt = keepReadyPrompt && current.PromptStatus == model.DramaMediaReady
		if !keepReadyPrompt {
			fields["prompt_status"] = promptStatusAfterInputChange(current.PromptStatus)
		}
		return invalidateDramaSegment(tx, current, fields, !keepReadyPrompt)
	})
}

// RequestDramaSegmentPrompts 把指定段标记为待撰写；正在撰写的段保持不动。返回实际排队的段数。
func (r *Repository) RequestDramaSegmentPrompts(projectID, episodeID string, indexes []int) (int, error) {
	return r.requestDramaSegmentPrompts(projectID, episodeID, indexes, false)
}

// RequestDramaGuideSegmentPrompts 只重排所选文字段；引导阶段尚无视频，不使其他段提示词作废。
func (r *Repository) RequestDramaGuideSegmentPrompts(projectID, episodeID string, indexes []int) (int, error) {
	return r.requestDramaSegmentPrompts(projectID, episodeID, indexes, true)
}

func (r *Repository) requestDramaSegmentPrompts(projectID, episodeID string, indexes []int, guided bool) (int, error) {
	queued := 0
	err := r.db.Transaction(func(tx *gorm.DB) error {
		for _, index := range indexes {
			var segment model.DramaSegment
			if err := tx.Where("project_id = ? AND episode_id = ? AND segment_index = ?", projectID, episodeID, index).First(&segment).Error; err != nil {
				return err
			}
			if segment.PromptStatus == "" || segment.PromptStatus == model.DramaMediaQueued || segment.PromptStatus == model.DramaMediaRunning {
				continue
			}
			if guided {
				if err := tx.Model(&model.DramaSegment{}).Where("id = ?", segment.ID).Updates(map[string]any{"prompt_status": "", "prompt_error": "", "revision": gorm.Expr("revision + 1"), "updated_at": time.Now()}).Error; err != nil {
					return err
				}
				if err := tx.Model(&model.DramaEpisode{}).Where("id = ?", episodeID).Updates(map[string]any{"stage": model.DramaEpisodePrompts, "approved": false, "error": "", "revision": gorm.Expr("revision + 1"), "updated_at": time.Now()}).Error; err != nil {
					return err
				}
				if err := tx.Model(&model.DramaJob{}).Where("episode_id = ? AND shot_id = ? AND kind = ? AND status = ?", episodeID, segment.ID, model.DramaJobSegmentPrompt, model.DramaJobQueued).Updates(map[string]any{"status": model.DramaJobCanceled, "updated_at": time.Now()}).Error; err != nil {
					return err
				}
			} else {
				if err := invalidateDramaSegment(tx, segment, map[string]any{"prompt_status": "", "prompt_error": ""}, true); err != nil {
					return err
				}
			}
			queued++
		}
		return nil
	})
	return queued, err
}

// PendingDramaSegments 返回待撰写提示词的段；按集与段序排列。
func (r *Repository) PendingDramaSegments(projectID string) ([]model.DramaSegment, error) {
	var segments []model.DramaSegment
	started := r.db.Model(&model.DramaEpisode{}).Select("id").Where("project_id = ? AND stage <> ?", projectID, model.DramaEpisodeDraft)
	err := r.db.Where("project_id = ? AND prompt_status = ? AND episode_id IN (?)", projectID, "", started).Order("episode_id asc, segment_index asc").Limit(500).Find(&segments).Error
	return segments, err
}

func (r *Repository) DramaSegment(projectID string, id string) (*model.DramaSegment, error) {
	var segment model.DramaSegment
	if err := r.db.First(&segment, "id = ? AND project_id = ?", id, projectID).Error; err != nil {
		return nil, err
	}
	return &segment, nil
}

// MarkDramaSegmentVideoStale 在参考图重做后让该段已生成或生成中的视频过期。提示词只引用参考图编号，
// 不含图片内容，因此保持不变；尚未生成的视频提交时会读取新参考图，无需处理。返回是否有视频被标记。
func (r *Repository) MarkDramaSegmentVideoStale(episodeID string, index int) (bool, error) {
	marked := false
	err := r.db.Transaction(func(tx *gorm.DB) error {
		var segment model.DramaSegment
		if err := tx.Where("episode_id = ? AND segment_index = ?", episodeID, index).First(&segment).Error; err != nil {
			return err
		}
		var err error
		marked, err = invalidateDramaSegmentAssetVideo(tx, segment, true)
		return err
	})
	return marked, err
}

// DeleteDramaCastLook 删除一套造型，并把引用它的镜头回退到角色本体（从 look_cast_ids_json 里移除）。
// 段级手动参考中的造型同步回退到角色本体，重新编号后提示词与视频过期。
func (r *Repository) DeleteDramaCastLook(projectID, lookID string) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		if _, err := New(tx).DramaProductionForUpdate(projectID); err != nil {
			return err
		}
		if err := New(tx).RequireNoDramaCastViews(projectID, lookID); err != nil {
			return err
		}
		var look model.DramaCast
		if err := tx.First(&look, "id = ? AND project_id = ? AND parent_id <> ''", lookID, projectID).Error; err != nil {
			return err
		}
		var shots []model.DramaShot
		if err := tx.Where("project_id = ? AND look_cast_ids_json LIKE ?", projectID, "%\""+lookID+"\"%").Find(&shots).Error; err != nil {
			return err
		}
		for _, shot := range shots {
			var ids []string
			_ = json.Unmarshal([]byte(shot.LookCastIDsJSON), &ids)
			kept := make([]string, 0, len(ids))
			for _, id := range ids {
				if id != lookID {
					kept = append(kept, id)
				}
			}
			encoded, _ := json.Marshal(kept)
			if err := tx.Model(&model.DramaShot{}).Where("id = ?", shot.ID).Update("look_cast_ids_json", string(encoded)).Error; err != nil {
				return err
			}
		}
		var segments []model.DramaSegment
		if err := tx.Where("project_id = ? AND reference_cast_ids_json LIKE ?", projectID, "%\""+lookID+"\"%").Find(&segments).Error; err != nil {
			return err
		}
		for _, segment := range segments {
			var ids []string
			if err := json.Unmarshal([]byte(segment.ReferenceCastIDsJSON), &ids); err != nil {
				return err
			}
			kept := []string{}
			seen := map[string]bool{}
			for _, id := range ids {
				if id == lookID {
					id = look.ParentID
				}
				if !seen[id] {
					kept = append(kept, id)
					seen[id] = true
				}
			}
			encoded, err := json.Marshal(kept)
			if err != nil {
				return err
			}
			if err := invalidateDramaSegment(tx, segment, map[string]any{"reference_cast_ids_json": string(encoded), "prompt_status": promptStatusAfterInputChange(segment.PromptStatus)}, true); err != nil {
				return err
			}
		}
		return tx.Where("id = ? AND project_id = ?", lookID, projectID).Delete(&model.DramaCast{}).Error
	})
}

func (r *Repository) DramaShotsReferencingCast(projectID string, castID string) ([]model.DramaShot, error) {
	var shots []model.DramaShot
	var related []model.DramaCast
	if err := r.db.Where("project_id = ? AND (id = ? OR parent_id = ?)", projectID, castID, castID).Find(&related).Error; err != nil {
		return nil, err
	}
	ids, names := []string{castID}, map[string]bool{}
	for _, cast := range related {
		if cast.ID != castID {
			ids = append(ids, cast.ID)
		} else if cast.Kind == "character" && cast.ParentID == "" {
			var aliases []string
			_ = json.Unmarshal([]byte(cast.AliasesJSON), &aliases)
			for _, name := range append(aliases, cast.Name) {
				if key := dramaCastSpeakerKey(name); key != "" {
					names[key] = true
				}
			}
		}
	}
	references := r.db.Where("scene_cast_id = ?", castID)
	for _, id := range ids {
		pattern := "%\"" + id + "\"%"
		segments := r.db.Model(&model.DramaSegment{}).Select("1").Where("drama_segments.episode_id = drama_shots.episode_id AND drama_segments.segment_index = drama_shots.segment_index AND (reference_cast_ids_json LIKE ? OR audio_cast_ids_json LIKE ?)", pattern, pattern)
		references = references.Or("cast_ids_json LIKE ? OR prop_ids_json LIKE ? OR look_cast_ids_json LIKE ? OR EXISTS (?)", pattern, pattern, pattern, segments)
	}
	if err := r.db.Where("project_id = ?", projectID).Where(references).Find(&shots).Error; err != nil {
		return nil, err
	}
	if len(names) > 0 {
		var voiced []model.DramaShot
		if err := r.db.Where("project_id = ? AND TRIM(dialogue) <> '' AND TRIM(speaker) <> ''", projectID).Find(&voiced).Error; err != nil {
			return nil, err
		}
		seen := make(map[string]bool, len(shots))
		for _, shot := range shots {
			seen[shot.ID] = true
		}
		for _, shot := range voiced {
			key := dramaCastSpeakerKey(shot.Speaker)
			if key != "旁白" && key != "narrator" && key != "画外音" && names[key] && !seen[shot.ID] {
				shots = append(shots, shot)
			}
		}
	}
	return shots, nil
}

func dramaCastSpeakerKey(value string) string {
	var key strings.Builder
	for _, char := range strings.ToLower(strings.TrimSpace(value)) {
		if !unicode.IsSpace(char) && !unicode.IsPunct(char) {
			key.WriteRune(char)
		}
	}
	return key.String()
}

// DramaSegmentStat 是集列表进度使用的剧情段聚合计数；PromptSucceeded 排除提示词或视频失败的已就绪提示词；VideoGenerated 是持有视频的段（含已过期的旧视频）。
type DramaSegmentStat struct {
	EpisodeID       string
	Total           int64
	PromptReady     int64
	PromptSucceeded int64
	VideoReady      int64
	VideoGenerated  int64
	Failed          int64
}

func (r *Repository) DramaSegmentStats(projectID string) (map[string]DramaSegmentStat, error) {
	var rows []DramaSegmentStat
	err := r.db.Model(&model.DramaSegment{}).Select(`episode_id,
		COUNT(*) AS total,
		SUM(CASE WHEN (prompt_status = 'ready' OR video_prompt_override <> '') THEN 1 ELSE 0 END) AS prompt_ready,
		SUM(CASE WHEN prompt_status <> 'failed' AND video_status <> 'failed' AND (prompt_status = 'ready' OR video_prompt_override <> '') THEN 1 ELSE 0 END) AS prompt_succeeded,
		SUM(CASE WHEN video_status = 'ready' THEN 1 ELSE 0 END) AS video_ready,
		SUM(CASE WHEN video_resource_id <> '' THEN 1 ELSE 0 END) AS video_generated,
		SUM(CASE WHEN prompt_status = 'failed' OR video_status = 'failed' THEN 1 ELSE 0 END) AS failed`).
		Where("project_id = ?", projectID).Group("episode_id").Scan(&rows).Error
	if err != nil {
		return nil, err
	}
	stats := make(map[string]DramaSegmentStat, len(rows))
	for _, row := range rows {
		stats[row.EpisodeID] = row
	}
	return stats, nil
}

// FailedDramaSegments 返回提示词或视频失败的剧情段，供待处理与一键重试使用。
func (r *Repository) FailedDramaSegments(projectID string, limit int) ([]model.DramaSegment, error) {
	var segments []model.DramaSegment
	err := r.db.Where("project_id = ? AND (prompt_status = ? OR video_status = ?)", projectID, model.DramaMediaFailed, model.DramaMediaFailed).
		Order("updated_at desc").Limit(limit).Find(&segments).Error
	return segments, err
}

func (r *Repository) UpdateDramaSegmentFields(id string, fields map[string]any) error {
	fields["updated_at"] = time.Now()
	return r.db.Model(&model.DramaSegment{}).Where("id = ?", id).Updates(fields).Error
}

func (r *Repository) UpdateDramaSegmentRevision(id string, revision int64, fields map[string]any) (bool, error) {
	fields["updated_at"] = time.Now()
	result := r.db.Model(&model.DramaSegment{}).Where("id = ? AND revision = ?", id, revision).Updates(fields)
	return result.RowsAffected > 0, result.Error
}

func (r *Repository) UpdateDramaSegmentVideoRevision(id string, revision, videoRevision int64, fields map[string]any) (bool, error) {
	fields["updated_at"] = time.Now()
	result := r.db.Model(&model.DramaSegment{}).Where("id = ? AND revision = ? AND video_revision = ?", id, revision, videoRevision).Updates(fields)
	return result.RowsAffected > 0, result.Error
}

// SetDramaSegmentTail 写入后台抽好的尾帧：只在段版本未变、段视频仍是抽取的那一条且尚无尾帧时生效，
// 迟到的旧视频尾帧不会落到新视频上。
func (r *Repository) SetDramaSegmentTail(id string, revision, videoRevision int64, videoResourceID string, tailResourceID string) (bool, error) {
	result := r.db.Model(&model.DramaSegment{}).
		Where("id = ? AND revision = ? AND video_revision = ? AND video_resource_id = ? AND tail_frame_resource_id = ''", id, revision, videoRevision, videoResourceID).
		Updates(map[string]any{"tail_frame_resource_id": tailResourceID, "updated_at": time.Now()})
	return result.RowsAffected > 0, result.Error
}

func dramaSegmentVideoCascades(tx *gorm.DB, episodeID string) (bool, error) {
	var episodeSettings struct {
		SettingsJSON string
	}
	if err := tx.Model(&model.DramaEpisode{}).
		Select("COALESCE(NULLIF(TRIM(drama_episodes.settings_json), ''), drama_productions.settings_json) AS settings_json").
		Joins("JOIN drama_productions ON drama_productions.project_id = drama_episodes.project_id").
		Where("drama_episodes.id = ?", episodeID).Take(&episodeSettings).Error; err != nil {
		return false, err
	}
	var settings struct {
		VideoContinuity string `json:"videoContinuity"`
	}
	if strings.TrimSpace(episodeSettings.SettingsJSON) != "" {
		if err := json.Unmarshal([]byte(episodeSettings.SettingsJSON), &settings); err != nil {
			return false, err
		}
	}
	if settings.VideoContinuity == "parallel" {
		return false, nil
	}
	return true, nil
}

// markLaterSegmentsStale returns whether later segments depend on the edited
// segment. Independent videos keep their revisions and in-flight result slots.
func markLaterSegmentsStale(tx *gorm.DB, episodeID string, index int) (bool, error) {
	cascade, err := dramaSegmentVideoCascades(tx, episodeID)
	if err != nil || !cascade {
		return cascade, err
	}
	// Queued descendants remain requested, but receive a new revision and wait for the new tail.
	// The new revision also voids running prompt jobs, so those segments go back to pending instead of staying "running".
	return true, tx.Model(&model.DramaSegment{}).Where("episode_id = ? AND segment_index > ?", episodeID, index).
		Updates(map[string]any{
			"video_status":  gorm.Expr("CASE WHEN video_status IN ? THEN ? ELSE video_status END", []string{"ready", "running"}, "stale"),
			"prompt_status": gorm.Expr("CASE WHEN prompt_status = ? THEN '' ELSE prompt_status END", model.DramaMediaRunning),
			"revision":      gorm.Expr("revision + 1"),
			"updated_at":    time.Now(),
		}).Error
}

// invalidateDramaSegment makes user edits and downstream invalidation one transaction.
func invalidateDramaSegment(tx *gorm.DB, segment model.DramaSegment, fields map[string]any, prompts bool) error {
	if _, ok := fields["video_status"]; !ok {
		if segment.VideoStatus != "" {
			fields["video_status"] = model.DramaMediaStale
		}
	}
	fields["revision"] = gorm.Expr("revision + 1")
	fields["updated_at"] = time.Now()
	if err := tx.Model(&model.DramaSegment{}).Where("id = ?", segment.ID).Updates(fields).Error; err != nil {
		return err
	}
	cascade, err := markLaterSegmentsStale(tx, segment.EpisodeID, segment.SegmentIndex)
	if err != nil {
		return err
	}
	stage := "video"
	if prompts {
		stage = "prompts"
	}
	if err := tx.Model(&model.DramaEpisode{}).Where("id = ?", segment.EpisodeID).Updates(map[string]any{"stage": stage, "approved": false, "final_stale": true, "error": "", "revision": gorm.Expr("revision + 1"), "updated_at": time.Now()}).Error; err != nil {
		return err
	}
	jobs := tx.Model(&model.DramaJob{}).Where("episode_id = ? AND status = ? AND kind IN ?", segment.EpisodeID, "queued", []string{"segment_prompt", "segment_video", "render"})
	if !cascade {
		jobs = jobs.Where("shot_id = ? OR kind = ?", segment.ID, model.DramaJobRender)
	}
	return jobs.Updates(map[string]any{"status": "canceled", "updated_at": time.Now()}).Error
}

func (r *Repository) RenameDramaShot(projectID, shotID, name string) error {
	result := r.db.Model(&model.DramaShot{}).Where("id = ? AND project_id = ?", shotID, projectID).Update("name", name)
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return gorm.ErrRecordNotFound
	}
	return nil
}

func (r *Repository) UpdateDramaShotScript(shot model.DramaShot, fields map[string]any) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		fields["updated_at"] = time.Now()
		if err := tx.Model(&model.DramaShot{}).Where("id = ? AND project_id = ?", shot.ID, shot.ProjectID).Updates(fields).Error; err != nil {
			return err
		}
		var segment model.DramaSegment
		if err := tx.Where("episode_id = ? AND segment_index = ?", shot.EpisodeID, shot.SegmentIndex).First(&segment).Error; err != nil {
			return err
		}
		if err := invalidateDramaSegment(tx, segment, map[string]any{"prompt_status": promptStatusAfterInputChange(segment.PromptStatus), "video_prompt_override": ""}, true); err != nil {
			return err
		}
		return tx.Model(&model.DramaEpisode{}).Where("id = ?", shot.EpisodeID).Update("duration_ms", tx.Model(&model.DramaShot{}).Select("COALESCE(SUM(duration_ms),0)").Where("episode_id = ?", shot.EpisodeID)).Error
	})
}

// RestrictDramaImplicitMedia preserves explicit releases and queued jobs, but stops newly inferred auto media.
func (r *Repository) RestrictDramaImplicitMedia(projectID string) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		// Auto planning may have queued a job before setting its segment slot. Preserve that existing authorization.
		queued := tx.Model(&model.DramaJob{}).Select("shot_id").Where("project_id = ? AND kind = ? AND status = ?", projectID, model.DramaJobSegmentVideo, model.DramaJobQueued)
		if err := tx.Model(&model.DramaSegment{}).Where("project_id = ? AND video_status = ? AND id IN (?)", projectID, "", queued).Update("video_status", model.DramaMediaQueued).Error; err != nil {
			return err
		}
		return tx.Model(&model.DramaProduction{}).Where("project_id = ?", projectID).Update("media_requests_only", true).Error
	})
}

func (r *Repository) RequestDramaSegmentVideoExact(projectID, segmentID string, revision int64, modelJSON *string, invalidateLater bool) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		var segment model.DramaSegment
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("project_id = ? AND id = ?", projectID, segmentID).First(&segment).Error; err != nil {
			return err
		}
		if segment.Revision != revision || segment.VideoStatus == model.DramaMediaQueued || segment.VideoStatus == model.DramaMediaRunning {
			return ErrDramaGuideChanged
		}
		fields := map[string]any{"video_status": model.DramaMediaQueued, "video_error": ""}
		if modelJSON != nil {
			fields["video_model_json"] = *modelJSON
		}
		return requestDramaSegmentExact(tx, segment, fields, false, invalidateLater)
	})
}

func (r *Repository) RequestDramaSegmentPromptExact(projectID, segmentID string, revision int64, invalidateLater, allowPending bool) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		var segment model.DramaSegment
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("project_id = ? AND id = ?", projectID, segmentID).First(&segment).Error; err != nil {
			return err
		}
		if segment.Revision != revision || segment.PromptStatus == "" && !allowPending || segment.PromptStatus == model.DramaMediaQueued || segment.PromptStatus == model.DramaMediaRunning || segment.VideoStatus == model.DramaMediaQueued || segment.VideoStatus == model.DramaMediaRunning {
			return ErrDramaGuideChanged
		}
		if allowPending && segment.PromptStatus == "" {
			var active int64
			if err := tx.Model(&model.DramaJob{}).Where("project_id = ? AND shot_id = ? AND kind = ? AND status IN ?", projectID, segmentID, model.DramaJobSegmentPrompt, []string{model.DramaJobQueued, model.DramaJobRunning}).Count(&active).Error; err != nil {
				return err
			}
			if active > 0 {
				return ErrDramaGuideChanged
			}
		}
		fields := map[string]any{"prompt_status": "", "prompt_error": ""}
		if segment.VideoStatus != "" {
			fields["video_status"] = model.DramaMediaStale
		}
		return requestDramaSegmentExact(tx, segment, fields, true, invalidateLater)
	})
}

// Exact requests retain independent queued jobs and successful media; continuity invalidation never enqueues descendants.
func requestDramaSegmentExact(tx *gorm.DB, segment model.DramaSegment, fields map[string]any, prompt, invalidateLater bool) error {
	fields["revision"], fields["updated_at"] = gorm.Expr("revision + 1"), time.Now()
	changed := tx.Model(&model.DramaSegment{}).Where("id = ? AND revision = ?", segment.ID, segment.Revision).Updates(fields)
	if changed.Error != nil {
		return changed.Error
	}
	if changed.RowsAffected != 1 {
		return ErrDramaGuideChanged
	}
	if invalidateLater {
		if _, err := markLaterSegmentsStale(tx, segment.EpisodeID, segment.SegmentIndex); err != nil {
			return err
		}
	}
	stage := model.DramaEpisodeVideo
	if prompt {
		stage = model.DramaEpisodePrompts
	}
	if err := tx.Model(&model.DramaEpisode{}).Where("id = ?", segment.EpisodeID).Updates(map[string]any{"stage": stage, "video_requests_only": true, "approved": false, "final_stale": true, "error": "", "revision": gorm.Expr("revision + 1"), "updated_at": time.Now()}).Error; err != nil {
		return err
	}
	return tx.Model(&model.DramaJob{}).Where("episode_id = ? AND status = ? AND (shot_id = ? OR kind = ?)", segment.EpisodeID, model.DramaJobQueued, segment.ID, model.DramaJobRender).Updates(map[string]any{"status": model.DramaJobCanceled, "updated_at": time.Now()}).Error
}

func (r *Repository) RequestDramaSegmentVideos(projectID, episodeID string, indexes []int, modelJSON *string) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		for _, index := range indexes {
			var segment model.DramaSegment
			if err := tx.Where("project_id = ? AND episode_id = ? AND segment_index = ?", projectID, episodeID, index).First(&segment).Error; err != nil {
				return err
			}
			if segment.VideoStatus == "running" {
				return errors.New("剧情段视频正在生成")
			}
			fields := map[string]any{"video_status": "queued", "video_error": ""}
			if modelJSON != nil {
				fields["video_model_json"] = *modelJSON
			}
			if err := invalidateDramaSegment(tx, segment, fields, false); err != nil {
				return err
			}
		}
		return tx.Model(&model.DramaEpisode{}).Where("id = ?", episodeID).Updates(map[string]any{"approved": true, "media_released": true, "video_requests_only": false}).Error
	})
}

func (r *Repository) RetryDramaResultJobs(projectID string) error {
	return r.retryDramaResultJobs(projectID, nil)
}

func (r *Repository) retryDramaResultJobs(projectID string, jobIDs []string) error {
	return r.db.Transaction(func(tx *gorm.DB) error {
		jobs := func() *gorm.DB {
			query := tx.Model(&model.DramaJob{}).Where("project_id = ? AND status = ?", projectID, model.DramaJobFailed)
			if jobIDs != nil {
				query = query.Where("id IN ?", jobIDs)
			}
			return query
		}
		// 结构化文本返回不完整时，成功任务里保存的结果本身不可用。
		// 这类作业不能重放原任务，否则会再次解析同一份截断 JSON；保留原任务
		// 作为历史记录，清空绑定后让调度器重新提交一次生成。
		if err := jobs().
			Where("kind IN ? AND (error LIKE ? OR (kind = ? AND error LIKE ?))", []string{model.DramaJobPlan, model.DramaJobScript, model.DramaJobSegmentPrompt}, "%模型没有返回可解析的 JSON%", model.DramaJobScript, "%分镜脚本解析失败：%").
			Updates(map[string]any{"status": model.DramaJobQueued, "task_id": "", "error": "", "finished_at": nil, "started_at": nil, "updated_at": time.Now()}).Error; err != nil {
			return err
		}
		// 不合格产物保留为失败历史，由业务槽位重新排队生成；可用产物的登记失败才重放原任务。
		var candidates []model.DramaJob
		if err := jobs().Clauses(clause.Locking{Strength: "UPDATE"}).Where("task_id IN (?)", tx.Model(&model.Task{}).Select("id").Where("status = ?", model.TaskStatusSucceeded)).Order("id").Find(&candidates).Error; err != nil {
			return err
		}
		replayIDs := make([]string, 0, len(candidates))
		for _, job := range candidates {
			if job.Kind == model.DramaJobBible && (job.ResultUnusable() ||
				strings.Contains(job.Error, "模型没有返回可解析的 JSON") ||
				strings.Contains(job.Error, "作品圣经解析失败：作品圣经未返回参考资料的角色、道具与场景数组") ||
				strings.Contains(job.Error, "作品圣经解析失败：作品圣经未返回正式正文的角色、道具与场景数组") ||
				strings.Contains(job.Error, "作品圣经解析失败：作品圣经没有识别到角色、场景或道具")) {
				if err := job.ClearResultUnusable(); err != nil {
					return err
				}
				if err := jobs().Where("id = ?", job.ID).Updates(map[string]any{
					"status": model.DramaJobQueued, "task_id": "", "error": "", "finished_at": nil,
					"started_at": nil, "payload_json": job.PayloadJSON, "updated_at": time.Now(),
				}).Error; err != nil {
					return err
				}
				continue
			}
			if job.Kind == model.DramaJobSegmentVideo {
				var segment model.DramaSegment
				err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("id = ? AND project_id = ? AND episode_id = ?", job.ShotID, job.ProjectID, job.EpisodeID).First(&segment).Error
				if errors.Is(err, gorm.ErrRecordNotFound) {
					continue
				}
				if err != nil {
					return err
				}
				if !dramaVideoJobMatchesSegment(job, segment) {
					continue
				}
			}
			if !job.ResultUnusable() {
				replayIDs = append(replayIDs, job.ID)
			}
		}
		if len(replayIDs) > 0 {
			if err := jobs().Where("id IN ?", replayIDs).Updates(map[string]any{"status": "running", "error": "", "finished_at": nil}).Error; err != nil {
				return err
			}
		}
		return nil
	})
}

// RetryDramaEpisodeText 在持有制作行锁的事务内恢复本集最新、版本仍匹配的失败文字槽位。
// 旧失败作业只保留为历史，不能因一次重试将同槽位的历次任务一起复活。
func (r *Repository) RetryDramaEpisodeText(projectID, episodeID string) (int, error) {
	episode, err := r.DramaEpisode(projectID, episodeID)
	if err != nil {
		return 0, err
	}
	segments, err := r.DramaSegments(episodeID)
	if err != nil {
		return 0, err
	}
	failedSegments := map[string]model.DramaSegment{}
	for _, segment := range segments {
		if segment.PromptStatus == model.DramaMediaFailed {
			failedSegments[segment.ID] = segment
		}
	}
	var jobs []model.DramaJob
	if err := r.db.Where("project_id = ? AND episode_id = ? AND kind IN ?", projectID, episodeID, []string{model.DramaJobScript, model.DramaJobSegmentPrompt}).
		Order("created_at desc, id desc").Find(&jobs).Error; err != nil {
		return 0, err
	}
	seen := map[string]bool{}
	var retryIDs []string
	for _, job := range jobs {
		key := job.Kind + ":" + job.ShotID
		if seen[key] {
			continue
		}
		seen[key] = true
		if job.Status != model.DramaJobFailed {
			continue
		}
		var payload struct {
			Revision int64 `json:"revision"`
		}
		if err := json.Unmarshal([]byte(job.PayloadJSON), &payload); err != nil {
			continue
		}
		switch job.Kind {
		case model.DramaJobScript:
			if episode.Stage != model.DramaEpisodeScript || episode.Error == "" || payload.Revision != episode.Revision {
				continue
			}
			if applied, err := r.UpdateDramaEpisodeIfRevision(episode.ID, episode.Revision, map[string]any{"error": ""}); err != nil {
				return 0, err
			} else if !applied {
				return 0, ErrDramaGuideChanged
			}
		case model.DramaJobSegmentPrompt:
			segment, ok := failedSegments[job.ShotID]
			if !ok || payload.Revision != segment.Revision {
				continue
			}
			if applied, err := r.UpdateDramaSegmentRevision(segment.ID, segment.Revision, map[string]any{"prompt_status": "", "prompt_error": ""}); err != nil {
				return 0, err
			} else if !applied {
				return 0, ErrDramaGuideChanged
			}
		}
		retryIDs = append(retryIDs, job.ID)
	}
	if len(retryIDs) == 0 {
		return 0, nil
	}
	return len(retryIDs), r.retryDramaResultJobs(projectID, retryIDs)
}

// RetryDramaEpisodeRender only reopens the current episode's latest matching render failure.
// Successful generated video and all other failed slots remain untouched.
func (r *Repository) RetryDramaEpisodeRender(projectID, episodeID string) (int, error) {
	episode, err := r.DramaEpisode(projectID, episodeID)
	if err != nil {
		return 0, err
	}
	if episode.Stage != model.DramaEpisodeRender || episode.Error == "" {
		return 0, nil
	}
	var job model.DramaJob
	err = r.db.Where("project_id = ? AND episode_id = ? AND kind = ?", projectID, episodeID, model.DramaJobRender).
		Order("created_at desc, id desc").First(&job).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	var payload struct {
		Revision int64 `json:"revision"`
	}
	if job.Status != model.DramaJobFailed || json.Unmarshal([]byte(job.PayloadJSON), &payload) != nil || payload.Revision != episode.Revision {
		return 0, nil
	}
	if applied, err := r.UpdateDramaEpisodeIfRevision(episode.ID, episode.Revision, map[string]any{"error": ""}); err != nil {
		return 0, err
	} else if !applied {
		return 0, ErrDramaGuideChanged
	}
	return 1, r.retryDramaResultJobs(projectID, []string{job.ID})
}

// ReopenDramaSegmentVideoJob 把生成任务已成功、回写失败的段视频作业重新置为运行中，
// 调度循环会重放同一任务结果；段状态同步改回生成中。返回作业是否仍满足重放条件。
func (r *Repository) ReopenDramaSegmentVideoJob(jobID, segmentID string) (bool, error) {
	reopened := false
	err := r.db.Transaction(func(tx *gorm.DB) error {
		var job model.DramaJob
		err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("id = ? AND shot_id = ? AND kind = ? AND status = ? AND task_id IN (?)", jobID, segmentID, model.DramaJobSegmentVideo, model.DramaJobFailed, tx.Model(&model.Task{}).Select("id").Where("status = ?", model.TaskStatusSucceeded)).First(&job).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil
		}
		if err != nil {
			return err
		}
		var current model.DramaSegment
		err = tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("id = ? AND project_id = ? AND episode_id = ? AND video_status = ?", segmentID, job.ProjectID, job.EpisodeID, model.DramaMediaFailed).First(&current).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil
		}
		if err != nil {
			return err
		}
		if !dramaVideoJobMatchesSegment(job, current) {
			return nil
		}
		now := time.Now()
		result := tx.Model(&model.DramaJob{}).
			Where("id = ? AND shot_id = ? AND kind = ? AND status = ? AND task_id IN (?)", jobID, segmentID, model.DramaJobSegmentVideo, model.DramaJobFailed, tx.Model(&model.Task{}).Select("id").Where("status = ?", model.TaskStatusSucceeded)).
			Updates(map[string]any{"status": model.DramaJobRunning, "error": "", "finished_at": nil, "updated_at": now})
		if result.Error != nil || result.RowsAffected == 0 {
			return result.Error
		}
		segment := tx.Model(&model.DramaSegment{}).Where("id = ? AND revision = ? AND video_revision = ? AND video_status = ?", segmentID, current.Revision, current.VideoRevision, model.DramaMediaFailed).Updates(map[string]any{"video_status": model.DramaMediaRunning, "video_error": "", "updated_at": now})
		if segment.Error != nil {
			return segment.Error
		}
		if segment.RowsAffected == 0 {
			// 段状态已被并发操作改变（例如用户刚点了重新生成），放弃重放。
			return errReopenRaced
		}
		reopened = true
		return nil
	})
	if errors.Is(err, errReopenRaced) {
		return false, nil
	}
	return reopened, err
}

func dramaVideoJobMatchesSegment(job model.DramaJob, segment model.DramaSegment) bool {
	var payload struct {
		Revision      int64 `json:"revision"`
		VideoRevision int64 `json:"videoRevision"`
	}
	return json.Unmarshal([]byte(job.PayloadJSON), &payload) == nil && payload.Revision == segment.Revision && payload.VideoRevision == segment.VideoRevision
}

var errReopenRaced = errors.New("drama segment changed during reopen")

func (r *Repository) RecentDramaSegmentJobs(projectID, episodeID string) ([]model.DramaJob, error) {
	var jobs []model.DramaJob
	err := r.db.Where("project_id = ? AND episode_id = ? AND kind IN ?", projectID, episodeID, []string{model.DramaJobSegmentPrompt, model.DramaJobSegmentVideo}).Order("created_at desc").Find(&jobs).Error
	return jobs, err
}
