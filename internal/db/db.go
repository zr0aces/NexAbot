package db

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/sync/singleflight"

	"rivosnap/internal/config"
	"rivosnap/internal/crypto"
	"rivosnap/internal/google"
	"rivosnap/internal/model"
)

type DB struct {
	Pool *pgxpool.Pool
	Env  config.Env

	refresh     singleflight.Group
	mu          sync.Mutex
	cachedToken string
	cachedEnc   string
	expiresAt   time.Time
}

func Connect(ctx context.Context, env config.Env) (*DB, error) {
	cfg, err := pgxpool.ParseConfig(env.DatabaseURL)
	if err != nil {
		return nil, err
	}
	// Pin UTC so timestamp(3) columns compare correctly regardless of the server's TZ.
	cfg.ConnConfig.RuntimeParams["timezone"] = "UTC"
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, err
	}
	var pingErr error
	deadline := time.Now().Add(15 * time.Second)
	for {
		pingErr = pool.Ping(ctx)
		if pingErr == nil {
			break
		}
		if time.Now().After(deadline) || ctx.Err() != nil {
			pool.Close()
			return nil, pingErr
		}
		time.Sleep(500 * time.Millisecond)
	}
	return &DB{Pool: pool, Env: env}, nil
}

func (d *DB) Close() {
	if d.Pool != nil {
		d.Pool.Close()
	}
}

func (d *DB) ClearAccessCache() {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.cachedToken = ""
	d.cachedEnc = ""
	d.expiresAt = time.Time{}
}

func (d *DB) Access(ctx context.Context, forceRefresh bool) (string, error) {
	var enc *string
	err := d.Pool.QueryRow(ctx, `SELECT "encryptedRefreshToken" FROM "GoogleConnection" WHERE id = 1`).Scan(&enc)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && (enc == nil || *enc == "")) {
		d.ClearAccessCache()
		return "", model.NewFault("GOOGLE_AUTH", "Connect Google Photos, then retry.", false, 0)
	}
	if err != nil {
		return "", err
	}
	encrypted := *enc

	d.mu.Lock()
	if !forceRefresh && d.cachedToken != "" && d.cachedEnc == encrypted && time.Now().Before(d.expiresAt) {
		tok := d.cachedToken
		d.mu.Unlock()
		return tok, nil
	}
	d.mu.Unlock()

	result := d.refresh.DoChan(encrypted, func() (any, error) {
		// One departing HTTP caller must not cancel a refresh shared by others.
		refreshCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 90*time.Second)
		defer cancel()
		return d.refreshAccess(refreshCtx, encrypted)
	})
	select {
	case <-ctx.Done():
		return "", ctx.Err()
	case r := <-result:
		if r.Err != nil {
			return "", r.Err
		}
		return r.Val.(string), nil
	}
}

func (d *DB) refreshAccess(ctx context.Context, encrypted string) (string, error) {
	refreshTok, err := crypto.Open(encrypted, d.Env.TokenEncryptionKey)
	if err != nil {
		return "", model.NewFault("GOOGLE_AUTH", "Connect Google Photos, then retry.", false, 0)
	}
	res, err := google.Refresh(ctx, d.Env, refreshTok)
	if err != nil {
		d.mu.Lock()
		if d.cachedEnc == encrypted {
			d.cachedToken = ""
		}
		d.mu.Unlock()
		var f *model.Fault
		if errors.As(err, &f) {
			status := "REAUTHORIZE"
			if f.Transient {
				status = "DEGRADED"
			}
			_, _ = d.Pool.Exec(
				ctx,
				`UPDATE "GoogleConnection" SET "lastError" = $1, "status" = $2 WHERE id = 1 AND "encryptedRefreshToken" = $3`,
				f.Message,
				status,
				encrypted,
			)
		}
		return "", err
	}
	d.mu.Lock()
	d.cachedToken = res.AccessToken
	d.cachedEnc = encrypted
	d.expiresAt = time.Now().Add(45 * time.Minute)
	d.mu.Unlock()
	return res.AccessToken, nil
}

type LineCreds struct {
	Token       string
	Secret      string
	Destination string
}

func (d *DB) LineCredentials(ctx context.Context) (LineCreds, error) {
	var raw []byte
	err := d.Pool.QueryRow(ctx, `SELECT settings FROM "Owner" WHERE id = 1`).Scan(&raw)
	if err != nil && !errors.Is(err, pgx.ErrNoRows) {
		return LineCreds{}, err
	}
	var m map[string]any
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &m)
	}
	token := d.Env.LineChannelAccessToken
	if encTok, ok := m["lineToken"].(string); ok && encTok != "" {
		if plain, err := crypto.Open(encTok, d.Env.TokenEncryptionKey); err == nil {
			token = plain
		}
	}
	secret := d.Env.LineChannelSecret
	if encSec, ok := m["lineSecret"].(string); ok && encSec != "" {
		if plain, err := crypto.Open(encSec, d.Env.TokenEncryptionKey); err == nil {
			secret = plain
		}
	}
	dest, _ := m["destination"].(string)
	return LineCreds{
		Token:       token,
		Secret:      secret,
		Destination: dest,
	}, nil
}

func (d *DB) OwnerSettingsRaw(ctx context.Context) ([]byte, error) {
	var raw []byte
	err := d.Pool.QueryRow(ctx, `SELECT settings FROM "Owner" WHERE id = 1`).Scan(&raw)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	return raw, err
}

func (d *DB) OwnerPolicy(ctx context.Context) (config.Policy, error) {
	raw, err := d.OwnerSettingsRaw(ctx)
	if err != nil {
		return d.Env.Settings(nil), err
	}
	return d.Env.Settings(raw), nil
}

func (d *DB) Audit(ctx context.Context, id, action, targetType, targetID string) error {
	_, err := d.Pool.Exec(
		ctx,
		`INSERT INTO "AuditLog" ("id", "action", "targetType", "targetId", "metadata", "createdAt") VALUES ($1, $2, $3, $4, '{}'::jsonb, NOW())`,
		id, action, targetType, targetID,
	)
	return err
}
