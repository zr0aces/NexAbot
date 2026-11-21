package web

import (
	"embed"
	"io/fs"
	"os"
)

//go:embed all:dist
var embedded embed.FS

// Dist returns the built web frontend filesystem, preferring apps/web/dist on disk
// during local development and falling back to the embedded build in production.
func Dist() fs.FS {
	if info, err := os.Stat("apps/web/dist/index.html"); err == nil && !info.IsDir() {
		return os.DirFS("apps/web/dist")
	}
	sub, err := fs.Sub(embedded, "dist")
	if err != nil {
		return embedded
	}
	return sub
}
