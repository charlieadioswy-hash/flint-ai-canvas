package app

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"hash/crc32"
	"image"
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"testing"

	"gorm.io/gorm"
	"yingce/backend/internal/model"
	"yingce/backend/internal/repository"
)

func storyboardFixture(t *testing.T, rows, columns, count int) (*Service, *gorm.DB, DramaStoryboardView) {
	t.Helper()
	s, db, _ := shotMediaFixture(t)
	capability := DefaultModelCapabilityConfigForModel(string(model.ChannelInterfaceGrokImage), "grok-image")
	for _, row := range []any{
		&model.ChannelModel{ID: "board-cm", ChannelID: "channel", ModelKey: "grok-image", Capability: "image", Protocol: model.ChannelInterfaceGrokImage, CapabilityConfigJSON: mustEncodeModelCapabilityConfig(t, capability), BillingMode: "fixed_request", PriceConfigured: true, Enabled: true},
		&model.ChannelModelPriceTier{ID: "board-tier", ChannelModelID: "board-cm", SelectorKey: "{}", SelectorJSON: "{}", BillingMode: "fixed_request", UnitPriceMicrocredits: 2, PriceConfigured: true, Enabled: true},
	} {
		if err := db.Create(row).Error; err != nil {
			t.Fatal(err)
		}
	}
	ids := []string{"real-shot"}
	for index := 1; index < count; index++ {
		id := fmt.Sprintf("real-shot-%d", index)
		if err := db.Create(&model.DramaShot{ID: id, ProjectID: "drama-project", EpisodeID: "episode", Position: index + 1, ImagePrompt: fmt.Sprintf("动作 %d", index)}).Error; err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
	}
	req := DramaStoryboardCreateRequest{ClientOperationID: "board-create", ShotIDs: ids, Rows: rows, Columns: columns, Config: DramaShotMediaConfig{Model: DramaModelChoice{ChannelID: "channel", ModelKey: "grok-image"}, Prompt: "写实电影光线", Operation: "text_to_image", AspectRatio: "1:1", Resolution: "1k"}}
	view, err := s.CreateDramaStoryboard("user", "drama-project", req)
	if err != nil {
		t.Fatal(err)
	}
	replay, err := s.CreateDramaStoryboard("user", "drama-project", req)
	if err != nil || replay.ID != view.ID {
		t.Fatalf("board replay = %+v %v", replay, err)
	}
	return s, db, view
}

func storyboardConfirmed(t *testing.T, s *Service, board DramaStoryboardView) DramaStoryboardActionRequest {
	t.Helper()
	preview, err := s.PreflightDramaStoryboard("user", "drama-project", board.ID, DramaStoryboardActionRequest{ExpectedRevision: &board.Revision})
	if err != nil || !preview.Ready || !preview.Priced || preview.AmountMicrocredits != 2 {
		t.Fatalf("board preflight = %+v %v", preview, err)
	}
	return DramaStoryboardActionRequest{ExpectedRevision: &preview.Revision, BaseRevision: &preview.BaseRevision, ConfirmationToken: preview.ConfirmationToken, ClientOperationID: "board-execute"}
}

func completeStoryboard(t *testing.T, s *Service, db *gorm.DB, board DramaStoryboardView) DramaStoryboardView {
	t.Helper()
	task, err := s.ExecuteDramaStoryboard("user", "drama-project", board.ID, storyboardConfirmed(t, s, board))
	if err != nil {
		t.Fatal(err)
	}
	picture := image.NewNRGBA(image.Rect(0, 0, 13, 11))
	for y := 0; y < 11; y++ {
		for x := 0; x < 13; x++ {
			picture.SetNRGBA(x, y, color.NRGBA{R: uint8(x * 10), G: uint8(y * 10), B: 70, A: 255})
		}
	}
	var output bytes.Buffer
	if err := png.Encode(&output, picture); err != nil {
		t.Fatal(err)
	}
	resource, err := s.UploadResourceFile("user", "board-source.png", int64(output.Len()), "image", 13, 11, 0, bytes.NewReader(output.Bytes()), "board-source")
	if err != nil {
		t.Fatal(err)
	}
	result, _ := json.Marshal(map[string]any{"images": []any{map[string]any{"resourceId": resource.ID}}})
	if err := db.Model(&model.Task{}).Where("id = ?", task.ID).Updates(map[string]any{"status": model.TaskStatusSucceeded, "result_json": string(result)}).Error; err != nil {
		t.Fatal(err)
	}
	stored, _ := s.repo.Task(task.ID)
	if err := s.RegisterTaskOutputFromTask(*stored); err != nil {
		t.Fatal(err)
	}
	view, err := s.DramaStoryboard("user", "drama-project", board.ID)
	if err != nil || view.ResourceID != resource.ID || view.Status != "image_ready" {
		t.Fatalf("board completion = %+v %v", view, err)
	}
	return view
}

