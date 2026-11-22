package repository

import (
	"errors"

	"gorm.io/gorm"

	"yingce/backend/internal/model"
)

var ErrDramaBudgetInsufficient = errors.New("剩余制作预算不足")

// CheckDramaBudget must run inside the transaction holding the production lock.
func (r *Repository) CheckDramaBudget(production *model.DramaProduction, additional int64) error {
	if production == nil || production.BudgetMicrocredits <= 0 || additional <= 0 {
		return nil
	}
	totals, err := r.DramaBillingTotals(production.UserID, []string{production.ProjectID})
	if err != nil {
		return err
	}
	spent := totals[production.ProjectID]
	if additional > production.BudgetMicrocredits-spent.ChargedMicrocredits()-spent.HeldMicrocredits() {
		return ErrDramaBudgetInsufficient
	}
	return nil
}

// lockTaskDramaProduction resolves both direct production tasks and linked canvas tasks.
// Callers acquire this lock before any task, order or account lock.
func (r *Repository) lockTaskDramaProduction(userID, projectID string) (*model.DramaProduction, error) {
	if projectID == "" {
		return nil, nil
	}
	var canvas model.CanvasProject
	err := r.db.Select("project_id").First(&canvas, "id = ? AND user_id = ?", projectID, userID).Error
	if err == nil {
		projectID = canvas.ProjectID
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, err
	}
	if projectID == "" {
		return nil, nil
	}
	production, err := r.DramaProductionForUpdate(projectID)
	if errors.Is(err, gorm.ErrRecordNotFound) || err == nil && production.UserID != userID {
		return nil, nil
	}
	return production, err
}

func (r *Repository) lockDramaProductionForTaskID(userID, taskID string) (*model.DramaProduction, error) {
	if taskID == "" {
		return nil, nil
	}
	var projectID string
	if err := r.db.Model(&model.Task{}).Select("COALESCE(project_id, '')").Where("id = ? AND user_id = ?", taskID, userID).Scan(&projectID).Error; err != nil {
		return nil, err
	}
	return r.lockTaskDramaProduction(userID, projectID)
}

// Resolve the production before locking the order, matching route switches and reservations.
func (r *Repository) lockBillingDramaProduction(orderID string, restoring bool) (*model.DramaProduction, error) {
	if r.Dialect() == "sqlite" {
		if err := r.db.Model(&model.BillingOrder{}).Where("id = ?", orderID).UpdateColumn("id", gorm.Expr("id")).Error; err != nil {
			return nil, err
		}
	}
	var order model.BillingOrder
	if err := r.db.Select("task_id", "user_id", "status").First(&order, "id = ?", orderID).Error; err != nil {
		return nil, err
	}
	if order.Status == model.BillingStatusSettled || (!restoring && order.Status == model.BillingStatusRefunded) {
		return nil, nil
	}
	return r.lockDramaProductionForTaskID(order.UserID, order.TaskID)
}

// DramaBillingTotals 是短剧作品按计费订单汇总的花费，每次读取都按订单当前状态重算，历史数据不需要迁移：
//   - Charged 是已结算订单的实收（actual_amount_microcredits），已扣除差额退回；
//   - Held 是尚未结算订单（冻结中、处理中、待核对）的冻结额（amount_microcredits）；
//   - 已退回订单两项都不计。
//
// Pipeline 是流水线任务（tasks.project_id 为作品 ID），Canvas 是关联画布（canvas_projects.project_id 为作品 ID）上的任务。
type DramaBillingTotals struct {
	PipelineChargedMicrocredits int64
	PipelineHeldMicrocredits    int64
	CanvasChargedMicrocredits   int64
	CanvasHeldMicrocredits      int64
}

// ChargedMicrocredits 是作品已实际扣费的总额。
func (t DramaBillingTotals) ChargedMicrocredits() int64 {
	return t.PipelineChargedMicrocredits + t.CanvasChargedMicrocredits
}

// HeldMicrocredits 是作品仍冻结、尚未结算的总额。
func (t DramaBillingTotals) HeldMicrocredits() int64 {
	return t.PipelineHeldMicrocredits + t.CanvasHeldMicrocredits
}

const (
	dramaChargedSumSQL = "COALESCE(SUM(CASE WHEN billing_orders.status = ? THEN billing_orders.actual_amount_microcredits ELSE 0 END), 0)"
	dramaHeldSumSQL    = "COALESCE(SUM(CASE WHEN billing_orders.status IN (?, ?) THEN 0 ELSE billing_orders.amount_microcredits END), 0)"
)

type dramaBillingRow struct {
	ProjectID string
	Charged   int64
	Held      int64
}

// DramaBillingTotals 一次汇总多部作品的花费（列表页一页一次查询）；只统计当前用户自己的任务与订单。
// 同一任务重试会替换当前订单指针，因此按 task_id 汇总历次订单，保留已结算的历史花费。
func (r *Repository) DramaBillingTotals(userID string, projectIDs []string) (map[string]DramaBillingTotals, error) {
	totals := make(map[string]DramaBillingTotals, len(projectIDs))
	if len(projectIDs) == 0 {
		return totals, nil
	}
	selectSums := "AS project_id, " + dramaChargedSumSQL + " AS charged, " + dramaHeldSumSQL + " AS held"
	args := []any{model.BillingStatusSettled, model.BillingStatusSettled, model.BillingStatusRefunded}
	var pipeline []dramaBillingRow
	if err := r.db.Table("tasks").
		Select("tasks.project_id "+selectSums, args...).
		Joins("JOIN billing_orders ON billing_orders.task_id = tasks.id AND billing_orders.user_id = tasks.user_id").
		Where("tasks.user_id = ? AND tasks.project_id IN ?", userID, projectIDs).
		Group("tasks.project_id").
		Scan(&pipeline).Error; err != nil {
		return nil, err
	}
	var canvas []dramaBillingRow
	if err := r.db.Table("canvas_projects").
		Select("canvas_projects.project_id "+selectSums, args...).
		Joins("JOIN tasks ON tasks.project_id = canvas_projects.id AND tasks.user_id = canvas_projects.user_id").
		Joins("JOIN billing_orders ON billing_orders.task_id = tasks.id AND billing_orders.user_id = tasks.user_id").
		Where("canvas_projects.user_id = ? AND canvas_projects.project_id IN ?", userID, projectIDs).
		Group("canvas_projects.project_id").
		Scan(&canvas).Error; err != nil {
		return nil, err
	}
	for _, row := range pipeline {
		item := totals[row.ProjectID]
		item.PipelineChargedMicrocredits, item.PipelineHeldMicrocredits = row.Charged, row.Held
		totals[row.ProjectID] = item
	}
	for _, row := range canvas {
		item := totals[row.ProjectID]
		item.CanvasChargedMicrocredits, item.CanvasHeldMicrocredits = row.Charged, row.Held
		totals[row.ProjectID] = item
	}
	return totals, nil
}
