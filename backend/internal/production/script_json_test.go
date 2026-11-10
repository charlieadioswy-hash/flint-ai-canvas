package production

import (
	"errors"
	"strings"
	"testing"
)

func TestParseScriptRejectsSeparateDraftsWithoutDroppingShots(t *testing.T) {
	raw := `{"shots":[{"action":"草稿动作"}]}
{"episode":{"synopsis":"本集梗概"}}
{"shots":[{"action":"另一稿动作"}]}`
	shots, err := ParseScript(raw)
	if len(shots) != 0 || !errors.Is(err, ErrNoJSON) || !strings.Contains(err.Error(), "多个独立 JSON 对象") {
		t.Fatalf("separate drafts must fail explicitly instead of selecting a partial script: shots=%v err=%v", shots, err)
	}
	valid := `{"episode":{"synopsis":"本集梗概"},"shots":[{"action":"第一个动作"},{"action":"第二个动作"}],"cast":[]}`
	shots, err = ParseScript(valid)
	if err != nil || len(shots) != 2 || ParseScriptEpisode(valid).Synopsis != "本集梗概" {
		t.Fatalf("one complete object must preserve both shots and metadata: shots=%v err=%v", shots, err)
	}
}
