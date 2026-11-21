package repository

import (
	"yingce/backend/internal/model"

	"gorm.io/gorm"
)

// DramaShotQueueJob reads a direct generation task as a queue entry. It is not
// persisted to drama_jobs and never participates in the production scheduler.
type DramaShotQueueJob struct {
	model.DramaJob    `gorm:"embedded"`
	EpisodeNumber     int
	ShotPosition      int
	TaskStage         string
	StoryboardRows    int
	StoryboardColumns int
}

// Adopted storyboard cells share their board's task ID and may also match a shot take.
const dramaShotQueueKindSQL = "CASE WHEN board.id IS NOT NULL THEN 'storyboard_image' ELSE take.kind END"

type DramaQueueFilter struct {
	Status string
	Kinds  []string
}

func (f DramaQueueFilter) apply(query *gorm.DB, table, kindColumn string) *gorm.DB {
	if len(f.Kinds) > 0 {
		query = query.Where(kindColumn+" IN ?", f.Kinds)
	}
	switch f.Status {
	case "active":
		query = query.Where(table+".status IN ?", []string{model.DramaJobQueued, model.DramaJobRunning})
	case "failed":
		query = query.Where("("+table+".status = ? OR ("+table+".status = ? AND "+table+".error <> ''))", model.DramaJobFailed, model.DramaJobQueued)
	}
	return query
}

func (r *Repository) dramaShotQueueTasks(projectID, userID string) *gorm.DB {
	// Keep the submitted take as the binding even when its shot has been removed.
	takes := r.db.Table("drama_takes AS owned_take").Select("MIN(owned_take.id)").
		Where("owned_take.project_id = ? AND owned_take.kind IN ? AND owned_take.task_id <> ''", projectID, []string{"shot_image", "shot_video", "shot_audio"}).
		Group("owned_take.task_id")
	return r.db.Table("tasks").
		Joins("LEFT JOIN drama_takes AS take ON take.task_id = tasks.id AND take.project_id = tasks.project_id AND take.id IN (?)", takes).
		Joins("LEFT JOIN drama_storyboard_boards AS board ON board.task_id = tasks.id AND board.project_id = tasks.project_id AND board.user_id = tasks.user_id AND tasks.type = ?", "canvas_image").
		Where("tasks.project_id = ? AND tasks.user_id = ?", projectID, userID).
		Where("board.id IS NOT NULL OR take.id IS NOT NULL").
		Where("NOT EXISTS (SELECT 1 FROM drama_jobs WHERE drama_jobs.project_id = tasks.project_id AND drama_jobs.task_id = tasks.id)")
}

func (r *Repository) dramaShotQueueJobs(projectID, userID string) *gorm.DB {
	return r.dramaShotQueueTasks(projectID, userID).
		Joins("LEFT JOIN drama_shots AS shot ON board.id IS NULL AND shot.id = take.owner_id AND shot.project_id = take.project_id").
		Joins("LEFT JOIN drama_episodes AS episode ON episode.id = COALESCE(board.episode_id, shot.episode_id) AND episode.project_id = tasks.project_id").
		Joins("LEFT JOIN billing_orders AS bill ON bill.id = tasks.billing_order_id AND bill.user_id = tasks.user_id AND bill.status = ?", model.BillingStatusSettled).
		Select(`tasks.id AS task_id, tasks.project_id, ` + dramaShotQueueKindSQL + ` AS kind, tasks.status, tasks.error,
			COALESCE(episode.id, '') AS episode_id, COALESCE(shot.id, '') AS shot_id,
			COALESCE(episode.number, 0) AS episode_number, COALESCE(shot.position, 0) AS shot_position,
			COALESCE(board."rows", 0) AS storyboard_rows, COALESCE(board."columns", 0) AS storyboard_columns,
			tasks.created_at, tasks.updated_at, tasks.started_at, tasks.completed_at AS finished_at,
			tasks.stage AS task_stage, COALESCE(bill.actual_amount_microcredits, 0) AS cost_microcredits`)
}

func (r *Repository) RecentDramaShotQueueJobs(projectID, userID string, limit int, filter DramaQueueFilter) ([]DramaShotQueueJob, error) {
	var jobs []DramaShotQueueJob
	err := filter.apply(r.dramaShotQueueJobs(projectID, userID), "tasks", dramaShotQueueKindSQL).Order("tasks.updated_at desc, tasks.id desc").Limit(limit).Scan(&jobs).Error
	return jobs, err
}

func (r *Repository) DramaShotQueueJob(projectID, userID, taskID string) (*DramaShotQueueJob, error) {
	var job DramaShotQueueJob
	if err := r.dramaShotQueueJobs(projectID, userID).Where("tasks.id = ?", taskID).Take(&job).Error; err != nil {
		return nil, err
	}
	return &job, nil
}

func (r *Repository) DramaShotQueueJobCounts(projectID, userID string) (map[string]int64, error) {
	var rows []struct {
		Status string
		Count  int64
	}
	if err := r.dramaShotQueueTasks(projectID, userID).Select("tasks.status, COUNT(*) AS count").Group("tasks.status").Scan(&rows).Error; err != nil {
		return nil, err
	}
	counts := make(map[string]int64, len(rows))
	for _, row := range rows {
		counts[row.Status] = row.Count
	}
	return counts, nil
}
