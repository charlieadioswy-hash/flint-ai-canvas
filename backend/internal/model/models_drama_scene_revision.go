package model

import "time"

// DramaSceneRevision preserves the real previous owners and their media when
// an explicitly reviewed scene replacement removes shots. Tasks stay in Task.
type DramaSceneRevision struct {
	ID             string    `json:"id" gorm:"primaryKey;size:36"`
	ProjectID      string    `json:"projectId" gorm:"index;size:36"`
	EpisodeID      string    `json:"episodeId" gorm:"index;size:36"`
	TaskID         string    `json:"taskId" gorm:"uniqueIndex;size:36"`
	TakeID         string    `json:"takeId" gorm:"size:36"`
	ShotsJSON      string    `json:"shotsJson" gorm:"type:text"`
	SegmentsJSON   string    `json:"segmentsJson" gorm:"type:text"`
	MediaJSON      string    `json:"mediaJson" gorm:"type:text"`
	TakesJSON      string    `json:"takesJson" gorm:"type:text"`
	NewShotIDsJSON string    `json:"newShotIdsJson" gorm:"type:text"`
	CreatedAt      time.Time `json:"createdAt"`
}
