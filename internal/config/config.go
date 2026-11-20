package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
)

var hex64 = regexp.MustCompile(`^[a-fA-F0-9]{64}$`)

type Env struct {
	AppURL                 string
	NodeEnv                string
	DatabaseURL            string
	RedisURL               string
	SessionSecret          string
	BootstrapSecret        string
	TokenEncryptionKey     string
	LineChannelAccessToken string
	LineChannelSecret      string
	GoogleClientID         string
	GoogleClientSecret     string
	GoogleRedirectURI      string
	StagingPath            string
	ThumbnailPath          string
	MaxImageSizeMB         int
	MaxVideoSizeMB         int
	MinFreeMB              int
	StagingRetentionHours  int
	FailedRetentionDays    int
	ThumbnailRetentionDays int
}

type Policy struct {
	StagingHours  int  `json:"stagingHours"`
	FailedDays    int  `json:"failedDays"`
	ThumbnailDays int  `json:"thumbnailDays"`
	CollectVideos bool `json:"collectVideos"`
}

func envStr(key, def string) string {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return def
	}
	return v
}

func envInt(key string, def, min, max int) (int, error) {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return def, nil
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		return 0, fmt.Errorf("%s must be an integer", key)
	}
	if n < min || (max > 0 && n > max) {
		return 0, fmt.Errorf("%s out of range", key)
	}
	return n, nil
}

func parseOrigin(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return "", errors.New("invalid URL")
	}
	return u.Scheme + "://" + u.Host, nil
}

func Load() (Env, error) {
	var e Env
	origin, err := parseOrigin(os.Getenv("APP_URL"))
	if err != nil {
		return e, fmt.Errorf("APP_URL: %w", err)
	}
	e.AppURL = origin
	e.NodeEnv = envStr("NODE_ENV", "development")
	if e.NodeEnv == "production" && !strings.HasPrefix(e.AppURL, "https://") {
		return e, errors.New("HTTPS required")
	}
	e.DatabaseURL = strings.TrimSpace(os.Getenv("DATABASE_URL"))
	e.RedisURL = strings.TrimSpace(os.Getenv("REDIS_URL"))
	if u, err := url.Parse(e.RedisURL); err != nil || u.Scheme == "" || u.Host == "" {
		return e, errors.New("REDIS_URL: invalid URL")
	}
	e.SessionSecret = os.Getenv("SESSION_SECRET")
	if len(e.SessionSecret) < 32 {
		return e, errors.New("SESSION_SECRET: must be at least 32 characters")
	}
	e.BootstrapSecret = os.Getenv("BOOTSTRAP_SECRET")
	if len(e.BootstrapSecret) < 24 {
		return e, errors.New("BOOTSTRAP_SECRET: must be at least 24 characters")
	}
	e.TokenEncryptionKey = os.Getenv("TOKEN_ENCRYPTION_KEY")
	if !hex64.MatchString(e.TokenEncryptionKey) {
		return e, errors.New("TOKEN_ENCRYPTION_KEY: must match /^[a-fA-F0-9]{64}$/")
	}
	e.LineChannelAccessToken = os.Getenv("LINE_CHANNEL_ACCESS_TOKEN")
	e.LineChannelSecret = os.Getenv("LINE_CHANNEL_SECRET")
	e.GoogleClientID = os.Getenv("GOOGLE_CLIENT_ID")
	e.GoogleClientSecret = os.Getenv("GOOGLE_CLIENT_SECRET")
	e.GoogleRedirectURI = strings.TrimSpace(os.Getenv("GOOGLE_REDIRECT_URI"))
	if u, err := url.Parse(e.GoogleRedirectURI); err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return e, errors.New("GOOGLE_REDIRECT_URI: invalid URL")
	}
	e.StagingPath = envStr("STAGING_PATH", "/data/staging")
	e.ThumbnailPath = envStr("THUMBNAIL_PATH", "/data/thumbnails")
	if e.MaxImageSizeMB, err = envInt("MAX_IMAGE_SIZE_MB", 50, 1, 200); err != nil {
		return e, err
	}
	if e.MaxVideoSizeMB, err = envInt("MAX_VIDEO_SIZE_MB", 200, 1, 1000); err != nil {
		return e, err
	}
	if e.MinFreeMB, err = envInt("MIN_FREE_MB", 1024, 1, 0); err != nil {
		return e, err
	}
	if e.StagingRetentionHours, err = envInt("STAGING_RETENTION_HOURS", 24, 1, 720); err != nil {
		return e, err
	}
	if e.FailedRetentionDays, err = envInt("FAILED_RETENTION_DAYS", 7, 1, 90); err != nil {
		return e, err
	}
	if e.ThumbnailRetentionDays, err = envInt("THUMBNAIL_RETENTION_DAYS", 30, 1, 365); err != nil {
		return e, err
	}
	return e, nil
}

func (e Env) Settings(rawJSON []byte) Policy {
	p := Policy{
		StagingHours:  e.StagingRetentionHours,
		FailedDays:    e.FailedRetentionDays,
		ThumbnailDays: e.ThumbnailRetentionDays,
		CollectVideos: false,
	}
	if len(rawJSON) > 0 {
		var m map[string]any
		if json.Unmarshal(rawJSON, &m) == nil {
			if v, ok := asInt(m["stagingHours"]); ok && v >= 1 && v <= 720 {
				p.StagingHours = v
			}
			if v, ok := asInt(m["failedDays"]); ok && v >= 1 && v <= 90 {
				p.FailedDays = v
			}
			if v, ok := asInt(m["thumbnailDays"]); ok && v >= 1 && v <= 365 {
				p.ThumbnailDays = v
			}
			if v, ok := m["collectVideos"].(bool); ok {
				p.CollectVideos = v
			}
		}
	}
	return p
}

func asInt(v any) (int, bool) {
	switch n := v.(type) {
	case float64:
		if float64(int(n)) == n {
			return int(n), true
		}
	case int:
		return n, true
	}
	return 0, false
}
