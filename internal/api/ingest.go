package api

import (
	"context"
	"time"

	"github.com/google/uuid"

	"rivosnap/internal/line"
	"rivosnap/internal/model"
)

func (s *Server) Ingest(ctx context.Context, raw []byte) (line.Envelope, error) {
	payload, err := line.ParseEnvelope(raw)
	if err != nil {
		return payload, errBadRequest("Invalid request. Check the submitted values.")
	}
	policy, err := s.DB.OwnerPolicy(ctx)
	if err != nil {
		return payload, err
	}
	for _, e := range payload.Events {
		if !line.Relevant(e) {
			continue
		}
		groupID := e.Source.GroupID
		eventDate := time.UnixMilli(e.Timestamp).UTC()
		if err := s.ingestSingleEvent(ctx, payload.Destination, e, groupID, eventDate, policy.CollectVideos); err != nil {
			return payload, err
		}
	}
	return payload, nil
}

func (s *Server) ingestSingleEvent(
	ctx context.Context,
	destination string,
	e line.Event,
	groupID string,
	date time.Time,
	collectVideos bool,
) error {
	tx, err := s.DB.Pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)

	cmd, err := tx.Exec(
		ctx,
		`INSERT INTO "WebhookEvent" ("id", "webhookEventId", "eventType", "processingStatus", "receivedAt", "processedAt")
		 VALUES ($1, $2, $3, 'PROCESSED', NOW(), NOW())
		 ON CONFLICT ("webhookEventId") DO NOTHING`,
		uuid.NewString(), e.WebhookEventID, e.Type,
	)
	if err != nil {
		return err
	}
	if cmd.RowsAffected() == 0 {
		return tx.Commit(ctx)
	}

	initMembership := "JOINED"
	if e.Type == "leave" {
		initMembership = "LEFT"
	}
	if _, err := tx.Exec(
		ctx,
		`INSERT INTO "LineGroup" ("id", "lineGroupId", "lastEventAt", "membershipAt", "membershipStatus", "enabled", "albumCreating", "createdAt", "updatedAt")
		 VALUES ($1, $2, $3, $3, $4, false, false, NOW(), NOW())
		 ON CONFLICT ("lineGroupId") DO NOTHING`,
		uuid.NewString(), groupID, date, initMembership,
	); err != nil {
		return err
	}

	var lockedID string
	if err := tx.QueryRow(ctx, `SELECT id FROM "LineGroup" WHERE "lineGroupId" = $1 FOR UPDATE`, groupID).Scan(&lockedID); err != nil {
		return err
	}
	if _, err := tx.Exec(
		ctx,
		`UPDATE "LineGroup" SET "lastEventAt" = $1, "updatedAt" = NOW() WHERE "lineGroupId" = $2 AND "lastEventAt" < $1`,
		date, groupID,
	); err != nil {
		return err
	}

	if e.Type != "message" {
		if e.Type == "leave" {
			if _, err := tx.Exec(
				ctx,
				`UPDATE "LineGroup"
				 SET "membershipStatus" = 'LEFT', "membershipAt" = $1, "enabled" = false, "updatedAt" = NOW()
				 WHERE "lineGroupId" = $2 AND "membershipAt" <= $1`,
				date, groupID,
			); err != nil {
				return err
			}
		} else {
			if _, err := tx.Exec(
				ctx,
				`UPDATE "LineGroup"
				 SET "membershipStatus" = 'JOINED', "membershipAt" = $1, "updatedAt" = NOW()
				 WHERE "lineGroupId" = $2 AND "membershipAt" <= $1`,
				date, groupID,
			); err != nil {
				return err
			}
		}
		if e.Type == "join" {
			if _, err := tx.Exec(
				ctx,
				`INSERT INTO "OutboxEvent" ("id", "eventType", "aggregateId", "payload", "createdAt", "availableAt")
				 VALUES ($1, 'GROUP_SUMMARY', $2, '{}'::jsonb, NOW(), NOW())`,
				uuid.NewString(), groupID,
			); err != nil {
				return err
			}
		}
		return tx.Commit(ctx)
	}

	var enabled bool
	var membershipStatus string
	var membershipAt time.Time
	var enabledSince *time.Time
	if err := tx.QueryRow(
		ctx,
		`SELECT "enabled", "membershipStatus", "membershipAt", "enabledSince" FROM "LineGroup" WHERE "lineGroupId" = $1`,
		groupID,
	).Scan(&enabled, &membershipStatus, &membershipAt, &enabledSince); err != nil {
		return err
	}

	if !enabled || membershipStatus != "JOINED" || date.Before(membershipAt) || (enabledSince != nil && date.Before(*enabledSince)) {
		return tx.Commit(ctx)
	}

	mediaType := "IMAGE"
	if e.Message.Type == "video" {
		mediaType = "VIDEO"
	}
	if mediaType == "VIDEO" && !collectVideos {
		return tx.Commit(ctx)
	}

	imageID := uuid.NewString()
	imgCmd, err := tx.Exec(
		ctx,
		`INSERT INTO "Image" ("id", "lineGroupId", "lineMessageId", "channelId", "lineEventTimestamp", "mediaType", "uploadStatus", "createdAt", "updatedAt")
		 VALUES ($1, $2, $3, $4, $5, $6, 'RECEIVED'::"UploadState", NOW(), NOW())
		 ON CONFLICT ("channelId", "lineMessageId") DO NOTHING`,
		imageID, groupID, e.Message.ID, destination, date, mediaType,
	)
	if err != nil {
		return err
	}
	if imgCmd.RowsAffected() == 0 {
		return tx.Commit(ctx)
	}

	pressured, err := s.Store.Pressured(collectVideos || mediaType == "VIDEO")
	if err != nil {
		return err
	}
	if pressured {
		return model.NewFault("DISK_PRESSURE", "Ingestion paused: staging disk reserve reached.", true, 0)
	}

	if _, err := tx.Exec(
		ctx,
		`INSERT INTO "OutboxEvent" ("id", "eventType", "aggregateId", "payload", "createdAt", "availableAt")
		 VALUES ($1, 'PROCESS', $2, '{}'::jsonb, NOW(), NOW())`,
		uuid.NewString(), imageID,
	); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
