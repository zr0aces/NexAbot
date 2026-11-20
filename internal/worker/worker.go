package worker

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/redis/go-redis/v9"

	"rivosnap/internal/db"
	"rivosnap/internal/google"
	"rivosnap/internal/line"
	"rivosnap/internal/media"
	"rivosnap/internal/model"
)

var definitiveGoogleFaultRe = regexp.MustCompile(`^(GOOGLE_ITEM_|ALBUM_CAPACITY|GOOGLE_STORAGE|GOOGLE_RATE_LIMIT|GOOGLE_AUTH|GOOGLE_400)`)

type Processor struct {
	DB    *db.DB
	Store *media.Store
	Redis *redis.Client
}

type LineGroupRow struct {
	ID               string
	LineGroupID      string
	DisplayName      *string
	GoogleAlbumID    *string
	AlbumCreating    bool
	MembershipStatus string
}

type ImageRow struct {
	ID                string
	LineGroupID       string
	LineMessageID     string
	MediaType         string
	DurationMs        *int
	MimeType          *string
	FileSize          *int
	Width             *int
	Height            *int
	Sha256            *string
	GoogleMediaItemID *string
	ProductURL        *string
	UploadStatus      model.State
	StagingPath       *string
	ThumbnailPath     *string
}

func Filename(i ImageRow) string {
	ext := ""
	if i.MimeType != nil {
		parts := strings.Split(*i.MimeType, "/")
		if len(parts) == 2 {
			sub := parts[1]
			if sub == "quicktime" {
				ext = "mov"
			} else {
				ext = sub
			}
		}
	}
	if ext == "" {
		if i.MediaType == "VIDEO" {
			ext = "mp4"
		} else {
			ext = "jpg"
		}
	}
	return "line-" + i.ID + "." + ext
}

func (p *Processor) ResolveAlbum(ctx context.Context, g LineGroupRow, token string) (string, error) {
	if g.GoogleAlbumID != nil && *g.GoogleAlbumID != "" {
		return *g.GoogleAlbumID, nil
	}
	cmd, err := p.DB.Pool.Exec(
		ctx,
		`UPDATE "LineGroup" SET "albumCreating" = true, "updatedAt" = NOW() WHERE id = $1 AND "albumCreating" = false AND "googleAlbumId" IS NULL`,
		g.ID,
	)
	if err != nil {
		return "", err
	}
	if cmd.RowsAffected() == 0 {
		var freshAlbum *string
		if err := p.DB.Pool.QueryRow(ctx, `SELECT "googleAlbumId" FROM "LineGroup" WHERE id = $1`, g.ID).Scan(&freshAlbum); err != nil {
			return "", err
		}
		if freshAlbum != nil && *freshAlbum != "" {
			return *freshAlbum, nil
		}
		return "", model.NewFault(
			"ALBUM_REVIEW",
			"Unconfirmed album creation. Check Google Photos before repairing the mapping.",
			false,
			0,
		)
	}
	albumID, err := google.CreateAlbum(ctx, google.Title(g.DisplayName, g.LineGroupID), token)
	if err != nil {
		var f *model.Fault
		if errors.As(err, &f) && (!f.Transient || f.Code == "GOOGLE_RATE_LIMIT") {
			_, _ = p.DB.Pool.Exec(ctx, `UPDATE "LineGroup" SET "albumCreating" = false, "updatedAt" = NOW() WHERE id = $1`, g.ID)
			return "", err
		}
		return "", model.NewFault(
			"ALBUM_REVIEW",
			"Album creation was not confirmed. Check the mapping before retrying.",
			false,
			0,
		)
	}
	if _, err := p.DB.Pool.Exec(
		ctx,
		`UPDATE "LineGroup" SET "googleAlbumId" = $1, "albumCreating" = false, "updatedAt" = NOW() WHERE id = $2`,
		albumID, g.ID,
	); err != nil {
		return "", err
	}
	return albumID, nil
}

func (p *Processor) loadImage(ctx context.Context, id string) (ImageRow, error) {
	var row ImageRow
	var statusStr string
	err := p.DB.Pool.QueryRow(
		ctx,
		`SELECT "id", "lineGroupId", "lineMessageId", "mediaType", "durationMs", "mimeType", "fileSize", "width", "height", "sha256", "googleMediaItemId", "productUrl", "uploadStatus"::text, "stagingPath", "thumbnailPath"
		 FROM "Image" WHERE id = $1`,
		id,
	).Scan(
		&row.ID, &row.LineGroupID, &row.LineMessageID, &row.MediaType, &row.DurationMs,
		&row.MimeType, &row.FileSize, &row.Width, &row.Height, &row.Sha256,
		&row.GoogleMediaItemID, &row.ProductURL, &statusStr, &row.StagingPath, &row.ThumbnailPath,
	)
	row.UploadStatus = model.State(statusStr)
	return row, err
}

