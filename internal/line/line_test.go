package line

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"testing"
)

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
