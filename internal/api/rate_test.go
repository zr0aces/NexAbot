package api

import (
	"fmt"
	"net/http/httptest"
	"rivosnap/internal/config"
	"strings"
	"testing"
	"time"
)

func TestAuthRateUsesPeerAcrossConnections(t *testing.T) {
	s := NewServer(config.Env{AppURL: "https://fixture.invalid"}, nil, nil, nil)
	h := s.Handler()
	for i := 0; i < 9; i++ {
		req := httptest.NewRequest("POST", "/api/v1/auth/login", strings.NewReader("{"))
		req.RemoteAddr = fmt.Sprintf("[::1]:%d", 3000+i)
		req.Header.Set("Origin", s.Env.AppURL)
		req.Header.Set("X-Gallery-Request", "1")
		res := httptest.NewRecorder()
		h.ServeHTTP(res, req)
		want := 400
		if i == 8 {
			want = 429
		}
		if res.Code != want {
			t.Fatalf("request %d: got %d want %d", i, res.Code, want)
		}
	}
	s.authRates["expired"] = rateEntry{resetAt: time.Now().Add(-time.Hour)}
	s.nextRateSweep = time.Time{}
	s.checkRate(s.rateMap, "other", 8, time.Minute)
	if _, found := s.authRates["expired"]; found {
		t.Fatal("expired bucket retained")
	}
}
