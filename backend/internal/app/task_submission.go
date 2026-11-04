package app

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"gorm.io/gorm"
	"yingce/backend/internal/model"
)

// The task primary key makes admission atomic across backend instances. The
// receipt lives with the task, so losing an HTTP response cannot create a new
// reservation. Keep this outside public metadata and ignore caller copies.
const taskSubmissionInputKey = "_taskSubmission"

type taskSubmission struct {
	ID   string `json:"id"`
	Hash string `json:"hash"`
}

func newTaskSubmission(userID, operationID, surface string, request any) (*taskSubmission, error) {
	if operationID == "" {
		return nil, nil
	}
	if strings.TrimSpace(userID) == "" || len(operationID) > 128 {
		return nil, BadAuthRequest("任务提交标识无效")
	}
	for _, char := range operationID {
		if !(char >= 'a' && char <= 'z' || char >= 'A' && char <= 'Z' || char >= '0' && char <= '9' || strings.ContainsRune("-_:.", char)) {
			return nil, BadAuthRequest("任务提交标识无效")
		}
	}
	encoded, err := json.Marshal(request)
	if err != nil {
		return nil, BadAuthRequest("任务输入格式无效")
	}
	id := sha256.Sum256([]byte(userID + "\x00" + operationID))
	id[6] = id[6]&0x0f | 0x50
	id[8] = id[8]&0x3f | 0x80
	fingerprint := sha256.Sum256(append([]byte(surface+"\x00"), encoded...))
	return &taskSubmission{ID: fmt.Sprintf("%x-%x-%x-%x-%x", id[:4], id[4:6], id[6:8], id[8:10], id[10:16]), Hash: hex.EncodeToString(fingerprint[:])}, nil
}

func (s *Service) replayTaskSubmission(userID string, submission *taskSubmission) (*model.Task, error) {
	if submission == nil {
		return nil, nil
	}
	task, err := s.repo.TaskForUser(userID, submission.ID)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var input struct {
		Submission taskSubmission `json:"_taskSubmission"`
	}
	if err := json.Unmarshal([]byte(task.InputJSON), &input); err != nil || input.Submission != *submission {
		return nil, &AppError{Status: 409, Code: 409, Message: "同一任务提交标识的内容不同，请重新提交"}
	}
	return taskForOutput(*task), nil
}

// Completed tasks discard execution credentials, but keep the private receipt
// for HTTP replays. Public task responses still use publicTaskInputJSON.
func compactTaskInputJSON(raw string) string {
	public := publicTaskInputJSON(raw)
	var input map[string]json.RawMessage
	if json.Unmarshal([]byte(raw), &input) != nil || len(input[taskSubmissionInputKey]) == 0 {
		return public
	}
	retained := map[string]json.RawMessage{}
	_ = json.Unmarshal([]byte(public), &retained)
	retained[taskSubmissionInputKey] = input[taskSubmissionInputKey]
	encoded, _ := json.Marshal(retained)
	return string(encoded)
}
