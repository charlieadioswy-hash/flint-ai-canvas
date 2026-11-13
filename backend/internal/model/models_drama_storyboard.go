package model

import "time"

// A storyboard board is one immutable image-generation attempt for ordered
// real shots. Cropped cells are persisted resources, never virtual viewports.
type DramaStoryboardBoard struct {
	ID           string    `json:"id" gorm:"primaryKey;size:36"`
	ProjectID    string    `json:"projectId" gorm:"index;size:36"`
	UserID       string    `json:"-" gorm:"index;size:36"`
	EpisodeID    string    `json:"episodeId" gorm:"index;size:36"`
	Rows         int       `json:"rows"`
	Columns      int       `json:"columns"`
	Revision     int64     `json:"revision"`
	ConfigJSON   string    `json:"-" gorm:"type:text"`
	ShotIDsJSON  string    `json:"-" gorm:"type:text"`
	ScriptHash   string    `json:"-" gorm:"size:64"`
	RequestHash  string    `json:"-" gorm:"size:64"`
	TaskID       string    `json:"taskId,omitempty" gorm:"index;size:36"`
	ResourceID   string    `json:"resourceId,omitempty" gorm:"size:36"`
	Status       string    `json:"status" gorm:"size:24"`
	SourceWidth  int       `json:"sourceWidth"`
	SourceHeight int       `json:"sourceHeight"`
	CreatedAt    time.Time `json:"createdAt"`
	UpdatedAt    time.Time `json:"updatedAt"`
}

type DramaStoryboardCell struct {
	ID               string    `json:"id" gorm:"primaryKey;size:36"`
	ProjectID        string    `json:"projectId" gorm:"index;size:36"`
	BoardID          string    `json:"boardId" gorm:"index;size:36;uniqueIndex:idx_drama_storyboard_cell,priority:1"`
	Index            int       `json:"index" gorm:"uniqueIndex:idx_drama_storyboard_cell,priority:2"`
	Row              int       `json:"row"`
	Column           int       `json:"column"`
	ShotID           string    `json:"shotId,omitempty" gorm:"index;size:36"`
	ParentResourceID string    `json:"parentResourceId" gorm:"size:36"`
	ResourceID       string    `json:"resourceId" gorm:"size:36"`
	X                int       `json:"x"`
	Y                int       `json:"y"`
	Width            int       `json:"width"`
	Height           int       `json:"height"`
	CreatedAt        time.Time `json:"createdAt"`
}
