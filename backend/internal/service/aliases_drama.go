package service

import "yingce/backend/internal/app"

type (
	CreateDramaRequest            = app.CreateDramaRequest
	UpdateDramaGuideSourceRequest = app.UpdateDramaGuideSourceRequest
	ConfirmDramaGuideRequest      = app.ConfirmDramaGuideRequest
	UpdateDramaSettingsRequest    = app.UpdateDramaSettingsRequest
	UpdateDramaShotRequest        = app.UpdateDramaShotRequest
	UpdateDramaSegmentRequest     = app.UpdateDramaSegmentRequest
	DramaSegmentView              = app.DramaSegmentView
	UpdateDramaCastRequest        = app.UpdateDramaCastRequest
	CreateDramaCastRequest        = app.CreateDramaCastRequest
	ExtractDramaAssetsRequest     = app.ExtractDramaAssetsRequest
	DeleteDramaCastRequest        = app.DeleteDramaCastRequest
	DramaCastImagePromptRequest   = app.DramaCastImagePromptRequest
	ImportDramaCastRequest        = app.ImportDramaCastRequest
	ImportDramaCastResult         = app.ImportDramaCastResult
	SetDramaCastVoiceRequest      = app.SetDramaCastVoiceRequest
	DramaCastLookRequest          = app.DramaCastLookRequest
	DramaEstimateRequest          = app.DramaEstimateRequest
	GenerateDramaSegmentsRequest  = app.GenerateDramaSegmentsRequest
	DramaStudioActionRequest      = app.DramaStudioActionRequest
	DramaStudioBatchRequest       = app.DramaStudioBatchRequest
	DramaListRequest              = app.DramaListRequest
	RegenerateDramaCastsRequest   = app.RegenerateDramaCastsRequest
	ReleaseDramaMediaRequest      = app.ReleaseDramaMediaRequest
	AddDramaEpisodeRequest        = app.AddDramaEpisodeRequest
	UpdateDramaChapterRequest     = app.UpdateDramaChapterRequest
	ProduceDramaChaptersRequest   = app.ProduceDramaChaptersRequest
	UpdateDramaEpisodeRequest     = app.UpdateDramaEpisodeRequest
	RenderDramaEpisodeRequest     = app.RenderDramaEpisodeRequest
	InsertDramaShotRequest        = app.InsertDramaShotRequest
	SetDramaCastImageRequest      = app.SetDramaCastImageRequest
	AdoptDramaSegmentVideoRequest = app.AdoptDramaSegmentVideoRequest
	DramaCanvasAssetsRequest      = app.DramaCanvasAssetsRequest
	DramaArchive                  = app.DramaArchive
	DramaJianyingDraftRequest     = app.DramaJianyingDraftRequest
	DramaJianyingDraftPreview     = app.DramaJianyingDraftPreview
	DramaAssetPackageRequest      = app.DramaAssetPackageRequest
)