func TestDramaStoryboardAdmissionUsesRealImageTaskAndQuote(t *testing.T) {
	s, db, board := storyboardFixture(t, 2, 3, 4)
	request := storyboardConfirmed(t, s, board)
	var count int64
	db.Model(&model.Task{}).Count(&count)
	if count != 0 || len(board.ShotIDs) != 4 || board.ResourceID != "" {
		t.Fatal("draft/preflight generated or fabricated an image")
	}
	task, err := s.ExecuteDramaStoryboard("user", "drama-project", board.ID, request)
	if err != nil {
		t.Fatal(err)
	}
	replay, err := s.ExecuteDramaStoryboard("user", "drama-project", board.ID, request)
	if err != nil || replay.ID != task.ID || task.Type != "canvas_image" {
		t.Fatalf("image admission/replay = %+v %v", replay, err)
	}
	var wallet model.CreditAccount
	db.First(&wallet, "user_id = ?", "user")
	if wallet.AvailableMicrocredits != 9998 || wallet.ReservedMicrocredits != 2 {
		t.Fatalf("board billing = %+v", wallet)
	}
	db.Model(&model.DramaShot{}).Count(&count)
	if count != 4 {
		t.Fatal("empty grid cells fabricated shots")
	}
	request.ConfirmationToken = "different"
	if _, err := s.ExecuteDramaStoryboard("user", "drama-project", board.ID, request); !isAppErrorStatus(err, 409) {
		t.Fatalf("changed operation payload = %v", err)
	}
}

func TestDramaStoryboardRealPNGCropsCoverUnevenSourceAndAdopt(t *testing.T) {
	s, db, board := storyboardFixture(t, 2, 3, 4)
	board = completeStoryboard(t, s, db, board)
	split, err := s.SplitDramaStoryboard(context.Background(), "user", "drama-project", board.ID, DramaStoryboardActionRequest{ExpectedRevision: &board.Revision})
	if err != nil || len(split.Cells) != 6 || split.Status != "split" {
		t.Fatalf("split = %+v %v", split, err)
	}
	covered := make(map[image.Point]bool)
	for _, cell := range split.Cells {
		resource, body, err := s.OpenResource("user", cell.ResourceID)
		if err != nil {
			t.Fatal(err)
		}
		picture, format, err := image.Decode(body)
		_ = body.Close()
		if err != nil || format != "png" || resource.MimeType != "image/png" || picture.Bounds().Dx() != cell.Width || picture.Bounds().Dy() != cell.Height {
			t.Fatalf("fake or invalid PNG crop: %+v %v", cell, err)
		}
		for y := 0; y < cell.Height; y++ {
			for x := 0; x < cell.Width; x++ {
				point := image.Pt(x+cell.X, y+cell.Y)
				if covered[point] {
					t.Fatal("overlapping crop pixels")
				}
				covered[point] = true
				r, g, b, a := picture.At(x, y).RGBA()
				if r>>8 != uint32(point.X*10) || g>>8 != uint32(point.Y*10) || b>>8 != 70 || a>>8 != 255 {
					t.Fatalf("crop pixel differs from real source at %v", point)
				}
			}
		}
	}
	if len(covered) != 13*11 || split.Cells[4].ShotID != "" || split.Cells[5].ShotID != "" {
		t.Fatal("grid did not cover source or invented empty-cell shots")
	}
	cell := split.Cells[0]
	adopted, err := s.AdoptDramaStoryboardCell("user", "drama-project", board.ID, DramaStoryboardAdoptRequest{ExpectedRevision: &split.Revision, ExpectedMediaRevision: &cell.MediaRevision, CellID: cell.ID})
	if err != nil || adopted.ResourceID != cell.ResourceID || adopted.Takes[0].TaskID != board.TaskID || adopted.Takes[0].Kind != "shot_image" || adopted.Takes[0].OwnerID != "real-shot" {
		t.Fatalf("crop adoption = %+v %v", adopted, err)
	}
	repeated, err := s.AdoptDramaStoryboardCell("user", "drama-project", board.ID, DramaStoryboardAdoptRequest{ExpectedRevision: &split.Revision, ExpectedMediaRevision: &cell.MediaRevision, CellID: cell.ID})
	if err != nil || len(repeated.Takes) != 1 {
		t.Fatalf("adopt replay duplicated version: %+v %v", repeated, err)
	}
	empty := split.Cells[5]
	if _, err := s.AdoptDramaStoryboardCell("user", "drama-project", board.ID, DramaStoryboardAdoptRequest{ExpectedRevision: &split.Revision, ExpectedMediaRevision: &empty.MediaRevision, CellID: empty.ID}); err == nil {
		t.Fatal("unassigned grid cell adopted to a fake shot")
	}
	refs, err := s.repo.DramaStoryboardResourceReferences("user", []string{board.ResourceID, cell.ResourceID})
	if err != nil || len(refs) != 2 {
		t.Fatalf("board/cell references = %+v %v", refs, err)
	}
	resource, _ := s.repo.Resource(cell.ResourceID)
	if err := s.repo.DeleteDetachedResources([]model.Resource{*resource}, nil); !errors.Is(err, repository.ErrResourceCleanupStillReferenced) {
		t.Fatalf("crop lost during stale cleanup: %v", err)
	}
}

