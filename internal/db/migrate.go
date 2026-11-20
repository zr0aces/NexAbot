package db

import (
	"context"
	"crypto/sha256"
	"fmt"
	"io/fs"
	"sort"
	"strings"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"

	"rivosnap/packages/database/migrations"
)

type MigrationFile struct {
	Name     string
	SQL      string
	Checksum string
}

func LoadEmbeddedMigrations() ([]MigrationFile, error) {
	files, err := fs.Glob(migrations.Files, "*/migration.sql")
	if err != nil {
		return nil, err
	}
	sort.Strings(files)
	list := make([]MigrationFile, 0, len(files))
	for _, file := range files {
		name := strings.TrimSuffix(file, "/migration.sql")
		raw, err := migrations.Files.ReadFile(file)
		if err != nil {
			return nil, fmt.Errorf("read migration %s: %w", name, err)
		}
		hash := fmt.Sprintf("%x", sha256.Sum256(raw))
		list = append(list, MigrationFile{
			Name:     name,
			SQL:      string(raw),
			Checksum: hash,
		})
	}
	return list, nil
}

// Serialize with Prisma migrate deploy and commit SQL and history together.
func (d *DB) Migrate(ctx context.Context) error {
	list, err := LoadEmbeddedMigrations()
	if err != nil {
		return err
	}
	return RunMigrations(ctx, d.Pool, list)
}

func RunMigrations(ctx context.Context, pool interface {
	Begin(context.Context) (pgx.Tx, error)
}, list []MigrationFile) error {
	return pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
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

		// Baseline detection if _prisma_migrations was empty on an already-initialized schema
		if len(applied) == 0 {
			var ownerExists bool
			if err := tx.QueryRow(
				ctx,
				`SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'Owner')`,
			).Scan(&ownerExists); err != nil {
				return err
			}
			if ownerExists {
				for _, m := range list {
					present, err := checkBaselinePresenceTx(ctx, tx, m.Name)
					if err != nil {
						return err
					}
					if present {
						if _, err := tx.Exec(
							ctx,
							`INSERT INTO "_prisma_migrations" (id,checksum,migration_name,finished_at,applied_steps_count) VALUES ($1,$2,$3,now(),1)`,
							uuid.NewString(), m.Checksum, m.Name,
						); err != nil {
							return err
						}
						applied[m.Name] = m.Checksum
					}
				}
			}
		}

		fmt.Printf("%d migrations found in prisma/migrations\n", len(list))
		appliedCount := 0
		for _, m := range list {
			if previous, ok := applied[m.Name]; ok {
				if previous != m.Checksum {
					return fmt.Errorf("migration checksum mismatch: %s", m.Name)
				}
				delete(applied, m.Name)
				continue
			}
			fmt.Printf("Applying migration `%s`\n", m.Name)
			if _, err := tx.Exec(ctx, m.SQL); err != nil {
				return fmt.Errorf("apply migration %s: %w", m.Name, err)
			}
			if _, err := tx.Exec(
				ctx,
				`INSERT INTO "_prisma_migrations" (id,checksum,migration_name,finished_at,applied_steps_count) VALUES ($1,$2,$3,now(),1)`,
				uuid.NewString(), m.Checksum, m.Name,
			); err != nil {
				return err
			}
			appliedCount++
		}
		if len(applied) > 0 {
			return fmt.Errorf("database has migrations unknown to this binary")
		}
		if appliedCount == 0 {
			fmt.Println("No pending migrations to apply.")
		} else {
			fmt.Println("All migrations have been successfully applied.")
		}
		return nil
	})
}

func checkBaselinePresenceTx(ctx context.Context, tx pgx.Tx, migrationName string) (bool, error) {
	switch {
	case strings.HasPrefix(migrationName, "202611190001_"):
		var ok bool
		err := tx.QueryRow(
			ctx,
			`SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'Owner')`,
		).Scan(&ok)
		return ok, err
	case strings.HasPrefix(migrationName, "202611190002_"):
		var ok bool
		err := tx.QueryRow(
			ctx,
			`SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'LineGroup' AND column_name = 'enabledSince')`,
		).Scan(&ok)
		return ok, err
	case strings.HasPrefix(migrationName, "202611200001_"):
		var ok bool
		err := tx.QueryRow(
			ctx,
			`SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'Image' AND column_name = 'mediaType')`,
		).Scan(&ok)
		return ok, err
	default:
		return false, nil
	}
}
