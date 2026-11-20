package crypto

import (
	"strings"
	"testing"
)

func TestSealAndOpenNodeCompatibility(t *testing.T) {
	hexKey := strings.Repeat("1", 64)
	plain := "refresh-token-value-12345"
	sealed, err := Seal(plain, hexKey)
	if err != nil {
		t.Fatalf("Seal failed: %v", err)
	}
	if len(strings.Split(sealed, ".")) != 3 {
		t.Fatalf("expected 3 dot-separated base64 segments, got %s", sealed)
	}
	opened, err := Open(sealed, hexKey)
	if err != nil {
		t.Fatalf("Open failed: %v", err)
	}
	if opened != plain {
		t.Fatalf("expected %q, got %q", plain, opened)
	}
}

func TestArgon2PasswordHashAndVerify(t *testing.T) {
	hash, err := HashPassword("long-fixture-password")
	if err != nil {
		t.Fatalf("HashPassword failed: %v", err)
	}
	if !strings.HasPrefix(hash, "$argon2id$v=19$") {
		t.Fatalf("unexpected PHC prefix: %s", hash)
	}
	if !VerifyPassword(hash, "long-fixture-password") {
		t.Fatalf("expected VerifyPassword to succeed")
	}
	if VerifyPassword(hash, "wrong-password") {
		t.Fatalf("expected VerifyPassword to reject wrong password")
	}
}

func TestCookieSignAndUnsign(t *testing.T) {
	secret := strings.Repeat("x", 32)
	signed := SignCookie("session-123", secret)
	val, ok := UnsignCookie(signed, secret)
	if !ok || val != "session-123" {
		t.Fatalf("expected session-123, got %q (ok=%v)", val, ok)
	}
	if _, ok := UnsignCookie(signed+"tamper", secret); ok {
		t.Fatalf("expected tampered cookie to fail")
	}
}
