package model

import "testing"

func TestTransitionRules(t *testing.T) {
	if err := Transition(StateStaged, StateSynced, "id"); err == nil {
		t.Fatalf("expected STAGED -> SYNCED to fail")
	}
	if err := Transition(StateCreatingMedia, StateSynced, ""); err == nil {
		t.Fatalf("expected CREATING_MEDIA -> SYNCED without media ID to fail")
	}
	if err := Transition(StateCreatingMedia, StateSynced, "media-1"); err != nil {
		t.Fatalf("expected CREATING_MEDIA -> SYNCED with ID to pass: %v", err)
	}
}

func TestBackoffBounds(t *testing.T) {
	if got := Backoff(1, 60000); got != 60000 {
		t.Fatalf("expected floor 60000, got %d", got)
	}
	if got := Backoff(99, 0); got > 3600000 {
		t.Fatalf("expected cap <= 3600000, got %d", got)
	}
}
