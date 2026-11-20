package media

import (
	"context"
	"golang.org/x/image/webp"
	"os"
	"os/exec"
	"path/filepath"
	"rivosnap/internal/config"
	"testing"
)

func TestVideoDimensionLimit(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("PATH", dir)
	source := filepath.Join(dir, "source")
	if err := os.WriteFile(source, []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		height  string
		allowed bool
	}{{"10000", true}, {"10001", false}} {
		probe := "#!/bin/sh\necho '{\"streams\":[{\"width\":10000,\"height\":" + tc.height + "}],\"format\":{\"format_name\":\"mp4\"}}'\n"
		if err := os.WriteFile(filepath.Join(dir, "ffprobe"), []byte(probe), 0700); err != nil {
			t.Fatal(err)
		}
		_, err := InspectVideo(context.Background(), source)
		if (err == nil) != tc.allowed {
			t.Fatalf("height %s: %v", tc.height, err)
		}
	}
}
func TestNoThumbnailPublishedWhenEncoderFails(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("PATH", dir)
	s := NewStore(config.Env{ThumbnailPath: dir})
	id := "00000000-0000-4000-8000-000000000001"
	if _, err := s.CacheThumbnail(context.Background(), id, 320, []byte("fixture")); err == nil {
		t.Fatal("reported success without encoder")
	}
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 0 {
		t.Fatalf("leftover thumbnail files: %v, %v", entries, err)
	}
}

func TestShortVideoThumbnailFallsBackToFirstFrame(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg required")
	}
	dir := t.TempDir()
	s := NewStore(config.Env{StagingPath: dir, ThumbnailPath: dir})
	id := "00000000-0000-4000-8000-000000000001"
	source, err := s.PathFor(id, 0)
	if err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command("ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=s=32x24:d=0.4", "-c:v", "mpeg4", "-f", "mp4", source).CombinedOutput(); err != nil {
		t.Fatalf("fixture: %v: %s", err, out)
	}
	path, err := s.Thumbnail(context.Background(), id, 320, "VIDEO")
	if err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	im, err := webp.Decode(f)
	if err != nil {
		t.Fatal(err)
	}
	if im.Bounds().Dx() != 32 || im.Bounds().Dy() != 24 {
		t.Fatalf("unexpected dimensions: %v", im.Bounds())
	}
}
