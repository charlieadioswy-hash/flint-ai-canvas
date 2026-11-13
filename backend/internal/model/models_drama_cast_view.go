package model

import "time"

// 一个资产内的独立观察视图；不是角色造型，也不是主体图片的历史版本。
type DramaCastView struct {
	ID            string    `json:"id" gorm:"primaryKey;size:36"`
	ProjectID     string    `json:"projectId" gorm:"index;size:36"`
	CastID        string    `json:"castId" gorm:"index;size:36"`
	Revision      int64     `json:"revision"`
	ConfigJSON    string    `json:"-" gorm:"type:text"`
	CurrentTakeID string    `json:"currentTakeId,omitempty" gorm:"size:36"`
	PendingTakeID string    `json:"pendingTakeId,omitempty" gorm:"size:36"`
	TaskID        string    `json:"taskId,omitempty" gorm:"index;size:36"`
	ResourceID    string    `json:"resourceId,omitempty" gorm:"size:36"`
	Status        string    `json:"status" gorm:"size:24"`
	SourceHash    string    `json:"-" gorm:"size:64"`
	CreatedAt     time.Time `json:"createdAt"`
	UpdatedAt     time.Time `json:"updatedAt"`
}
