package app

import (
	"encoding/json"
	"errors"

	"yingce/backend/internal/model"
)

// 多视角模板是一个图片产物，不能把上游拆开的多张结果任取一张作为当前设定图。
func dramaCastImageResource(task *model.Task) (string, error) {
	var result struct {
		Images []json.RawMessage `json:"images"`
	}
	if json.Unmarshal([]byte(task.ResultJSON), &result) != nil || len(result.Images) == 0 {
		return "", errors.New("参考图任务没有返回已保存的图片")
	}
	if len(result.Images) != 1 {
		return "", errors.New("参考图任务必须只返回一张完整图片；收到多张独立图片，未自动采用，请检查模型与模板后重试")
	}
	resourceID := dramaTaskResource(&model.Task{Type: task.Type, ResultJSON: string(result.Images[0])})
	if resourceID == "" {
		return "", errors.New("参考图任务没有返回已保存的图片")
	}
	return resourceID, nil
}
