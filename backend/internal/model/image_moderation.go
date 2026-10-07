package model

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"time"
)

func ImageModerationResourceVersion(resource *Resource) string {
	payload, _ := json.Marshal([]any{resource.ID, resource.UserID, resource.Provider, resource.Endpoint, resource.Bucket, resource.StorageSettingID, resource.ObjectKey, resource.ETag, resource.Size, resource.MimeType, resource.CreatedAt.UTC()})
	digest := sha256.Sum256(payload)
	return hex.EncodeToString(digest[:])
}

type ImageModerationProvider struct {
	ID             string `gorm:"primaryKey;size:36"`
	Name           string `gorm:"size:120"`
	Type           string `gorm:"size:40"`
	Enabled        bool
	Archived       bool   `gorm:"index"`
	LatestConfigID string `gorm:"size:36"`
	CreatedAt      time.Time
	UpdatedAt      time.Time
}

// Config records are append-only. Reports retain the exact version admitted.
type ImageModerationConfig struct {
	ID                       string `gorm:"primaryKey;size:36"`
	ProviderID               string `gorm:"size:36;uniqueIndex:idx_image_moderation_config_version,priority:1"`
	Version                  int    `gorm:"uniqueIndex:idx_image_moderation_config_version,priority:2"`
	Type                     string `gorm:"size:40"`
	Region                   string `gorm:"size:80"`
	ServicesJSON             string `gorm:"type:text"`
	TimeoutSeconds           int
	MaxCallsPerDay           int
	MinIntervalSeconds       int
	AccessKeyIDEncrypted     string `json:"-" gorm:"type:text"`
	AccessKeySecretEncrypted string `json:"-" gorm:"type:text"`
	CreatedBy                string `gorm:"size:36"`
	CreatedAt                time.Time
}

type ImageModerationPolicy struct {
	ID               string `gorm:"primaryKey;size:40"`
	ActiveProviderID string `gorm:"size:36"`
	ActiveConfigID   string `gorm:"size:36"`
	Revision         int64
	UpdatedAt        time.Time
}

type ImageModerationCheck struct {
	ID              string `gorm:"primaryKey;size:36"`
	UserID          string `gorm:"size:36;index:idx_image_moderation_user_created,priority:1"`
	ResourceID      string `gorm:"size:36;index"`
	ContentVersion  string `gorm:"size:64"`
	ResourceVersion string `gorm:"size:64"`
	ProviderID      string `gorm:"size:36"`
	ConfigID        string `gorm:"size:36"`
	// NULL terminal keys permit repeat checks; a unique key prevents duplicate in-flight calls.
	ActiveKey      *string    `gorm:"size:64;uniqueIndex"`
	Status         string     `gorm:"size:24;index"`
	OverallRisk    string     `gorm:"size:24"`
	RiskTagsJSON   string     `gorm:"type:text"`
	Summary        string     `gorm:"size:500"`
	LeaseOwner     string     `gorm:"size:120"`
	LeaseExpiresAt *time.Time `gorm:"index"`
	CreatedAt      time.Time  `gorm:"index:idx_image_moderation_user_created,priority:2"`
	UpdatedAt      time.Time
	CompletedAt    *time.Time
}

type ImageModerationItem struct {
	ID           string `gorm:"primaryKey;size:36"`
	CheckID      string `gorm:"size:36;uniqueIndex:idx_image_moderation_item_service,priority:1"`
	Service      string `gorm:"size:80;uniqueIndex:idx_image_moderation_item_service,priority:2"`
	Status       string `gorm:"size:24"`
	RiskLevel    string `gorm:"size:24"`
	RiskTagsJSON string `gorm:"type:text"`
	RequestID    string `gorm:"size:160"`
	ErrorCode    string `gorm:"size:80"`
	StartedAt    *time.Time
	CompletedAt  *time.Time
	CreatedAt    time.Time
	UpdatedAt    time.Time
}

// The platform-wide counter prevents a provider switch from resetting the budget.
type ImageModerationDailyUsage struct {
	Day       string `gorm:"primaryKey;size:10"`
	Calls     int
	UpdatedAt time.Time
}
