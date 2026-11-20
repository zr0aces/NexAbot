// Package migrations embeds the canonical, immutable Prisma migration files.
package migrations

import "embed"

//go:embed */migration.sql
var Files embed.FS
