package app

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
)

func signProtocolLiblib(req *http.Request, accessKey, secretKey string) error {
	return signProtocolLiblibAt(req, accessKey, secretKey, time.Now().UnixMilli(), uuid.NewString())
}

func signProtocolLiblibAt(req *http.Request, accessKey, secretKey string, timestamp int64, nonce string) error {
	if req == nil || req.URL == nil || strings.TrimSpace(accessKey) == "" || strings.TrimSpace(secretKey) == "" {
		return errors.New("Liblib 鉴权需要 AccessKey 和 SecretKey")
	}
	if timestamp <= 0 || strings.TrimSpace(nonce) == "" {
		return errors.New("Liblib 签名时间戳或随机串无效")
	}
	// The platform signs the actual request URI, not the base URL or JSON body.
	timestampText := strconv.FormatInt(timestamp, 10)
	message := req.URL.EscapedPath() + "&" + timestampText + "&" + nonce
	mac := hmac.New(sha1.New, []byte(secretKey))
	_, _ = mac.Write([]byte(message))
	query := req.URL.Query()
	query.Set("AccessKey", accessKey)
	query.Set("Timestamp", timestampText)
	query.Set("SignatureNonce", nonce)
	query.Set("Signature", base64.RawURLEncoding.EncodeToString(mac.Sum(nil)))
	req.URL.RawQuery = query.Encode()
	return nil
}
