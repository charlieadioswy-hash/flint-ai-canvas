package app

import (
	"fmt"
	"net/http"
	"testing"

	"yingce/backend/internal/model"
)

func TestDramaCastTakePagination(t *testing.T) {
	svc, fake := newDramaTestService(t)
	projectID := newDramaMaterialProject(t, svc, "历史图分页")
	cast := createDramaMaterial(t, svc, projectID, "character", "角色")
	cast.ImageResourceID = fake.resource("usr-drama", "image", "image/png")
	if err := fake.db.Save(&cast).Error; err != nil {
		t.Fatal(err)
	}
	var rows []model.DramaTake
	for i := 1; i <= 102; i++ {
		row := model.DramaTake{ID: fmt.Sprintf("take-%03d", i), ProjectID: projectID, OwnerID: cast.ID, Kind: "cast", Version: i, ResourceID: "other-image"}
		if i == 1 || i == 2 {
			row.ResourceID = cast.ImageResourceID
		}
		// 同版本号跨页时仍必须按 ID 继续。
		if i == 53 {
			row.Version = 52
		}
		rows = append(rows, row)
	}
	if err := fake.db.Create(&rows).Error; err != nil {
		t.Fatal(err)
	}
	for _, explicit := range []bool{false, true} {
		currentID := rows[1].ID
		if explicit {
			currentID = rows[0].ID
			if err := fake.db.Model(&cast).Update("image_take_id", currentID).Error; err != nil {
				t.Fatal(err)
			}
		}
		cursor := ""
		total := 0
		for page := 0; page < 3; page++ {
			data, err := svc.DramaTakes("usr-drama", projectID, cast.ID, "cast", cursor)
			if err != nil {
				t.Fatal(err)
			}
			takes := data["takes"].([]DramaTakeView)
			if page == 0 {
				if len(takes) != dramaTakeListLimit+1 || takes[len(takes)-1].ID != currentID || !takes[len(takes)-1].Current {
					t.Fatalf("first page did not include the current take %s", currentID)
				}
				takes = takes[:dramaTakeListLimit]
			}
			for _, take := range takes {
				if total >= len(rows) || take.ID != rows[len(rows)-1-total].ID || take.Current != (take.ID == currentID) {
					t.Fatalf("incorrect item %d on page %d: %+v", total, page, take)
				}
				total++
			}
			cursor, _ = data["nextBeforeTakeId"].(string)
			if page < 2 && (len(takes) != dramaTakeListLimit || cursor != takes[len(takes)-1].ID) {
				t.Fatalf("incorrect next cursor %q on page %d", cursor, page)
			}
		}
		if cursor != "" || total != len(rows) {
			t.Fatalf("incomplete history: count=%d, next=%q", total, cursor)
		}
	}
	other := createDramaMaterial(t, svc, projectID, "character", "其他角色")
	if _, err := svc.DramaTakes("usr-drama", projectID, other.ID, "cast", rows[0].ID); !isAppErrorStatus(err, http.StatusNotFound) {
		t.Fatalf("cursor from another asset: %v", err)
	}
}