func TestDramaStoryboardPartialSplitRecoversWithoutDuplicateResources(t *testing.T) {
	s, db, board := storyboardFixture(t, 3, 3, 4)
	board = completeStoryboard(t, s, db, board)
	var before int64
	db.Model(&model.Resource{}).Count(&before)
	created, failed := 0, false
	if err := db.Callback().Create().Before("gorm:create").Register("board_crop_failure", func(tx *gorm.DB) {
		if !failed && tx.Statement.Schema != nil && tx.Statement.Schema.Name == "Resource" {
			created++
			if created == 3 {
				failed = true
				tx.AddError(errors.New("third crop upload failed"))
			}
		}
	}); err != nil {
		t.Fatal(err)
	}
	request := DramaStoryboardActionRequest{ExpectedRevision: &board.Revision}
	if _, err := s.SplitDramaStoryboard(context.Background(), "user", "drama-project", board.ID, request); err == nil {
		t.Fatal("partial upload failure ignored")
	}
	partial, err := s.DramaStoryboard("user", "drama-project", board.ID)
	if err != nil || len(partial.Cells) != 0 || partial.Status == "split" {
		t.Fatalf("partial crops marked ready: %+v %v", partial, err)
	}
	var after int64
	db.Model(&model.Resource{}).Count(&after)
	if after != before+2 {
		t.Fatalf("partial upload count=%d, expected=%d", after, before+2)
	}
	finished, err := s.SplitDramaStoryboard(context.Background(), "user", "drama-project", board.ID, request)
	if err != nil || len(finished.Cells) != 9 {
		t.Fatalf("resumed split = %+v %v", finished, err)
	}
	db.Model(&model.Resource{}).Count(&after)
	if after != before+9 {
		t.Fatalf("retry duplicated saved crops: count=%d expected=%d", after, before+9)
	}
	if _, err := s.SplitDramaStoryboard(context.Background(), "user", "drama-project", board.ID, request); err != nil {
		t.Fatal(err)
	}
	db.Model(&model.Resource{}).Count(&after)
	if after != before+9 {
		t.Fatal("split response replay duplicated resources")
	}
}

