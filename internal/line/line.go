package line

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"rivosnap/internal/httpclient"
	"rivosnap/internal/model"
)

func Signed(body []byte, signature, secret string) bool {
	if signature == "" || secret == "" {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	expected := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	if len(signature) != len(expected) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(signature), []byte(expected)) == 1
}

type Source struct {
	Type    string `json:"type"`
	GroupID string `json:"groupId,omitempty"`
}

type Message struct {
	Type string `json:"type"`
	ID   string `json:"id"`
}

type Event struct {
	Type           string   `json:"type"`
	Timestamp      int64    `json:"timestamp"`
	WebhookEventID string   `json:"webhookEventId"`
	Source         *Source  `json:"source,omitempty"`
	Message        *Message `json:"message,omitempty"`
}

type Envelope struct {
	Destination string  `json:"destination"`
	Events      []Event `json:"events"`
}

func ParseEnvelope(raw []byte) (Envelope, error) {
	var env Envelope
	if err := json.Unmarshal(raw, &env); err != nil {
		return env, err
	}
	if len(env.Destination) < 1 || len(env.Destination) > 128 {
		return env, errors.New("invalid destination")
	}
	if env.Events == nil || len(env.Events) > 1000 {
		return env, errors.New("invalid events array")
	}
	for _, e := range env.Events {
		if e.Type == "" || e.Timestamp < 0 || e.WebhookEventID == "" {
			return env, errors.New("invalid event fields")
		}
		if e.Source != nil {
			if e.Source.Type == "" || len(e.Source.GroupID) > 128 {
				return env, errors.New("invalid source")
			}
		}
		if e.Message != nil {
			if e.Message.Type == "" || len(e.Message.ID) < 1 || len(e.Message.ID) > 128 {
				return env, errors.New("invalid message")
			}
		}
	}
	return env, nil
}

func Relevant(e Event) bool {
	if e.Source == nil || e.Source.Type != "group" || e.Source.GroupID == "" {
		return false
	}
	if e.Type == "join" || e.Type == "leave" {
		return true
	}
	if e.Type == "message" && e.Message != nil && (e.Message.Type == "image" || e.Message.Type == "video") {
		return true
	}
	return false
}

func Call(ctx context.Context, path, token string, data bool, timeout time.Duration) (*http.Response, error) {
	host := "api"
	if data {
		host = "api-data"
	}
	if timeout <= 0 {
		timeout = 90 * time.Second
	}
	return httpclient.Request(
		ctx,
		"https://"+host+".line.me/v2/bot/"+path,
		http.MethodGet,
		map[string]string{"Authorization": "Bearer " + token},
		nil,
		0,
		"LINE",
		timeout,
	)
}

func Download(ctx context.Context, id, token string) (*http.Response, error) {
	resp, err := Call(ctx, "message/"+url.PathEscape(id)+"/content", token, true, 600*time.Second)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		if resp.StatusCode == http.StatusAccepted {
			return nil, model.NewFault("LINE_PREPARING", "LINE is still preparing this content.", true, 0)
		}
		return nil, model.NewFault("LINE_DOWNLOAD", "Unexpected LINE content response.", true, 0)
	}
	return resp, nil
}

var ctrlCharsRe = regexp.MustCompile(`[\x00-\x1f\x7f]`)

// ErrNoGroupName means LINE returned an empty or undecodable group summary.
var ErrNoGroupName = errors.New("LINE group summary has no group name")

// CleanGroupName replaces control characters with spaces, trims, and caps the name at 500 runes.
func CleanGroupName(s string) string {
	runes := []rune(strings.TrimSpace(ctrlCharsRe.ReplaceAllString(s, " ")))
	if len(runes) > 500 {
		runes = runes[:500]
	}
	return string(runes)
}

// GroupName fetches and sanitizes a group's display name. Transport errors pass through;
// an empty or undecodable name returns ErrNoGroupName.
func GroupName(ctx context.Context, token, groupID string) (string, error) {
	resp, err := Call(ctx, "group/"+url.PathEscape(groupID)+"/summary", token, false, 90*time.Second)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	var info struct {
		GroupName string `json:"groupName"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&info); err != nil || info.GroupName == "" {
		return "", ErrNoGroupName
	}
	return CleanGroupName(info.GroupName), nil
}
