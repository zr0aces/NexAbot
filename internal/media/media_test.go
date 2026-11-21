package media

import (
	"bytes"
	"context"
	"crypto/rand"
	"golang.org/x/image/webp"
	"image"
	"image/color"
	"image/jpeg"
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

func TestInspectDoesNotFullyDecode(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 64, 48))
	for y := range 48 {
		for x := range 64 {
			img.Set(x, y, color.RGBA{R: uint8(x * 4), G: uint8(y * 5), B: uint8(x ^ y), A: 255})
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, nil); err != nil {
		t.Fatal(err)
	}
	sos := bytes.Index(buf.Bytes(), []byte{0xFF, 0xDA})
	if sos < 0 {
		t.Fatal("no SOS marker")
	}
	path := filepath.Join(t.TempDir(), "truncated.jpg")
	if err := os.WriteFile(path, buf.Bytes()[:sos+20], 0o600); err != nil {
		t.Fatal(err)
	}
	info, err := Inspect(path)
	if err != nil {
		t.Fatalf("Inspect decoded beyond the header: %v", err)
	}
	if info.MimeType != "image/jpeg" || info.Width != 64 || info.Height != 48 || info.Sha256 == "" {
		t.Fatalf("unexpected info: %+v", info)
	}
}

func stageStore(t *testing.T) (*Store, string) {
	t.Helper()
	dir := t.TempDir()
	return NewStore(config.Env{StagingPath: dir, ThumbnailPath: dir, MaxImageSizeMB: 1}), dir
}

func assertNoPart(t *testing.T, dir string) {
	t.Helper()
	parts, err := filepath.Glob(filepath.Join(dir, "*.part"))
	if err != nil || len(parts) != 0 {
		t.Fatalf("leftover .part files: %v, %v", parts, err)
	}
}

func TestStageKeepsFileOnInspectFailure(t *testing.T) {
	s, dir := stageStore(t)
	junk := make([]byte, 4096)
	if _, err := rand.Read(junk); err != nil {
		t.Fatal(err)
	}
	junk[0] = 0 // never a valid magic number
	info, err := s.Stage(context.Background(), "00000000-0000-4000-8000-000000000002", bytes.NewReader(junk), "IMAGE")
	if err == nil {
		t.Fatal("random bytes accepted as an image")
	}
	if info.StagingPath == "" {
		t.Fatal("inspect failure did not report the kept staging path")
	}
	kept, err := os.ReadFile(info.StagingPath)
	if err != nil || !bytes.Equal(kept, junk) {
		t.Fatalf("original not kept intact: %v", err)
	}
	assertNoPart(t, dir)
}

func TestStageDeletesPartOnOversize(t *testing.T) {
	s, dir := stageStore(t)
	info, err := s.Stage(context.Background(), "00000000-0000-4000-8000-000000000003", bytes.NewReader(make([]byte, 1048577)), "IMAGE")
	if err == nil || info.StagingPath != "" {
		t.Fatalf("oversize accepted: %+v, %v", info, err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 0 {
		t.Fatalf("leftover files: %v, %v", entries, err)
	}
}
