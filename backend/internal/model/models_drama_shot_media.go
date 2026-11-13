package model

import "time"

// DramaShotMedia is an independent media slot of an actual DramaShot. Segment
// videos remain owned by DramaSegment; completed versions live in DramaTake.
type DramaShotMedia struct {
	ID            string    `json:"id" gorm:"primaryKey;size:36"`
	ProjectID     string    `json:"projectId" gorm:"index;size:36;uniqueIndex:idx_drama_shot_media_slot,priority:1"`
	EpisodeID     string    `json:"episodeId" gorm:"index;size:36"`
	ShotID        string    `json:"shotId" gorm:"index;size:36;uniqueIndex:idx_drama_shot_media_slot,priority:2"`
	Kind          string    `json:"kind" gorm:"size:16;uniqueIndex:idx_drama_shot_media_slot,priority:3"`
	Revision      int64     `json:"revision"`
	ConfigJSON    string    `json:"-" gorm:"type:text"`
	CurrentTakeID string    `json:"currentTakeId,omitempty" gorm:"size:36"`
	PendingTakeID string    `json:"pendingTakeId,omitempty" gorm:"size:36"`
	TaskID        string    `json:"taskId,omitempty" gorm:"index;size:36"`
	ResourceID    string    `json:"resourceId,omitempty" gorm:"size:36"`
	Status        string    `json:"status" gorm:"size:24"`
	ScriptHash    string    `json:"-" gorm:"size:64"`
	CreatedAt     time.Time `json:"createdAt"`
	UpdatedAt     time.Time `json:"updatedAt"`
}
