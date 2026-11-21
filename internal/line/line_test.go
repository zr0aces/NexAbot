package line

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"io"
	"net/http"
	"strings"
	"testing"
)

type roundTripFunc func(req *http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) { return f(req) }

func TestSignatureBindsExactRawBytes(t *testing.T) {
	b := []byte("{ }")
	mac := hmac.New(sha256.New, []byte("key"))
	mac.Write(b)
	s := base64.StdEncoding.EncodeToString(mac.Sum(nil))
	if !Signed(b, s, "key") {
		t.Fatalf("expected valid signature")
	}
	if Signed([]byte("{}"), s, "key") {
		t.Fatalf("expected modified bytes to fail signature check")
	}
}

func TestRelevantEvents(t *testing.T) {
	if Relevant(Event{
		Type:           "message",
		Source:         &Source{Type: "room"},
		Message:        &Message{Type: "image", ID: "1"},
		Timestamp:      1,
		WebhookEventID: "e",
	}) {
		t.Fatalf("rooms should not be relevant")
	}
	if !Relevant(Event{
		Type:           "message",
		Source:         &Source{Type: "group", GroupID: "g1"},
		Message:        &Message{Type: "video", ID: "1"},
		Timestamp:      1,
		WebhookEventID: "e",
	}) {
		t.Fatalf("group video should be relevant")
	}
	if Relevant(Event{
		Type:           "message",
		Source:         &Source{Type: "group", GroupID: "g1"},
		Message:        &Message{Type: "audio", ID: "2"},
		Timestamp:      1,
		WebhookEventID: "e2",
	}) {
		t.Fatalf("group audio should not be relevant")
	}
}

func TestCleanGroupName(t *testing.T) {
	cases := []struct{ name, in, want string }{
		{"control chars", "a\x00b\x1fc\x7fd", "a b c d"},
		{"tab and newline", "x\ty\nz", "x y z"},
		{"thai unchanged", "ครอบครัวสุขสันต์", "ครอบครัวสุขสันต์"},
		{"trimmed", "\t hi \n", "hi"},
		{"truncated", strings.Repeat("ก", 600), strings.Repeat("ก", 500)},
	}
	for _, c := range cases {
		if got := CleanGroupName(c.in); got != c.want {
			t.Errorf("%s: got %q want %q", c.name, got, c.want)
		}
	}
}

func TestGroupNameEscapesID(t *testing.T) {
	orig := http.DefaultTransport
	defer func() { http.DefaultTransport = orig }()
	var gotPath string
	http.DefaultTransport = roundTripFunc(func(req *http.Request) (*http.Response, error) {
		gotPath = req.URL.EscapedPath()
		return &http.Response{
			StatusCode: 200,
			Header:     http.Header{"Content-Type": []string{"application/json"}},
			Body:       io.NopCloser(strings.NewReader(`{"groupName":"x\ty"}`)),
			Request:    req,
		}, nil
	})
	name, err := GroupName(context.Background(), "t", "a/b")
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/v2/bot/group/a%2Fb/summary" {
		t.Fatalf("path = %q", gotPath)
	}
	if name != "x y" {
		t.Fatalf("name = %q", name)
	}
}

func TestGroupNameEmptyIsError(t *testing.T) {
	orig := http.DefaultTransport
	defer func() { http.DefaultTransport = orig }()
	http.DefaultTransport = roundTripFunc(func(req *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"groupName":""}`)), Request: req}, nil
	})
	if _, err := GroupName(context.Background(), "t", "g"); err == nil {
		t.Fatal("expected error for empty name")
	}
}
