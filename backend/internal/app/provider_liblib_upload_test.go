package app

import (
	"bytes"
	"io"
	"mime"
	"mime/multipart"
	"testing"
)

func TestLiblibOSSFormUsesV4CredentialsAndFileLast(t *testing.T) {
	s := liblibUploadSignature{Key: "inputs/picture.png", Policy: "temporary-policy", Date: "20260101T000000Z", Credential: "temporary-credential", Version: "OSS4-HMAC-SHA256", Signature: "temporary-signature"}
	data, contentType, err := liblibUploadMultipart(s, "picture.png", []byte("image-bytes"))
	if err != nil {
		t.Fatal(err)
	}
	_, params, err := mime.ParseMediaType(contentType)
	if err != nil {
		t.Fatal(err)
	}
	reader := multipart.NewReader(bytes.NewReader(data), params["boundary"])
	fields := map[string]string{}
	last := ""
	for {
		part, err := reader.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		value, _ := io.ReadAll(part)
		fields[part.FormName()] = string(value)
		last = part.FormName()
	}
	if last != "file" || fields["file"] != "image-bytes" || fields["x-oss-signature"] != s.Signature || fields["x-oss-credential"] != s.Credential || fields["policy"] != s.Policy {
		t.Fatalf("invalid OSS form: %+v", fields)
	}
	for _, forbidden := range []string{"AccessKey", "SecretKey", "Signature", "Authorization"} {
		if _, ok := fields[forbidden]; ok {
			t.Fatalf("channel credential sent to OSS: %s", forbidden)
		}
	}
}
