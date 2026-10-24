package canvas

import (
	"bytes"
	"encoding/json"
	"errors"
	"maps"
	"net/http"
	"testing"

	"yingce/backend/internal/kernel"
)

func TestApplyCanvasOperationsActiveChatNullRoundTrip(t *testing.T) {
	for _, test := range []struct {
		name       string
		activeChat json.RawMessage
	}{
		{name: "clear last chat", activeChat: json.RawMessage(`"chat-1"`)},
		{name: "explicit null", activeChat: json.RawMessage(`null`)},
		{name: "omitted on create"},
	} {
		t.Run(test.name, func(t *testing.T) {
			svc := newCanvasOperationTestService(t)
			patch := map[string]json.RawMessage{"title": jsonRawValue("Canvas"), "chatSessions": json.RawMessage(`[]`)}
			if test.activeChat != nil {
				patch["activeChatId"] = test.activeChat
			}
			if test.name == "clear last chat" {
				patch["chatSessions"] = json.RawMessage(`[{"id":"chat-1","messages":[]}]`)
			}
			if _, err := svc.ApplyUserCanvasOperations("user", "canvas", CanvasOperationsRequest{
				MutationID: "create", Operations: []CanvasOperation{{Type: "create_canvas", Patch: patch}},
			}); err != nil {
				t.Fatal(err)
			}
			before := activeChatRegressionDocument(t, svc)
			after := maps.Clone(before)
			after["chatSessions"] = []any{}
			after["activeChatId"] = nil
			operations := DiffCanvasDocuments(before, after)
			if len(operations) == 0 {
				// The browser explicitly sends null for both an absent baseline and
				// an empty selection; replay that wire form through the real service.
				operations = []CanvasOperation{{Type: "set_field", Field: "activeChatId", Value: json.RawMessage(`null`), BeforeValue: json.RawMessage(`null`)}}
			}
			if _, err := svc.ApplyUserCanvasOperations("user", "canvas", CanvasOperationsRequest{
				MutationID: "clear-active-chat", Operations: operations,
			}); err != nil {
				t.Fatal(err)
			}
			actual := activeChatRegressionDocument(t, svc)
			if value, exists := actual["activeChatId"]; !exists || value != nil {
				t.Errorf("GET activeChatId = %#v, exists = %v; want explicit null", value, exists)
			}
			if remaining := DiffCanvasDocuments(actual, after); len(remaining) != 0 {
				t.Errorf("cleared document still needs operations: %#v", remaining)
			}
			stored, err := svc.repo.CanvasProjectForUser("user", "canvas")
			if err != nil {
				t.Fatal(err)
			}
			var persisted map[string]json.RawMessage
			if err := json.Unmarshal([]byte(stored.PayloadJSON), &persisted); err != nil {
				t.Fatal(err)
			}
			if value, exists := persisted["activeChatId"]; !exists || string(value) != "null" {
				t.Errorf("persisted activeChatId = %s, exists = %v; want explicit null", value, exists)
			}
		})
	}
}

func TestApplyCanvasOperationsActiveChatFixKeepsOptionalNullDeletion(t *testing.T) {
	svc := newCanvasOperationTestService(t)
	if _, err := svc.ApplyUserCanvasOperations("user", "canvas", CanvasOperationsRequest{
		MutationID: "create", Operations: []CanvasOperation{{Type: "create_canvas", Patch: map[string]json.RawMessage{
			"title": jsonRawValue("Canvas"), "activeChatId": json.RawMessage(`null`),
			"timeline":      json.RawMessage(`{"tracks":[]}`),
			"creationScene": json.RawMessage(`{"kind":"irregular-screen","version":1}`),
		}}},
	}); err != nil {
		t.Fatal(err)
	}
	before := activeChatRegressionDocument(t, svc)
	after := maps.Clone(before)
	delete(after, "timeline")
	delete(after, "creationScene")
	if _, err := svc.ApplyUserCanvasOperations("user", "canvas", CanvasOperationsRequest{
		MutationID: "remove-optionals", Operations: DiffCanvasDocuments(before, after),
	}); err != nil {
		t.Fatal(err)
	}
	actual := activeChatRegressionDocument(t, svc)
	for _, field := range []string{"timeline", "creationScene"} {
		if value, exists := actual[field]; exists {
			t.Errorf("optional %s remains present after deletion: %#v", field, value)
		}
	}
}

func TestApplyCanvasOperationsActiveChatNullKeepsPreconditions(t *testing.T) {
	for _, test := range []struct {
		name   string
		wire   string
		status int
	}{
		{name: "stale selection", wire: `{"type":"set_field","field":"activeChatId","value":null,"beforeValue":"chat-old"}`, status: http.StatusConflict},
		{name: "stale null", wire: `{"type":"set_field","field":"activeChatId","value":null,"beforeValue":null}`, status: http.StatusConflict},
		{name: "missing value", wire: `{"type":"set_field","field":"activeChatId","beforeValue":"chat-current"}`, status: http.StatusBadRequest},
		{name: "missing beforeValue", wire: `{"type":"set_field","field":"activeChatId","value":null}`, status: http.StatusBadRequest},
	} {
		t.Run(test.name, func(t *testing.T) {
			svc := newCanvasOperationTestService(t)
			if _, err := svc.ApplyUserCanvasOperations("user", "canvas", CanvasOperationsRequest{
				MutationID: "create", Operations: []CanvasOperation{{Type: "create_canvas", Patch: map[string]json.RawMessage{
					"title": jsonRawValue("Canvas"), "activeChatId": jsonRawValue("chat-current"),
				}}},
			}); err != nil {
				t.Fatal(err)
			}
			before, err := svc.UserCanvasProject("user", "canvas")
			if err != nil {
				t.Fatal(err)
			}
			var operation CanvasOperation
			if err := json.Unmarshal([]byte(test.wire), &operation); err != nil {
				t.Fatal(err)
			}
			_, err = svc.ApplyUserCanvasOperations("user", "canvas", CanvasOperationsRequest{
				MutationID: "invalid-clear", Operations: []CanvasOperation{operation},
			})
			var appError *kernel.AppError
			if !errors.As(err, &appError) || appError.Status != test.status {
				t.Fatalf("invalid clear error = %v, want status %d", err, test.status)
			}
			if test.status == http.StatusConflict && appError.Reason != "canvas_field_conflict" {
				t.Errorf("stale selection reason = %q, want canvas_field_conflict", appError.Reason)
			}
			after, err := svc.UserCanvasProject("user", "canvas")
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(before, after) {
				t.Errorf("rejected clear changed the document: before %s, after %s", before, after)
			}
		})
	}
}

func activeChatRegressionDocument(t *testing.T, svc *Service) map[string]any {
	t.Helper()
	raw, err := svc.UserCanvasProject("user", "canvas")
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]any
	if err := json.Unmarshal(raw, &document); err != nil {
		t.Fatal(err)
	}
	return document
}
