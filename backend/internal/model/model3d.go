package model

import "time"

const TaskTypeCanvasModel3D = "canvas_model3d"

type Model3DProvider struct {
	ID             string `gorm:"primaryKey;size:36"`
	Name           string `gorm:"size:120"`
	Type           string `gorm:"size:40"`
	Enabled        bool
	Archived       bool   `gorm:"index"`
	LatestConfigID string `gorm:"size:36"`
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

// Config versions remain immutable after creation; pending tasks keep their version.
type Model3DConfig struct {
	ID                string `gorm:"primaryKey;size:36"`
	ProviderID        string `gorm:"size:36;uniqueIndex:idx_model3d_config_version,priority:1"`
	Version           int    `gorm:"uniqueIndex:idx_model3d_config_version,priority:2"`
	Type              string `gorm:"size:40"`
	DefaultModel      string `gorm:"size:80"`
	AllowedModelsJSON string `gorm:"type:text"`
	AllowedModesJSON  string `gorm:"type:text"`
	TimeoutSeconds    int
	MaxTasksPerDay    int
	APIKeyEncrypted   string `json:"-" gorm:"type:text"`
	CreatedBy         string `gorm:"size:36"`
	CreatedAt         time.Time
}

type Model3DPolicy struct {
	ID               string `gorm:"primaryKey;size:40"`
	ActiveProviderID string `gorm:"size:36"`
	ActiveConfigID   string `gorm:"size:36"`
	Revision         int64
	UpdatedAt        time.Time
}

// Submission is the durable boundary before a non-idempotent, billable POST.
type Model3DSubmission struct {
	TaskID            string `gorm:"primaryKey;size:36"`
	UserID            string `gorm:"size:36;uniqueIndex:idx_model3d_request,priority:1"`
	RequestID         string `gorm:"size:96;uniqueIndex:idx_model3d_request,priority:2"`
	RequestHash       string `gorm:"size:64"`
	ConfigID          string `gorm:"size:36"`
	State             string `gorm:"size:24"`
	TokensEncrypted   string `json:"-" gorm:"type:text"`
	DeliveryEncrypted string `json:"-" gorm:"type:text"`
	ErrorCode         string `gorm:"size:80"`
	CreatedAt         time.Time
	UpdatedAt         time.Time
}

type Model3DDailyUsage struct {
	Day       string `gorm:"primaryKey;size:10"`
	Tasks     int
	UpdatedAt time.Time
}

func (Model3DProvider) TableName() string   { return "model3d_providers" }
func (Model3DConfig) TableName() string     { return "model3d_configs" }
func (Model3DPolicy) TableName() string     { return "model3d_policies" }
func (Model3DSubmission) TableName() string { return "model3d_submissions" }
func (Model3DDailyUsage) TableName() string { return "model3d_daily_usages" }
