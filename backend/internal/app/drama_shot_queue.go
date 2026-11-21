package app

import (
	"cmp"
	"fmt"
	"slices"
	"strings"

	"yingce/backend/internal/model"
	"yingce/backend/internal/repository"
)

const dramaShotQueueJobPrefix = "shot-media:"

func dramaQueueFilter(status, kinds string) (repository.DramaQueueFilter, error) {
	filter := repository.DramaQueueFilter{Status: status}
	if status != "" && status != "active" && status != "failed" {
		return filter, BadAuthRequest("任务状态筛选无效")
	}
	if kinds == "" {
		return filter, nil
	}
	for kind := range strings.SplitSeq(kinds, ",") {
		switch kind {
		case model.DramaJobBible, model.DramaJobPlan, model.DramaJobCastImage, model.DramaJobScript, model.DramaJobSegmentPrompt, model.DramaJobSegmentVideo, model.DramaJobRender, "shot_image", "shot_video", "shot_audio", "storyboard_image":
			if !slices.Contains(filter.Kinds, kind) {
				filter.Kinds = append(filter.Kinds, kind)
			}
		default:
			return filter, BadAuthRequest("任务类型筛选无效")
		}
	}
	return filter, nil
}

func dramaQueueStatus(status string) string {
	if status == string(model.TaskStatusCancelled) {
		return model.DramaJobCanceled
	}
	return status
}

func dramaShotQueueJobView(row repository.DramaShotQueueJob) model.DramaJob {
	job := row.DramaJob
	job.ID, job.Status = dramaShotQueueJobPrefix+job.TaskID, dramaQueueStatus(job.Status)
	if job.Kind == "storyboard_image" {
		job.Label = fmt.Sprintf("%d×%d 宫格故事板", row.StoryboardRows, row.StoryboardColumns)
	} else if job.ShotID == "" {
		job.Label = "原分镜已移除"
		return job
	} else {
		job.Label = fmt.Sprintf("分镜 %d", row.ShotPosition+1)
	}
	if row.EpisodeNumber > 0 {
		job.Label = fmt.Sprintf("第 %d 集 · %s", row.EpisodeNumber, job.Label)
	}
	return job
}

func (s *Service) dramaShotQueueJobDetail(project model.Project, production model.DramaProduction, jobID string) (DramaJobDetail, error) {
	taskID := strings.TrimPrefix(jobID, dramaShotQueueJobPrefix)
	row, err := s.repo.DramaShotQueueJob(project.ID, project.UserID, taskID)
	if err != nil {
		return DramaJobDetail{}, dramaLookupError(err)
	}
	task, err := s.repo.TaskForUser(project.UserID, taskID)
	if err != nil {
		return DramaJobDetail{}, dramaLookupError(err)
	}
	job := dramaShotQueueJobView(*row)
	job.Status, job.Error, job.StartedAt, job.FinishedAt, job.UpdatedAt = dramaQueueStatus(string(task.Status)), task.Error, task.StartedAt, task.CompletedAt, task.UpdatedAt
	view := dramaJobView(job)
	if job.Status == model.DramaJobRunning && task.ProviderRequestID != "" {
		view.ProviderStage = task.Stage
	} else if job.Status == model.DramaJobQueued {
		view.Wait = task.Stage
	}
	labels := dramaModelLabels(parseDramaSettings(production.SettingsJSON).Models)
	return DramaJobDetail{
		Job: view, Target: job.Label,
		Attempts: []DramaJobAttemptView{{
			DramaJobAttempt: DramaJobAttempt{TaskID: task.ID, Status: view.Status, Error: view.Error, CostMicrocredits: view.CostMicrocredits, At: view.CreatedAt},
			Task:            dramaJobTaskView(task, labels),
		}},
	}, nil
}

func mergeDramaQueueJobs(jobs []model.DramaJob, shotJobs []repository.DramaShotQueueJob, limit int) []model.DramaJob {
	for _, row := range shotJobs {
		jobs = append(jobs, dramaShotQueueJobView(row))
	}
	slices.SortFunc(jobs, func(a, b model.DramaJob) int {
		if order := b.UpdatedAt.Compare(a.UpdatedAt); order != 0 {
			return order
		}
		return cmp.Compare(b.ID, a.ID)
	})
	return jobs[:min(len(jobs), limit)]
}
