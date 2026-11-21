package api

import (
	"fmt"
	"net/http"
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

func rateReq(path, peer string, hdr map[string]string) *http.Request {
	r := httptest.NewRequest("POST", path, nil)
	r.RemoteAddr = peer
	for k, v := range hdr {
		r.Header.Set(k, v)
	}
	return r
}

func TestClientHost(t *testing.T) {
	cases := []struct {
		name, peer, realIP, want string
	}{
		{"private peer trusted", "172.18.0.5:1234", "203.0.113.1", "203.0.113.1"},
		{"loopback peer trusted", "127.0.0.1:1", "203.0.113.1", "203.0.113.1"},
		{"ipv6 loopback trusted", "[::1]:1", "2001:db8::1", "2001:db8::1"},
		{"public peer ignores header", "203.0.113.9:1", "10.0.0.1", "203.0.113.9"},
		{"garbage header ignored", "172.18.0.5:1234", "garbage", "172.18.0.5"},
		{"no header", "172.18.0.5:1234", "", "172.18.0.5"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := rateReq("/", c.peer, map[string]string{"X-Real-IP": c.realIP})
			if got := clientHost(r); got != c.want {
				t.Fatalf("got %q want %q", got, c.want)
			}
		})
	}
}

func TestRateKey(t *testing.T) {
	peer := "172.18.0.5:1234"
	a := rateKey(rateReq("/api/webhooks/line", peer, map[string]string{"X-Real-IP": "203.0.113.1", "X-Line-Signature": "sig-a"}), "")
	b := rateKey(rateReq("/api/webhooks/line", peer, map[string]string{"X-Real-IP": "203.0.113.1", "X-Line-Signature": "sig-b"}), "")
	if a != b || a != "webhook:203.0.113.1" {
		t.Fatalf("webhook keys differ by signature: %q %q", a, b)
	}
	c := rateKey(rateReq("/api/v1/x", peer, map[string]string{"X-Real-IP": "203.0.113.1"}), "")
	d := rateKey(rateReq("/api/v1/x", peer, map[string]string{"X-Real-IP": "203.0.113.2"}), "")
	if c == d || c != "ip:203.0.113.1" {
		t.Fatalf("clients behind one peer share a key: %q %q", c, d)
	}
	if got := rateKey(rateReq("/api/v1/x", peer, map[string]string{"X-Real-IP": "203.0.113.1"}), "sid1"); got != "session:sid1" {
		t.Fatalf("session should win: %q", got)
	}
}

func TestAuthRatePerClient(t *testing.T) {
	s := NewServer(config.Env{AppURL: "https://fixture.invalid"}, nil, nil, nil)
	for i := 1; i <= 8; i++ {
		if !s.checkRate(s.authRates, "login:203.0.113.1", 8, 5*time.Minute) {
			t.Fatalf("call %d refused", i)
		}
	}
	if s.checkRate(s.authRates, "login:203.0.113.1", 8, 5*time.Minute) {
		t.Fatal("9th call allowed")
	}
	if !s.checkRate(s.authRates, "login:203.0.113.2", 8, 5*time.Minute) {
		t.Fatal("other client refused")
	}
}
