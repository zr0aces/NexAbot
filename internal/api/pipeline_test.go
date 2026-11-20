package api_test

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"

	"rivosnap/internal/api"
	"rivosnap/internal/config"
	"rivosnap/internal/db"
	"rivosnap/internal/google"
	"rivosnap/internal/media"
	"rivosnap/internal/worker"
)

type roundTripFunc func(req *http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return f(req)
}

func makeTestPNG(t *testing.T) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 20, 15))
	for y := 0; y < 15; y++ {
		for x := 0; x < 20; x++ {
			img.Set(x, y, color.RGBA{G: 128, A: 255})
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func jsonResponse(status int, v any) *http.Response {
	b, _ := json.Marshal(v)
	return &http.Response{
		StatusCode: status,
		Header:     http.Header{"Content-Type": []string{"application/json"}},
		Body:       io.NopCloser(bytes.NewReader(b)),
	}
}

func TestFullPipelineIntegration(t *testing.T) {
	if os.Getenv("GALLERY_INTEGRATION") == "" {
		t.Skip("skipping integration test; set GALLERY_INTEGRATION=1")
	}

	temp := t.TempDir()
	env := config.Env{
		AppURL:                 "http://localhost",
		NodeEnv:                "test",
		DatabaseURL:            os.Getenv("DATABASE_URL"),
		RedisURL:               os.Getenv("REDIS_URL"),
		SessionSecret:          strings.Repeat("x", 32),
		BootstrapSecret:        strings.Repeat("b", 24),
		TokenEncryptionKey:     strings.Repeat("1", 64),
		LineChannelSecret:      "fixture",
		LineChannelAccessToken: "test",
		GoogleClientID:         "client",
		GoogleClientSecret:     "secret",
		GoogleRedirectURI:      "http://localhost/api/v1/google/callback",
		StagingPath:            filepath.Join(temp, "stage"),
		ThumbnailPath:          filepath.Join(temp, "thumb"),
		MaxImageSizeMB:         50,
		MaxVideoSizeMB:         200,
		MinFreeMB:              1,
		StagingRetentionHours:  24,
		FailedRetentionDays:    7,
		ThumbnailRetentionDays: 30,
	}

	ctx := context.Background()
	database, err := db.Connect(ctx, env)
	if err != nil {
		t.Fatalf("db.Connect: %v", err)
	}
	defer database.Close()
	if err := database.Migrate(ctx); err != nil {
		t.Fatalf("db.Migrate: %v", err)
	}
	// Clean tables for repeatable test run on same container
	_, _ = database.Pool.Exec(ctx, `TRUNCATE "UploadAttempt", "Image", "LineGroup", "WebhookEvent", "OutboxEvent", "AuditLog", "GoogleConnection", "Owner" CASCADE`)

	rOpts, err := redis.ParseURL(env.RedisURL)
	if err != nil {
		t.Fatalf("redis.ParseURL: %v", err)
	}
	rdb := redis.NewClient(rOpts)
	defer rdb.Close()
	_ = rdb.FlushDB(ctx).Err()

	store := media.NewStore(env)
	if err := store.InitDirs(); err != nil {
		t.Fatalf("store.InitDirs: %v", err)
	}

	srv := api.NewServer(env, database, rdb, store)
	handler := srv.Handler()
	proc := &worker.Processor{DB: database, Store: store, Redis: rdb}

	doReq := func(method, path string, headers map[string]string, body any) *httptest.ResponseRecorder {
		var rdr io.Reader
		switch v := body.(type) {
		case nil:
		case string:
			rdr = strings.NewReader(v)
		case []byte:
			rdr = bytes.NewReader(v)
		default:
			b, _ := json.Marshal(v)
			rdr = bytes.NewReader(b)
		}
		req := httptest.NewRequest(method, path, rdr)
		for k, val := range headers {
			req.Header.Set(k, val)
		}
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		return rec
	}

	origin := map[string]string{
		"Origin":            "http://localhost",
		"X-Gallery-Request": "1",
	}

	if res := doReq("GET", "/api/v1/images", nil, nil); res.Code != 401 {
		t.Fatalf("expected 401 unauthenticated, got %d", res.Code)
	}

	setupRes := doReq("POST", "/api/v1/auth/setup", origin, map[string]string{
		"email":     "owner@example.org",
		"password":  "long-fixture-password",
		"bootstrap": strings.Repeat("b", 24),
	})
	if setupRes.Code != 200 {
		t.Fatalf("setup failed (%d): %s", setupRes.Code, setupRes.Body.String())
	}
	var sessionCookie string
	for _, c := range setupRes.Result().Cookies() {
		if c.Name == "session" {
			sessionCookie = c.Value
		}
	}
	if sessionCookie == "" {
		t.Fatalf("missing session cookie on setup")
	}
	headers := map[string]string{
		"Origin":            "http://localhost",
		"X-Gallery-Request": "1",
		"Cookie":            "session=" + sessionCookie,
	}

	if res := doReq("POST", "/api/v1/auth/login", origin, map[string]string{
		"email":    "owner@example.org",
		"password": "wrong",
	}); res.Code != 401 {
		t.Fatalf("expected 401 on wrong password, got %d", res.Code)
	}

	mkEvent := func(evType, id, kind, source string) map[string]any {
		if kind == "" {
			kind = "image"
		}
		if source == "" {
			source = "group"
		}
		return map[string]any{
			"type":           evType,
			"webhookEventId": id,
			"timestamp":      time.Now().UnixMilli(),
			"source":         map[string]any{"type": source, "groupId": "group-a"},
			"message":        map[string]any{"type": kind, "id": "message-a"},
		}
	}

	sendWebhook := func(events []map[string]any, valid bool) *httptest.ResponseRecorder {
		raw, _ := json.Marshal(map[string]any{
			"destination": "channel",
			"events":      events,
		})
		sig := "wrong"
		if valid {
			mac := hmac.New(sha256.New, []byte("fixture"))
			mac.Write(raw)
			sig = base64.StdEncoding.EncodeToString(mac.Sum(nil))
		}
		return doReq("POST", "/api/webhooks/line", map[string]string{
			"Content-Type":     "application/json",
			"X-Line-Signature": sig,
		}, raw)
	}

	if res := sendWebhook([]map[string]any{}, false); res.Code != 403 {
		t.Fatalf("expected 403 on bad signature, got %d", res.Code)
	}
	if res := sendWebhook([]map[string]any{
		mkEvent("join", "j", "image", "group"),
		mkEvent("message", "disabled", "image", "group"),
	}, true); res.Code != 200 {
		t.Fatalf("expected 200 on join webhook, got %d: %s", res.Code, res.Body.String())
	}

	var imgCount int
	_ = database.Pool.QueryRow(ctx, `SELECT COUNT(*) FROM "Image"`).Scan(&imgCount)
	if imgCount != 0 {
		t.Fatalf("expected 0 images while group disabled, got %d", imgCount)
	}

	var groupUUID, lineGroupID string
	if err := database.Pool.QueryRow(ctx, `SELECT "id", "lineGroupId" FROM "LineGroup" LIMIT 1`).Scan(&groupUUID, &lineGroupID); err != nil {
		t.Fatalf("expected LineGroup row: %v", err)
	}

	if res := doReq("PATCH", "/api/v1/groups/"+groupUUID, headers, map[string]bool{"enabled": true}); res.Code != 200 {
		t.Fatalf("enable group failed (%d): %s", res.Code, res.Body.String())
	}

	sendWebhook([]map[string]any{
		mkEvent("message", "video", "video", "group"),
		mkEvent("message", "direct", "image", "user"),
	}, true)
	_ = database.Pool.QueryRow(ctx, `SELECT COUNT(*) FROM "Image"`).Scan(&imgCount)
	if imgCount != 0 {
		t.Fatalf("expected 0 images for video (disabled) and direct user message, got %d", imgCount)
	}

	sendWebhook([]map[string]any{
		mkEvent("message", "img", "image", "group"),
		mkEvent("message", "img", "image", "group"),
		mkEvent("message", "other-event", "image", "group"),
	}, true)
	_ = database.Pool.QueryRow(ctx, `SELECT COUNT(*) FROM "Image"`).Scan(&imgCount)
	if imgCount != 1 {
		t.Fatalf("expected 1 deduplicated image, got %d", imgCount)
	}

	pngBytes := makeTestPNG(t)
	var (
		mu                sync.Mutex
		albums            int
		creates           int
		mode              = "success"
		matched           string
		groupName         = "Family"
		patchedAlbumTitle string
	)

	origTransport := http.DefaultTransport
	defer func() { http.DefaultTransport = origTransport }()
	http.DefaultTransport = roundTripFunc(func(req *http.Request) (*http.Response, error) {
		u := req.URL.String()
		var bodyBytes []byte
		if req.Body != nil {
			bodyBytes, _ = io.ReadAll(req.Body)
		}
		bodyStr := string(bodyBytes)

		mu.Lock()
		curMode := mode
		curGroupName := groupName
		mu.Unlock()

		if strings.Contains(u, "oauth2.googleapis.com") && curMode == "invalid-grant" {
			return jsonResponse(400, map[string]string{"error": "invalid_grant"}), nil
		}
		if strings.Contains(u, "oauth2.googleapis.com") && strings.Contains(bodyStr, "authorization_code") {
			return jsonResponse(200, map[string]string{
				"refresh_token": "refresh",
				"scope":         strings.Join(google.Scopes, " "),
				"access_token":  "access",
			}), nil
		}
		if strings.HasSuffix(u, "albums?pageSize=1") {
			return jsonResponse(200, map[string]any{}), nil
		}
		if strings.Contains(u, "oauth2.googleapis.com") {
			return jsonResponse(200, map[string]string{"access_token": "access"}), nil
		}
		if strings.Contains(u, "photoslibrary.googleapis.com/v1/mediaItems/media-1") {
			return jsonResponse(200, map[string]string{
				"id":      "media-1",
				"baseUrl": "https://lh3.googleusercontent.com/fixture-media-1",
			}), nil
		}
		if strings.HasPrefix(u, "https://lh3.googleusercontent.com/fixture-media-1=w") {
			return &http.Response{
				StatusCode: 200,
				Header:     http.Header{"Content-Type": []string{"image/png"}},
				Body:       io.NopCloser(bytes.NewReader(pngBytes)),
			}, nil
		}
		if strings.HasPrefix(u, "https://lh3.googleusercontent.com/fixture-media-1=dv") {
			rng := req.Header.Get("Range")
			if rng != "" {
				return &http.Response{
					StatusCode: 206,
					Header: http.Header{
						"Content-Type":   []string{"video/mp4"},
						"Content-Range":  []string{"bytes 0-6/100"},
						"Accept-Ranges":  []string{"bytes"},
						"Content-Length": []string{"7"},
					},
					Body: io.NopCloser(strings.NewReader("partial")),
				}, nil
			}
			return &http.Response{
				StatusCode: 200,
				Header:     http.Header{"Content-Type": []string{"video/mp4"}},
				Body:       io.NopCloser(strings.NewReader("full-video")),
			}, nil
		}
		if strings.Contains(u, "api-data.line.me") && curMode == "throttle" {
			return &http.Response{
				StatusCode: 429,
				Header:     http.Header{"Retry-After": []string{"60"}},
				Body:       io.NopCloser(strings.NewReader("slow")),
			}, nil
		}
		if strings.Contains(u, "api-data.line.me") && curMode == "invalid" {
			return &http.Response{
				StatusCode: 200,
				Body:       io.NopCloser(strings.NewReader("not a photo")),
			}, nil
		}
		if strings.Contains(u, "api-data.line.me") {
			return &http.Response{
				StatusCode: 200,
				Body:       io.NopCloser(bytes.NewReader(pngBytes)),
			}, nil
		}
		if strings.HasSuffix(u, "/summary") {
			return jsonResponse(200, map[string]string{"groupName": curGroupName}), nil
		}
		if strings.HasSuffix(u, "/albums/album?updateMask=title") && req.Method == http.MethodPatch {
			var p struct {
				Title string `json:"title"`
			}
			_ = json.Unmarshal(bodyBytes, &p)
			mu.Lock()
			patchedAlbumTitle = p.Title
			mu.Unlock()
			return jsonResponse(200, map[string]string{"id": "album", "title": p.Title}), nil
		}
		if strings.HasSuffix(u, "/albums") {
			mu.Lock()
			albums++
			mu.Unlock()
			return jsonResponse(200, map[string]string{"id": "album"}), nil
		}
		if strings.HasSuffix(u, "/albums/album") {
			return jsonResponse(200, map[string]string{"id": "album", "mediaItemsCount": "1"}), nil
		}
		if strings.HasSuffix(u, "/uploads") {
			return &http.Response{
				StatusCode: 200,
				Body:       io.NopCloser(strings.NewReader("upload")),
			}, nil
		}
		if strings.HasSuffix(u, ":batchCreate") {
			var b struct {
				NewMediaItems []struct {
					SimpleMediaItem struct {
						FileName string `json:"fileName"`
					} `json:"simpleMediaItem"`
				} `json:"newMediaItems"`
			}
			_ = json.Unmarshal(bodyBytes, &b)
			mu.Lock()
			creates++
			if len(b.NewMediaItems) > 0 {
				matched = b.NewMediaItems[0].SimpleMediaItem.FileName
			}
			mu.Unlock()
			if curMode == "ambiguous" {
				return nil, io.ErrUnexpectedEOF
			}
			if curMode == "partial" {
				return jsonResponse(200, map[string]any{
					"newMediaItemResults": []map[string]any{
						{"status": map[string]any{"code": 7}},
					},
				}), nil
			}
			return jsonResponse(200, map[string]any{
				"newMediaItemResults": []map[string]any{
					{"status": map[string]any{}, "mediaItem": map[string]string{"id": "media-1"}},
				},
			}), nil
		}
		if strings.HasSuffix(u, ":search") {
			mu.Lock()
			mFile := matched
			mu.Unlock()
			items := []map[string]string{}
			if curMode == "found" {
				items = append(items, map[string]string{"id": "reconciled", "filename": mFile})
			}
			return jsonResponse(200, map[string]any{"mediaItems": items}), nil
		}
		t.Fatalf("unexpected URL in mock transport: %s", u)
		return nil, nil
	})

	consentRes := doReq("GET", "/api/v1/google/connect", headers, nil)
	loc, _ := url.Parse(consentRes.Header().Get("Location"))
	oauthState := loc.Query().Get("state")
	cbURL := "/api/v1/google/callback?code=code&state=" + oauthState
	if res := doReq("GET", cbURL, headers, nil); res.Code != 302 {
		t.Fatalf("expected 302 on OAuth callback, got %d: %s", res.Code, res.Body.String())
	}
	if res := doReq("GET", cbURL, headers, nil); res.Code != 403 {
		t.Fatalf("expected 403 on replayed OAuth state, got %d", res.Code)
	}

	runNextOutbox := func() {
		var outboxID string
		if err := database.Pool.QueryRow(ctx, `SELECT id FROM "OutboxEvent" ORDER BY "createdAt" ASC LIMIT 1`).Scan(&outboxID); err != nil {
			t.Fatalf("expected outbox event: %v", err)
		}
		if err := proc.ProcessEvent(ctx, outboxID); err != nil {
			t.Fatalf("ProcessEvent(%s) failed: %v", outboxID, err)
		}
	}

	runNextOutbox() // GROUP_SUMMARY
	runNextOutbox() // PROCESS (download & stage)

	var stagedID, stagedMime string
	var stagedWidth int
	var stagedPath *string
	if err := database.Pool.QueryRow(
		ctx,
		`SELECT "id", "mimeType", "width", "stagingPath" FROM "Image" LIMIT 1`,
	).Scan(&stagedID, &stagedMime, &stagedWidth, &stagedPath); err != nil {
		t.Fatalf("load staged image: %v", err)
	}
	if stagedMime != "image/png" || stagedWidth != 20 {
		t.Fatalf("expected image/png 20px, got %s %d", stagedMime, stagedWidth)
	}

	gRow := worker.LineGroupRow{ID: groupUUID, LineGroupID: lineGroupID}
	var wg sync.WaitGroup
	wg.Add(2)
	for range 2 {
		go func() {
			defer wg.Done()
			_, _ = proc.ResolveAlbum(ctx, gRow, "access")
		}()
	}
	wg.Wait()
	if albums != 1 {
		t.Fatalf("expected exactly 1 album creation under concurrency, got %d", albums)
	}

	runNextOutbox() // UPLOAD

	groupName = "Family 2026"
	refreshRes := doReq("POST", "/api/v1/groups/"+groupUUID+"/refresh", headers, nil)
	if refreshRes.Code != 200 {
		t.Fatalf("refresh group failed (%d): %s", refreshRes.Code, refreshRes.Body.String())
	}
	if patchedAlbumTitle != "LINE - Family 2026" {
		t.Fatalf("expected patched album title 'LINE - Family 2026', got %q", patchedAlbumTitle)
	}

	// Legacy scope fallback test
	_, _ = database.Pool.Exec(
		ctx,
		`UPDATE "GoogleConnection" SET "scopes" = 'https://www.googleapis.com/auth/photoslibrary.appendonly https://www.googleapis.com/auth/photoslibrary.readonly.appcreateddata' WHERE id = 1`,
	)
	groupName = "Family Legacy Scope"
	legacyRes := doReq("POST", "/api/v1/groups/"+groupUUID+"/refresh", headers, nil)
	if legacyRes.Code != 200 || !strings.Contains(legacyRes.Body.String(), "Reconnect Google Photos") {
		t.Fatalf("unexpected legacy scope refresh response: %s", legacyRes.Body.String())
	}
	_, _ = database.Pool.Exec(ctx, `UPDATE "GoogleConnection" SET "scopes" = $1 WHERE id = 1`, strings.Join(google.Scopes, " "))

	syncedList := doReq("GET", "/api/v1/images?status=SYNCED&group=group-a", headers, nil)
	if syncedList.Code != 200 || !strings.Contains(syncedList.Body.String(), `"total":1`) {
		t.Fatalf("expected 1 synced image, got %s", syncedList.Body.String())
	}

	thumbRes := doReq("GET", "/api/v1/images/"+stagedID+"/thumbnail", headers, nil)
	if thumbRes.Code != 200 {
		t.Fatalf("expected 200 thumbnail, got %d", thumbRes.Code)
	}

	for _, st := range []string{"partial", "ambiguous"} {
		mode = st
		e := mkEvent("message", st, "image", "group")
		e["message"] = map[string]any{"type": "image", "id": st}
		sendWebhook([]map[string]any{e}, true)
		runNextOutbox()
		runNextOutbox()

		var rowID, rowStatus string
		if err := database.Pool.QueryRow(ctx, `SELECT "id", "uploadStatus"::text FROM "Image" WHERE "lineMessageId" = $1`, st).Scan(&rowID, &rowStatus); err != nil {
			t.Fatalf("query image %s: %v", st, err)
		}
		want := "NEEDS_REVIEW"
		if st == "partial" {
			want = "FAILED"
		}
		if rowStatus != want {
			t.Fatalf("expected %s for %s, got %s", want, st, rowStatus)
		}
		if st == "ambiguous" {
			mode = "invalid-grant"
			database.ClearAccessCache()
			doReq("POST", "/api/v1/jobs/"+rowID+"/retry", headers, nil)
			runNextOutbox()
			_ = database.Pool.QueryRow(ctx, `SELECT "uploadStatus"::text FROM "Image" WHERE id = $1`, rowID).Scan(&rowStatus)
			if rowStatus != "NEEDS_REVIEW" {
				t.Fatalf("expected NEEDS_REVIEW to persist on invalid-grant, got %s", rowStatus)
			}
			mode = "found"
			doReq("POST", "/api/v1/jobs/"+rowID+"/retry", headers, nil)
			runNextOutbox()
			var mediaID *string
			_ = database.Pool.QueryRow(ctx, `SELECT "googleMediaItemId" FROM "Image" WHERE id = $1`, rowID).Scan(&mediaID)
			if mediaID == nil || *mediaID != "reconciled" {
				t.Fatalf("expected reconciled media ID, got %v", mediaID)
			}
		}
	}
	if creates != 3 {
		t.Fatalf("expected 3 batchCreate calls (no duplicate upload on reconcile), got %d", creates)
	}

	if err := proc.Cleanup(ctx, time.Now().Add(31*24*time.Hour)); err != nil {
		t.Fatalf("Cleanup failed: %v", err)
	}
	if _, err := os.Stat(*stagedPath); !os.IsNotExist(err) {
		t.Fatalf("expected synced staged file to be cleaned up")
	}

	remoteThumb := doReq("GET", "/api/v1/images/"+stagedID+"/thumbnail?size=320", headers, nil)
	if remoteThumb.Code != 200 {
		t.Fatalf("expected 200 on remote thumbnail fetch, got %d", remoteThumb.Code)
	}

	// Video setting + unsupported video + Range streaming
	if res := doReq("PATCH", "/api/v1/settings", headers, map[string]any{"collectVideos": true}); res.Code != 200 {
		t.Fatalf("enable collectVideos failed: %d", res.Code)
	}
	mode = "invalid"
	badVid := mkEvent("message", "bad-video", "video", "group")
	badVid["message"] = map[string]any{"type": "video", "id": "bad-video"}
	sendWebhook([]map[string]any{badVid}, true)
	runNextOutbox()
	var vidMediaType, vidStatus, vidErrCode string
	if err := database.Pool.QueryRow(
		ctx,
		`SELECT "mediaType", "uploadStatus"::text, "errorCode" FROM "Image" WHERE "lineMessageId" = 'bad-video'`,
	).Scan(&vidMediaType, &vidStatus, &vidErrCode); err != nil {
		t.Fatalf("query bad-video: %v", err)
	}
	if vidMediaType != "VIDEO" || vidStatus != "UNRECOVERABLE" || vidErrCode != "UNSUPPORTED_VIDEO" {
		t.Fatalf("unexpected bad-video state: %s %s %s", vidMediaType, vidStatus, vidErrCode)
	}

	_, _ = database.Pool.Exec(ctx, `UPDATE "Image" SET "mediaType" = 'VIDEO', "mimeType" = 'video/mp4' WHERE id = $1`, stagedID)
	rangeRes := doReq("GET", "/api/v1/images/"+stagedID+"/content", map[string]string{
		"Cookie": "session=" + sessionCookie,
		"Range":  "bytes=0-6",
	}, nil)
	if rangeRes.Code != 206 || rangeRes.Header().Get("Content-Range") != "bytes 0-6/100" || rangeRes.Body.String() != "partial" {
		t.Fatalf("unexpected Range response: code=%d cr=%s body=%q", rangeRes.Code, rangeRes.Header().Get("Content-Range"), rangeRes.Body.String())
	}
	t.Run("discard retries failed unlink", func(t *testing.T) {
		path, err := store.PathFor(stagedID, 0)
		if err != nil {
			t.Fatal(err)
		}
		// A nonempty directory reliably produces an unlink error, even as root.
		if err := os.Mkdir(path, 0700); err != nil {
			t.Fatal(err)
		}
		child := filepath.Join(path, "fixture")
		if err := os.WriteFile(child, nil, 0600); err != nil {
			t.Fatal(err)
		}
		const event = "discard-fixture"
		if _, err := database.Pool.Exec(ctx, `INSERT INTO "OutboxEvent" (id,"eventType","aggregateId") VALUES ($1,'DISCARD',$2)`, event, stagedID); err != nil {
			t.Fatal(err)
		}
		if err := proc.ProcessEvent(ctx, event); err == nil {
			t.Fatal("acknowledged failed unlink")
		}
		var exists bool
		if err := database.Pool.QueryRow(ctx, `SELECT EXISTS(SELECT FROM "OutboxEvent" WHERE id=$1)`, event).Scan(&exists); err != nil || !exists {
			t.Fatalf("lost pending discard: %v", err)
		}
		if err := os.Remove(child); err != nil {
			t.Fatal(err)
		}
		if err := proc.ProcessEvent(ctx, event); err != nil {
			t.Fatal(err)
		}
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("discard retry did not remove path: %v", err)
		}
	})
	t.Run("heartbeat continues during blocked claim", func(t *testing.T) {
		tx, err := database.Pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		if _, err := tx.Exec(ctx, `LOCK TABLE "OutboxEvent" IN ACCESS EXCLUSIVE MODE`); err != nil {
			t.Fatal(err)
		}
		if err := rdb.Del(ctx, "worker:heartbeat").Err(); err != nil {
			t.Fatal(err)
		}
		child, cancel := context.WithCancel(ctx)
		done := make(chan error, 1)
		go func() { done <- proc.RunLoop(child) }()
		defer func() {
			cancel()
			select {
			case <-done:
			case <-time.After(4 * time.Second):
				t.Error("worker did not stop")
			}
		}()
		first := ""
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			v, err := rdb.Get(ctx, "worker:heartbeat").Result()
			if err == nil && v != "" {
				if first != "" && first != v {
					var free bool
					if err := tx.QueryRow(ctx, "SELECT pg_try_advisory_xact_lock(72707370)").Scan(&free); err != nil || free {
						t.Fatalf("active worker did not reserve the global slot: %v", err)
					}
					return
				}
				first = v
			}
			time.Sleep(50 * time.Millisecond)
		}
		t.Fatal("no heartbeat renewal while outbox claim blocked")
	})

}
