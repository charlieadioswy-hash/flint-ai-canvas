package model

import (
	"encoding/json"
	"errors"
)

const dramaJobUnusableResultKey = "unusableResultTaskId"

// MarkResultUnusable 保留作业的版本等参数，只标记本次任务的结果不能通过重放恢复。
func (job *DramaJob) MarkResultUnusable(taskID string) error {
	if taskID == "" {
		return errors.New("不合格结果缺少任务 ID")
	}
	payload := map[string]json.RawMessage{}
	if job.PayloadJSON != "" {
		if err := json.Unmarshal([]byte(job.PayloadJSON), &payload); err != nil {
			return err
		}
	}
	if payload == nil {
		payload = map[string]json.RawMessage{}
	}
	payload[dramaJobUnusableResultKey], _ = json.Marshal(taskID)
	encoded, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	job.PayloadJSON = string(encoded)
	return nil
}

func (job DramaJob) ResultUnusable() bool {
	var payload map[string]json.RawMessage
	if job.TaskID == "" || json.Unmarshal([]byte(job.PayloadJSON), &payload) != nil {
		return false
	}
	var taskID string
	return json.Unmarshal(payload[dramaJobUnusableResultKey], &taskID) == nil && taskID == job.TaskID
}