func TestDramaStoryboardRejectsCancelledCorruptAndChangedSource(t *testing.T) {
	for _, mode := range []string{"cancelled", "request-cancelled", "changed-script", "corrupt-image", "oversized-image"} {
		t.Run(mode, func(t *testing.T) {
			s, db, board := storyboardFixture(t, 2, 2, 3)
			board = completeStoryboard(t, s, db, board)
			ctx := context.Background()
			switch mode {
			case "cancelled":
				db.Model(&model.Task{}).Where("id = ?", board.TaskID).Update("status", model.TaskStatusCancelled)
			case "request-cancelled":
				var cancel context.CancelFunc
				ctx, cancel = context.WithCancel(ctx)
				cancel()
			case "changed-script":
				db.Model(&model.DramaShot{}).Where("id = ?", "real-shot").Update("action", "新动作")
			case "corrupt-image":
				resource, _ := s.repo.Resource(board.ResourceID)
				if err := os.WriteFile(filepath.Join(s.dataDir, "resources", resource.ObjectKey), []byte("corrupt PNG"), 0600); err != nil {
					t.Fatal(err)
				}
			case "oversized-image":
				header := append([]byte("\x89PNG\r\n\x1a\n"), 0, 0, 0, 13)
				chunk := append([]byte("IHDR"), make([]byte, 13)...)
				binary.BigEndian.PutUint32(chunk[4:8], 100000)
				binary.BigEndian.PutUint32(chunk[8:12], 100000)
				chunk[12], chunk[13] = 8, 6
				header = append(header, chunk...)
				checksum := make([]byte, 4)
				binary.BigEndian.PutUint32(checksum, crc32.ChecksumIEEE(chunk))
				header = append(header, checksum...)
				configuration, _, err := image.DecodeConfig(bytes.NewReader(header))
				if err != nil || configuration.Width != 100000 {
					t.Fatalf("oversized test header is not valid: %+v %v", configuration, err)
				}
				resource, _ := s.repo.Resource(board.ResourceID)
				if err := os.WriteFile(filepath.Join(s.dataDir, "resources", resource.ObjectKey), header, 0600); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := s.SplitDramaStoryboard(ctx, "user", "drama-project", board.ID, DramaStoryboardActionRequest{ExpectedRevision: &board.Revision}); err == nil {
				t.Fatal("invalid source split succeeded")
			}
			cells, _ := s.repo.DramaStoryboardCells("drama-project", board.ID)
			if len(cells) != 0 {
				t.Fatal("invalid source fabricated ready cells")
			}
		})
	}
}

func TestDramaStoryboardAdoptionRejectsDamagedCellAndScriptRevision(t *testing.T) {
	for _, mode := range []string{"damaged", "changed-script", "stale-media", "foreign-user"} {
		t.Run(mode, func(t *testing.T) {
			s, db, board := storyboardFixture(t, 2, 2, 3)
			board = completeStoryboard(t, s, db, board)
			board, err := s.SplitDramaStoryboard(context.Background(), "user", "drama-project", board.ID, DramaStoryboardActionRequest{ExpectedRevision: &board.Revision})
			if err != nil {
				t.Fatal(err)
			}
			cell := board.Cells[0]
			user := "user"
			switch mode {
			case "damaged":
				resource, _ := s.repo.Resource(cell.ResourceID)
				if err := os.WriteFile(filepath.Join(s.dataDir, "resources", resource.ObjectKey), []byte("bad crop"), 0600); err != nil {
					t.Fatal(err)
				}
			case "changed-script":
				db.Model(&model.DramaShot{}).Where("id = ?", "real-shot").Update("action", "已经修改")
			case "stale-media":
				cell.MediaRevision++
			case "foreign-user":
				user = "other"
			}
			if _, err := s.AdoptDramaStoryboardCell(user, "drama-project", board.ID, DramaStoryboardAdoptRequest{ExpectedRevision: &board.Revision, ExpectedMediaRevision: &cell.MediaRevision, CellID: cell.ID}); err == nil {
				t.Fatal("invalid cell adoption succeeded")
			}
			var takes int64
			db.Model(&model.DramaTake{}).Where("kind = ?", "shot_image").Count(&takes)
			if takes != 0 {
				t.Fatal("rejected adoption created a take")
			}
		})
	}
}

func TestDramaStoryboardAdmissionRollbackAndGenericRetryGuard(t *testing.T) {
	s, db, board := storyboardFixture(t, 2, 2, 3)
	request := storyboardConfirmed(t, s, board)
	if err := db.Callback().Update().Before("gorm:update").Register("reject_board_binding", func(tx *gorm.DB) {
		if tx.Statement.Schema != nil && tx.Statement.Schema.Name == "DramaStoryboardBoard" {
			tx.AddError(errors.New("injected board binding failure"))
		}
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.ExecuteDramaStoryboard("user", "drama-project", board.ID, request); err == nil {
		t.Fatal("binding failure ignored")
	}
	var tasks, orders int64
	db.Model(&model.Task{}).Count(&tasks)
	db.Model(&model.BillingOrder{}).Count(&orders)
	var wallet model.CreditAccount
	db.First(&wallet, "user_id = ?", "user")
	if tasks != 0 || orders != 0 || wallet.ReservedMicrocredits != 0 || wallet.AvailableMicrocredits != 10000 {
		t.Fatal("board binding failure leaked task, order, or reservation")
	}
	_ = db.Callback().Update().Remove("reject_board_binding")
	task, err := s.ExecuteDramaStoryboard("user", "drama-project", board.ID, request)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Model(&model.Task{}).Where("id = ?", task.ID).Update("status", model.TaskStatusFailed).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := s.RetryTask("user", task.ID); !isAppErrorStatus(err, 400) {
		t.Fatalf("generic retry bypassed board quote: %v", err)
	}
}

func TestDramaStoryboardRectsRejectInvalidGridAndPreserveCoverage(t *testing.T) {
	for _, grid := range [][2]int{{2, 2}, {2, 3}, {3, 3}} {
		rects, err := dramaStoryboardCellRects(13, 11, grid[0], grid[1])
		if err != nil {
			t.Fatal(err)
		}
		area := 0
		for _, rect := range rects {
			area += rect.Dx() * rect.Dy()
		}
		if area != 143 {
			t.Fatal("uneven grid dropped pixels")
		}
	}
	if _, err := dramaStoryboardCellRects(13, 11, 4, 4); err == nil {
		t.Fatal("unsupported grid accepted")
	}
	if _, err := dramaStoryboardCellRects(1, 1, 3, 3); err == nil {
		t.Fatal("empty-sized crops accepted")
	}
}