func (p *Processor) loadGroupByLineID(ctx context.Context, lineGroupID string) (LineGroupRow, error) {
	var g LineGroupRow
	err := p.DB.Pool.QueryRow(
		ctx,
		`SELECT "id", "lineGroupId", "displayName", "googleAlbumId", "albumCreating", "membershipStatus"
		 FROM "LineGroup" WHERE "lineGroupId" = $1`,
		lineGroupID,
	).Scan(&g.ID, &g.LineGroupID, &g.DisplayName, &g.GoogleAlbumID, &g.AlbumCreating, &g.MembershipStatus)
	return g, err
}

func (p *Processor) ProcessEvent(ctx context.Context, outboxID string) error {
	var eventType, aggregateID string
	err := p.DB.Pool.QueryRow(
		ctx,
		`SELECT "eventType", "aggregateId" FROM "OutboxEvent" WHERE id = $1`,
		outboxID,
	).Scan(&eventType, &aggregateID)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	deleteOutbox := func() error {
		_, err := p.DB.Pool.Exec(ctx, `DELETE FROM "OutboxEvent" WHERE id = $1`, outboxID)
		return err
	}

	if eventType == "DISCARD" {
		row, err := p.loadImage(ctx, aggregateID)
		if err != nil {
			return err
		}
		if row.StagingPath == nil || *row.StagingPath == "" {
			if err := p.removeOriginal(row.ID); err != nil {
				return err
			}
		}
		return deleteOutbox()
	}

	if eventType == "GROUP_SUMMARY" {
		creds, err := p.DB.LineCredentials(ctx)
		if err == nil && creds.Token != "" {
			resp, err := line.Call(ctx, "group/"+aggregateID+"/summary", creds.Token, false, 90*time.Second)
			if err == nil {
				var info struct {
					GroupName string `json:"groupName"`
				}
				if json.NewDecoder(resp.Body).Decode(&info) == nil && info.GroupName != "" {
					runes := []rune(info.GroupName)
					if len(runes) > 500 {
						runes = runes[:500]
					}
					_, _ = p.DB.Pool.Exec(
						ctx,
						`UPDATE "LineGroup" SET "displayName" = $1, "updatedAt" = NOW() WHERE "lineGroupId" = $2`,
						string(runes), aggregateID,
					)
				}
				resp.Body.Close()
			}
		}
		return deleteOutbox()
	}

	i, err := p.loadImage(ctx, aggregateID)
	if err != nil {
		return err
	}
	id := i.ID
	if model.IsTerminal(i.UploadStatus) && !(eventType == "RECONCILE" && i.UploadStatus == model.StateNeedsReview) {
		return deleteOutbox()
	}

	lookupOnly := i.UploadStatus == model.StateCreatingMedia || i.UploadStatus == model.StateNeedsReview
	var count int
	if err := p.DB.Pool.QueryRow(ctx, `SELECT COUNT(*) FROM "UploadAttempt" WHERE "imageId" = $1`, id).Scan(&count); err != nil {
		return err
	}
	n := count + 1
	attemptID := uuid.NewString()
	if _, err := p.DB.Pool.Exec(
		ctx,
		`INSERT INTO "UploadAttempt" ("id", "imageId", "attemptNumber", "status", "startedAt") VALUES ($1, $2, $3, 'ACTIVE', NOW())`,
		attemptID, id, n,
	); err != nil {
		return err
	}

	moveState := func(next model.State) error {
		if err := model.Transition(i.UploadStatus, next, ""); err != nil {
			return err
		}
		cmd, err := p.DB.Pool.Exec(
			ctx,
			`UPDATE "Image" SET "uploadStatus" = $1::"UploadState", "updatedAt" = NOW() WHERE id = $2 AND "uploadStatus" = $3::"UploadState"`,
			string(next), id, string(i.UploadStatus),
		)
		if err != nil {
			return err
		}
		if cmd.RowsAffected() == 0 {
			return errors.New("concurrent state change")
		}
		i.UploadStatus = next
		return nil
	}

	moveStaged := func(info media.MediaInfo) error {
		if err := model.Transition(i.UploadStatus, model.StateStaged, ""); err != nil {
			return err
		}
		fsize := int(info.FileSize)
		cmd, err := p.DB.Pool.Exec(
			ctx,
			`UPDATE "Image"
			 SET "uploadStatus" = 'STAGED'::"UploadState",
			     "mimeType" = $1, "width" = $2, "height" = $3, "durationMs" = $4,
			     "fileSize" = $5, "sha256" = $6, "stagingPath" = $7, "updatedAt" = NOW()
			 WHERE id = $8 AND "uploadStatus" = $9::"UploadState"`,
			info.MimeType, info.Width, info.Height, info.DurationMs,
			fsize, info.Sha256, info.StagingPath, id, string(i.UploadStatus),
		)
		if err != nil {
			return err
		}
		if cmd.RowsAffected() == 0 {
			return errors.New("concurrent state change")
		}
		i.UploadStatus = model.StateStaged
		i.MimeType = &info.MimeType
		i.Width = &info.Width
		i.Height = &info.Height
		i.DurationMs = info.DurationMs
		i.FileSize = &fsize
		i.Sha256 = &info.Sha256
		i.StagingPath = &info.StagingPath
		return nil
	}

	syncMedia := func(m google.MediaItem) error {
		if err := model.Transition(i.UploadStatus, model.StateSynced, m.ID); err != nil {
			return err
		}
		var prodURL *string
		if m.ProductURL != "" {
			prodURL = &m.ProductURL
		}
		cmd, err := p.DB.Pool.Exec(
			ctx,
			`UPDATE "Image"
			 SET "uploadStatus" = 'SYNCED'::"UploadState",
			     "googleMediaItemId" = $1, "productUrl" = $2, "uploadedAt" = NOW(),
			     "lastError" = NULL, "errorCode" = NULL, "updatedAt" = NOW()
			 WHERE id = $3 AND "uploadStatus" = $4::"UploadState"`,
			m.ID, prodURL, id, string(i.UploadStatus),
		)
		if err != nil {
			return err
		}
		if cmd.RowsAffected() == 0 {
			return errors.New("concurrent state change")
		}
		i.UploadStatus = model.StateSynced
		i.GoogleMediaItemID = &m.ID
		i.ProductURL = prodURL
		return nil
	}

	runErr := func() error {
		g, err := p.loadGroupByLineID(ctx, i.LineGroupID)
		if err != nil {
			return err
		}
		if i.UploadStatus == model.StateCreatingMedia || i.UploadStatus == model.StateNeedsReview {
			var m *google.MediaItem
			if g.GoogleAlbumID != nil && *g.GoogleAlbumID != "" {
				tok, err := p.DB.Access(ctx, false)
				if err != nil {
					return err
				}
				m, err = google.Reconcile(ctx, *g.GoogleAlbumID, Filename(i), tok)
				if err != nil {
					return err
				}
			}
			if m == nil {
				return model.NewFault(
					"MEDIA_UNCERTAIN",
					"No unique filename match. Inspect the destination album; retry performs lookup only.",
					false,
					0,
				)
			}
			if err := syncMedia(*m); err != nil {
				return err
			}
		} else {
			if i.UploadStatus == model.StateReceived || i.UploadStatus == model.StateRetryPending {
				next := model.StateDownloadPending
				if i.StagingPath != nil && *i.StagingPath != "" {
					next = model.StateUploadPending
				}
				if err := moveState(next); err != nil {
					return err
				}
			}
			if i.UploadStatus == model.StateDownloadPending {
				if err := moveState(model.StateDownloading); err != nil {
					return err
				}
			}
			if i.UploadStatus == model.StateDownloading {
				path, err := p.Store.PathFor(id, 0)
				if err != nil {
					return err
				}
				mediaKind := "IMAGE"
				if i.MediaType == "VIDEO" {
					mediaKind = "VIDEO"
				}
				var staged media.MediaInfo
				if _, statErr := os.Stat(path); statErr == nil {
					if mediaKind == "VIDEO" {
						staged, err = media.InspectVideo(ctx, path)
					} else {
						staged, err = media.Inspect(path)
					}
					if err != nil {
						return err
					}
					staged.StagingPath = path
				} else {
					pressured, err := p.Store.Pressured(mediaKind == "VIDEO")
					if err != nil {
						return err
					}
					if pressured {
						return model.NewFault("DISK_PRESSURE", "Free staging disk space.", true, 60000)
					}
					creds, err := p.DB.LineCredentials(ctx)
					if err != nil {
						return err
					}
					resp, err := line.Download(ctx, i.LineMessageID, creds.Token)
					if err != nil {
						return err
					}
					defer resp.Body.Close()
					staged, err = p.Store.Stage(ctx, id, resp.Body, mediaKind)
					if err != nil {
						return err
					}
				}
				if err := moveStaged(staged); err != nil {
					return err
				}
				tx, err := p.DB.Pool.Begin(ctx)
				if err != nil {
					return err
				}
				defer tx.Rollback(ctx)
				if _, err := tx.Exec(ctx, `UPDATE "UploadAttempt" SET "status" = 'STAGED', "completedAt" = NOW() WHERE id = $1`, attemptID); err != nil {
					return err
				}
				if _, err := tx.Exec(
					ctx,
					`INSERT INTO "OutboxEvent" ("id", "eventType", "aggregateId", "payload", "createdAt", "availableAt") VALUES ($1, 'UPLOAD', $2, '{}'::jsonb, NOW(), NOW())`,
					uuid.NewString(), id,
				); err != nil {
					return err
				}
				if _, err := tx.Exec(ctx, `DELETE FROM "OutboxEvent" WHERE id = $1`, outboxID); err != nil {
					return err
				}
				return tx.Commit(ctx)
			}

			if i.UploadStatus == model.StateStaged || i.UploadStatus == model.StateUploadPending || i.UploadStatus == model.StateUploading {
				mediaKind := "IMAGE"
				if i.MediaType == "VIDEO" {
					mediaKind = "VIDEO"
				}
				if i.ThumbnailPath == nil || *i.ThumbnailPath == "" {
					for _, sz := range []int{320, 640} {
						if _, err := p.Store.Thumbnail(ctx, id, sz, mediaKind); err != nil {
							return err
						}
					}
					tpath, _ := p.Store.PathFor(id, 320)
					if _, err := p.DB.Pool.Exec(ctx, `UPDATE "Image" SET "thumbnailPath" = $1, "updatedAt" = NOW() WHERE id = $2`, tpath, id); err != nil {
						return err
					}
					i.ThumbnailPath = &tpath
				}
				if i.UploadStatus == model.StateStaged {
					if err := moveState(model.StateUploadPending); err != nil {
						return err
					}
				}
				if i.UploadStatus == model.StateUploadPending {
					if err := moveState(model.StateUploading); err != nil {
						return err
					}
				}
				path, err := p.Store.PathFor(id, 0)
				if err != nil {
					return err
				}
				var info media.MediaInfo
				if mediaKind == "VIDEO" {
					info, err = media.InspectVideo(ctx, path)
				} else {
					info, err = media.Inspect(path)
				}
				if err != nil {
					return err
				}
				if i.Sha256 == nil || i.MimeType == nil || info.Sha256 != *i.Sha256 || info.MimeType != *i.MimeType {
					return model.NewFault("INTEGRITY", "Staged bytes changed; inspect storage.", false, 0)
				}
				if g.DisplayName == nil || *g.DisplayName == "" {
					creds, err := p.DB.LineCredentials(ctx)
					if err == nil && creds.Token != "" {
						if resp, err := line.Call(ctx, "group/"+g.LineGroupID+"/summary", creds.Token, false, 90*time.Second); err == nil {
							var summary struct {
								GroupName string `json:"groupName"`
							}
							if json.NewDecoder(resp.Body).Decode(&summary) == nil && summary.GroupName != "" {
								runes := []rune(summary.GroupName)
								if len(runes) > 500 {
									runes = runes[:500]
								}
								s := string(runes)
								_, _ = p.DB.Pool.Exec(ctx, `UPDATE "LineGroup" SET "displayName" = $1, "updatedAt" = NOW() WHERE id = $2`, s, g.ID)
								g.DisplayName = &s
							}
							resp.Body.Close()
						}
					}
				}
				tok, err := p.DB.Access(ctx, false)
				if err != nil {
					return err
				}
				albumID, err := p.ResolveAlbum(ctx, g, tok)
				if err != nil {
					return err
				}
				alb, err := google.Album(ctx, albumID, tok)
				if err != nil {
					return err
				}
				if alb.MediaItemsCount >= 20000 {
					return model.NewFault("ALBUM_CAPACITY", "Album is full. Free album slots or approve a different strategy.", false, 0)
				}
				uploadTok, err := google.Bytes(ctx, path, info.MimeType, tok)
				if err != nil {
					return err
				}
				if err := moveState(model.StateCreatingMedia); err != nil {
					return err
				}
				m, createErr := google.CreateMedia(ctx, albumID, uploadTok, Filename(i), tok)
				if createErr != nil {
					var gf *model.Fault
					if errors.As(createErr, &gf) && definitiveGoogleFaultRe.MatchString(gf.Code) {
						return createErr
					}
					rec, _ := google.Reconcile(ctx, albumID, Filename(i), tok)
					if rec == nil {
						return model.NewFault("MEDIA_UNCERTAIN", "Creation not confirmed. Retry only reconciles the album.", false, 0)
					}
					m = *rec
				}
				if err := syncMedia(m); err != nil {
					return err
				}
			}
		}

		tx, err := p.DB.Pool.Begin(ctx)
		if err != nil {
			return err
		}
		defer tx.Rollback(ctx)
		if _, err := tx.Exec(ctx, `UPDATE "UploadAttempt" SET "status" = 'SYNCED', "completedAt" = NOW() WHERE id = $1`, attemptID); err != nil {
			return err
		}
		if _, err := tx.Exec(
			ctx,
			`INSERT INTO "AuditLog" ("id", "action", "targetType", "targetId", "metadata", "createdAt") VALUES ($1, 'Photo synced', 'image', $2, '{}'::jsonb, NOW())`,
			uuid.NewString(), id,
		); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `DELETE FROM "OutboxEvent" WHERE id = $1`, outboxID); err != nil {
			return err
		}
		return tx.Commit(ctx)
	}()

	if runErr == nil {
		return nil
	}

	var f *model.Fault
	if !errors.As(runErr, &f) {
		f = model.NewFault("PROCESSING", "Processing interrupted. Check storage and provider availability.", true, 0)
	}
	uncertain := lookupOnly ||
		((i.UploadStatus == model.StateNeedsReview || i.UploadStatus == model.StateCreatingMedia) &&
			!definitiveGoogleFaultRe.MatchString(f.Code)) ||
		i.UploadStatus == model.StateNeedsReview

	unrecCodes := []string{"LINE_404", "LINE_410", "UNSUPPORTED_IMAGE", "UNSUPPORTED_VIDEO", "FILE_SIZE"}
	var next model.State
	if uncertain {
		next = model.StateNeedsReview
	} else if f.Transient && n < 8 {
		next = model.StateRetryPending
	} else if slices.Contains(unrecCodes, f.Code) {
		next = model.StateUnrecoverable
	} else {
		next = model.StateFailed
	}

	if i.UploadStatus == model.StateSynced {
		return runErr
	}
	if i.UploadStatus != next {
		if err := model.Transition(i.UploadStatus, next, ""); err != nil {
			return err
		}
	}

	tx, err := p.DB.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(
		ctx,
		`UPDATE "Image"
		 SET "uploadStatus" = $1::"UploadState", "lastError" = $2, "errorCode" = $3, "updatedAt" = NOW()
		 WHERE id = $4 AND "uploadStatus" = $5::"UploadState"`,
		string(next), f.Message, f.Code, id, string(i.UploadStatus),
	); err != nil {
		return err
	}
	if _, err := tx.Exec(
		ctx,
		`UPDATE "UploadAttempt"
		 SET "status" = $1, "errorCode" = $2, "errorMessage" = $3, "completedAt" = NOW()
		 WHERE id = $4`,
		string(next), f.Code, f.Message, attemptID,
	); err != nil {
		return err
	}
	if next == model.StateRetryPending {
		avail := time.Now().Add(time.Duration(model.Backoff(n, f.Delay)) * time.Millisecond)
		if _, err := tx.Exec(
			ctx,
			`INSERT INTO "OutboxEvent" ("id", "eventType", "aggregateId", "payload", "createdAt", "availableAt")
			 VALUES ($1, 'PROCESS', $2, '{}'::jsonb, NOW(), $3)`,
			uuid.NewString(), id, avail,
		); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(ctx, `DELETE FROM "OutboxEvent" WHERE id = $1`, outboxID); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

func (p *Processor) removeOriginal(id string) error {
	path, err := p.Store.PathFor(id, 0)
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func (p *Processor) Cleanup(ctx context.Context, now time.Time) error {
	s, err := p.DB.OwnerPolicy(ctx)
	if err != nil {
		return err
	}
	stagingCutoff := now.Add(-time.Duration(s.StagingHours) * time.Hour)
	rows, err := p.DB.Pool.Query(
		ctx,
		`SELECT "id" FROM "Image"
		 WHERE "uploadStatus" = 'SYNCED'::"UploadState"
		   AND "googleMediaItemId" IS NOT NULL
		   AND "stagingPath" IS NOT NULL
		   AND "uploadedAt" < $1
		 LIMIT 200`,
		stagingCutoff,
	)
	if err != nil {
		return err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err == nil {
			ids = append(ids, id)
		}
	}
	rows.Close()

	for _, id := range ids {
		if err := p.removeOriginal(id); err != nil {
			return err
		}
		if _, err := p.DB.Pool.Exec(ctx, `UPDATE "Image" SET "stagingPath" = NULL, "updatedAt" = NOW() WHERE id = $1`, id); err != nil {
			return err
		}
	}

	dirs := p.Store.Dirs()
	for idx, dir := range dirs {
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, e := range entries {
			name := e.Name()
			isPart := strings.HasSuffix(name, ".part")
			isThumb := idx == 1 && strings.HasSuffix(name, ".webp")
			if !isPart && !isThumb {
				continue
			}
			fullPath := filepath.Join(dir, name)
			info, err := os.Stat(fullPath)
			if err != nil {
				continue
			}
			days := s.ThumbnailDays
			if isPart {
				days = 1
			}
			cutoff := now.Add(-time.Duration(days) * 24 * time.Hour)
			if info.ModTime().Before(cutoff) {
				_ = os.Remove(fullPath)
			}
		}
	}

	webhookCutoff := now.Add(-90 * 24 * time.Hour)
	_, _ = p.DB.Pool.Exec(ctx, `DELETE FROM "WebhookEvent" WHERE "receivedAt" < $1`, webhookCutoff)
	p.Store.ClearUsageCache()
	return nil
}

// Only the session holding the worker lock may claim work. If it disconnects,
// further claims fail; a successor can recover unacknowledged rows after a minute.
func (p *Processor) dispatch(ctx context.Context, conn *pgx.Conn) error {
	for range 100 {
		var id string
		err := conn.QueryRow(ctx, `UPDATE "OutboxEvent" SET "publishedAt" = NOW()
        WHERE id = (SELECT id FROM "OutboxEvent" WHERE "availableAt" <= NOW()
            AND ("publishedAt" IS NULL OR "publishedAt" < NOW() - interval '1 minute')
            ORDER BY CASE WHEN "eventType" = 'PROCESS' THEN 1 ELSE 2 END, "availableAt", id
            LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING id`).Scan(&id)
		if errors.Is(err, pgx.ErrNoRows) {
			return nil
		}
		if err != nil {
			return err
		}
		if err := p.ProcessEvent(ctx, id); err != nil {
			return err
		}
	}
	return nil
}

func (p *Processor) RunLoop(ctx context.Context) error {
	if err := p.Store.InitDirs(); err != nil {
		return err
	}
	// Dedicated session: never return a session-level lock to the pool.
	conn, err := pgx.ConnectConfig(ctx, p.DB.Pool.Config().ConnConfig)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	if _, err := conn.Exec(ctx, "SELECT pg_advisory_lock(72707370)"); err != nil {
		return err
	}
	bg, cancel := context.WithCancel(ctx)
	var wg sync.WaitGroup
	defer func() { cancel(); wg.Wait() }()
	periodic := func(interval time.Duration, run func()) {
		wg.Go(func() {
			ticker := time.NewTicker(interval)
			defer ticker.Stop()
			for bg.Err() == nil {
				run()
				select {
				case <-bg.Done():
					return
				case <-ticker.C:
				}
			}
		})
	}
	if p.Redis != nil {
		periodic(time.Second, func() {
			_ = p.Redis.Set(bg, "worker:heartbeat", time.Now().UTC().Format(time.RFC3339Nano), 90*time.Second).Err()
		})
	}
	periodic(time.Minute, func() {
		if err := p.Cleanup(bg, time.Now().UTC()); err != nil && bg.Err() == nil {
			log.Print("Worker cleanup incomplete; will retry")
		}
	})
	if err := p.dispatch(ctx, conn); err != nil {
		return err
	}
	ticker := time.NewTicker(1 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
			if err := p.dispatch(ctx, conn); err != nil {
				return err
			}
		}
	}
}
