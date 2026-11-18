package app

import (
	"sort"
	"strings"

	"yingce/backend/internal/model"
	"yingce/backend/internal/repository"
)

type DramaWorkflowAffectedSegment struct {
	ID            string `json:"id"`
	EpisodeID     string `json:"episodeId"`
	EpisodeNumber int    `json:"episodeNumber"`
	EpisodeTitle  string `json:"episodeTitle"`
	SegmentIndex  int    `json:"segmentIndex"`
	Revision      int64  `json:"revision"`
	VideoStatus   string `json:"videoStatus"`
	HasVideo      bool   `json:"hasVideo"`
}

type DramaWorkflowImpact struct {
	Kind               string                         `json:"kind"`
	Revision           int64                          `json:"revision"`
	CastID             string                         `json:"castId,omitempty"`
	DeleteScopeToken   string                         `json:"deleteScopeToken,omitempty"`
	Segments           int                            `json:"segments"`
	Shots              int                            `json:"shots,omitempty"`
	Episodes           int                            `json:"episodes"`
	AffectedSegments   int                            `json:"affectedSegments"`
	AssetIDs           []string                       `json:"assetIds"`
	DirectSegments     []DramaWorkflowAffectedSegment `json:"directSegments"`
	ContinuitySegments []DramaWorkflowAffectedSegment `json:"continuitySegments"`
	Message            string                         `json:"message"`
}

func (s *Service) DramaSettingsImpact(userID, projectID string) (DramaWorkflowImpact, error) {
	return s.dramaWorkflowImpact(userID, projectID, "")
}

func (s *Service) dramaWorkflowImpact(userID, projectID, castID string) (DramaWorkflowImpact, error) {
	if _, _, err := s.dramaForUser(userID, projectID); err != nil {
		return DramaWorkflowImpact{}, err
	}
	view := DramaWorkflowImpact{Kind: "style", AssetIDs: []string{}, DirectSegments: []DramaWorkflowAffectedSegment{}, ContinuitySegments: []DramaWorkflowAffectedSegment{}, Message: "保存风格只影响后续明确请求的生成；已有分镜、图片、视频和成片保持当前结果，不自动重写或扣费"}
	err := s.repo.Transaction(func(tx *repository.Repository) error {
		p, err := tx.DramaProductionForUpdate(projectID)
		if err != nil {
			return err
		}
		view.Revision = p.Revision
		defaults := parseDramaSettings(p.SettingsJSON)
		casts, err := tx.DramaCasts(projectID)
		if err != nil {
			return err
		}
		references := map[string]bool{}
		if castID != "" {
			if _, err := tx.DramaCast(projectID, castID); err != nil {
				return dramaLookupError(err)
			}
			view.Kind, view.CastID = "cast", castID
			view.Message = "保存设定不会自动重新生成；重新采用或生成参考图并明确更新引用视频时，下列直接引用段及尾帧续接后续段需要审阅，旧媒体保留"
			references = dramaCastAndLooks(casts, castID)
			for id := range references {
				view.AssetIDs = append(view.AssetIDs, id)
			}
		} else {
			for _, cast := range casts {
				if !dramaCastHasImageStyle(cast) && strings.TrimSpace(cast.ImagePrompt) == "" {
					view.AssetIDs = append(view.AssetIDs, cast.ID)
				}
			}
		}
		sort.Strings(view.AssetIDs)
		var mediaSubjects map[string]bool
		if castID != "" {
			mediaRefs, err := tx.DramaCastMediaReferences(projectID, references)
			if err != nil {
				return err
			}
			mediaSubjects = mediaRefs.Shots
			view.DeleteScopeToken = dramaCastDeleteScopeToken(projectID, castID, p.Revision, mediaRefs.Bindings)
		}
		episodes, err := tx.DramaEpisodes(projectID)
		if err != nil {
			return err
		}
		for _, episode := range episodes {
			parallel := dramaEpisodeSettings(defaults, episode).parallelVideo()
			segments, err := tx.DramaSegments(episode.ID)
			if err != nil {
				return err
			}
			direct := map[int]bool{}
			if castID == "" {
				for _, segment := range segments {
					direct[segment.SegmentIndex] = true
				}
			} else {
				shots, err := tx.DramaShots(episode.ID)
				if err != nil {
					return err
				}
				for _, shot := range shots {
					affected := mediaSubjects[shot.ID]
					for _, id := range append(dramaShotCastIDs(shot), decodeStringList(shot.LookCastIDsJSON)...) {
						if references[id] {
							affected = true
							break
						}
					}
					if affected {
						direct[shot.SegmentIndex] = true
						view.Shots++
					}
				}
				for _, segment := range segments {
					for _, id := range append(decodeStringList(segment.ReferenceCastIDsJSON), decodeStringList(segment.AudioCastIDsJSON)...) {
						if references[id] {
							direct[segment.SegmentIndex] = true
						}
					}
				}
			}
			first, episodeAffected := -1, false
			for _, segment := range segments {
				item := DramaWorkflowAffectedSegment{ID: segment.ID, EpisodeID: episode.ID, EpisodeNumber: episode.Number, EpisodeTitle: episode.Title, SegmentIndex: segment.SegmentIndex, Revision: segment.Revision, VideoStatus: segment.VideoStatus, HasVideo: segment.VideoResourceID != ""}
				if direct[segment.SegmentIndex] {
					view.DirectSegments = append(view.DirectSegments, item)
					episodeAffected = true
					if first < 0 && (segment.VideoStatus == model.DramaMediaReady || segment.VideoStatus == model.DramaMediaRunning) {
						first = segment.SegmentIndex
					}
				} else if first >= 0 && !parallel {
					view.ContinuitySegments = append(view.ContinuitySegments, item)
				}
			}
			if episodeAffected {
				view.Episodes++
			}
		}
		view.Segments = len(view.DirectSegments)
		view.AffectedSegments = view.Segments + len(view.ContinuitySegments)
		return nil
	})
	return view, err
}
