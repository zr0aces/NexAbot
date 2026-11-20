package db

import (
	"context"
	"crypto/sha256"
	"fmt"
	"io/fs"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"rivosnap/packages/database/migrations"
)

// Serialize with Prisma migrate deploy and commit SQL and history together.
func (d *DB) Migrate(ctx context.Context) error {
	return pgx.BeginFunc(ctx, d.Pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, "SELECT pg_advisory_xact_lock(72707369)"); err != nil {
			return err
		}
		if _, err := tx.Exec(ctx, `CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
    id VARCHAR(36) PRIMARY KEY NOT NULL, checksum VARCHAR(64) NOT NULL,
    finished_at TIMESTAMPTZ, migration_name VARCHAR(255) NOT NULL, logs TEXT,
    rolled_back_at TIMESTAMPTZ, started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    applied_steps_count INTEGER NOT NULL DEFAULT 0)`); err != nil {
			return err
		}
		rows, err := tx.Query(ctx, `SELECT migration_name, checksum, finished_at IS NOT NULL FROM "_prisma_migrations" WHERE rolled_back_at IS NULL`)
		if err != nil {
			return err
		}
		applied := map[string]string{}
		for rows.Next() {
			var name, hash string
			var finished bool
			if err := rows.Scan(&name, &hash, &finished); err != nil {
				rows.Close()
				return err
			}
			if !finished {
				rows.Close()
				return fmt.Errorf("unfinished migration: %s; resolve it before starting", name)
			}
			applied[name] = hash
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return err
		}
		files, err := fs.Glob(migrations.Files, "*/migration.sql")
		if err != nil {
			return err
		}
		for _, file := range files {
			name := strings.TrimSuffix(file, "/migration.sql")
			sql, err := migrations.Files.ReadFile(file)
			if err != nil {
				return err
			}
			hash := fmt.Sprintf("%x", sha256.Sum256(sql))
			if previous, ok := applied[name]; ok {
				if previous != hash {
					return fmt.Errorf("migration checksum mismatch: %s", name)
				}
				delete(applied, name)
				continue
			}
			if _, err := tx.Exec(ctx, string(sql)); err != nil {
				return fmt.Errorf("apply migration %s: %w", name, err)
			}
			if _, err := tx.Exec(ctx, `INSERT INTO "_prisma_migrations" (id,checksum,migration_name,finished_at,applied_steps_count) VALUES ($1,$2,$3,now(),1)`, uuid.NewString(), hash, name); err != nil {
				return err
			}
		}
		if len(applied) > 0 {
			return fmt.Errorf("database has migrations unknown to this binary")
		}
		return nil
	})
}
