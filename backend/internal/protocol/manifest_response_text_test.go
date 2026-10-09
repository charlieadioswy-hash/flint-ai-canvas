package protocol

import (
	"context"
	"testing"
)

func TestManifestResponseStringNestedArrays(t *testing.T) {
	for _, tc := range []struct {
		name  string
		value any
		want  string
	}{
		{"scalar", " plain text ", "plain text"},
		{"number", 42, "42"},
		{"boolean", true, "true"},
		{"flat", []any{" first ", nil, "", "second"}, "firstsecond"},
		{"nested", []any{[]any{"first", "second"}, []any{}, []any{nil, []any{"third", "fourth"}}}, "firstsecondthirdfourth"},
		{"object", map[string]any{"text": "value"}, `{"text":"value"}`},
		{"nested object", []any{[]any{map[string]any{"text": "value"}}, "tail"}, `{"text":"value"}tail`},
		{"empty", nil, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := manifestResponseString("${response.value}", map[string]any{"response": map[string]any{"value": tc.value}}); got != tc.want {
				t.Fatalf("text = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestManifestResponseTextJoinsEveryMessageAndPart(t *testing.T) {
	adapter, err := LoadManifest([]byte(`{
		"apiVersion":"yingce.plugin/v1","id":"nested-text","version":"1.0.0","name":"Nested Text","author":"Test","documentation":"# Test",
		"contributes":{"providers":[{"id":"nested-text","label":"Nested Text","capabilities":["text"],"scopes":["canvas"],"create":{"method":"POST","path":"/responses"},
		"response":{"text":{"$map":{"from":{"$filter":{"from":"${response.output}","as":"message","where":{"$eq":["${message.type}","message"]}}},"as":"message","in":{"$map":{"from":{"$filter":{"from":"${message.content}","as":"part","where":{"$eq":["${part.type}","output_text"]}}},"as":"part","in":"${part.text}"}}}}}}]}
	}`))
	if err != nil {
		t.Fatal(err)
	}
	result, err := adapter.ParseCreate(context.Background(), []byte(`{"output":[
		{"type":"reasoning","content":[{"type":"output_text","text":"ignored"}]},
		{"type":"message","content":[{"type":"output_text","text":"alpha"},{"type":"refusal","text":"ignored"},{"type":"output_text","text":"beta"}]},
		{"type":"message","content":[]},
		{"type":"message","content":[{"type":"output_text","text":"gamma"},{"type":"output_text","text":"delta"}]}
	]}`))
	if err != nil || result.Result == nil || result.Result.Text != "alphabetagammadelta" || result.Status != StatusSucceeded {
		t.Fatalf("result = %#v, content = %#v, err = %v", result, result.Result, err)
	}
}
