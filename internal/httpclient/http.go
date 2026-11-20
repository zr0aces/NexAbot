package httpclient

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"rivosnap/internal/model"
)

var (
	albumLimitRe   = regexp.MustCompile(`(?i)album.*(full|maximum|limit)|20000|20,000`)
	storageQuotaRe = regexp.MustCompile(`(?i)storage quota|storage.*full|out of storage|insufficient storage`)
	digitsRe       = regexp.MustCompile(`^\d+$`)
)

func Request(
	ctx context.Context,
	rawURL string,
	method string,
	headers map[string]string,
	body io.Reader,
	contentLength int64,
	vendor string,
	timeout time.Duration,
) (*http.Response, error) {
	if vendor == "" {
		vendor = "GOOGLE"
	}
	if timeout <= 0 {
		timeout = 90 * time.Second
	}
	reqCtx, cancel := context.WithTimeout(ctx, timeout)
	req, err := http.NewRequestWithContext(reqCtx, method, rawURL, body)
	if err != nil {
		cancel()
		return nil, model.NewFault("NETWORK", "Network timeout or connection failure.", true, 0)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	if contentLength > 0 {
		req.ContentLength = contentLength
	}
	client := &http.Client{
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
	resp, err := client.Do(req)
	if err != nil {
		cancel()
		return nil, model.NewFault("NETWORK", "Network timeout or connection failure.", true, 0)
	}
	if resp.StatusCode >= 300 && resp.StatusCode < 400 {
		resp.Body.Close()
		cancel()
		return nil, model.NewFault("NETWORK", "Network timeout or connection failure.", true, 0)
	}
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		// Wrap body so context cancel is called when closed
		resp.Body = &cancelReadCloser{ReadCloser: resp.Body, cancel: cancel}
		return resp, nil
	}
	defer func() {
		resp.Body.Close()
		cancel()
	}()
	buf, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
	text := string(buf)
	after := resp.Header.Get("Retry-After")
	delay := 0
	if digitsRe.MatchString(after) {
		if secs, err := strconv.Atoi(after); err == nil {
			delay = secs * 1000
		}
	} else if after != "" {
		if t, err := http.ParseTime(after); err == nil {
			d := int(time.Until(t).Milliseconds())
			if d > 0 {
				delay = d
			}
		}
	}
	if albumLimitRe.MatchString(text) {
		return nil, model.NewFault("ALBUM_CAPACITY", "Album is full. No overflow album was created.", false, 0)
	}
	if storageQuotaRe.MatchString(text) {
		return nil, model.NewFault("GOOGLE_STORAGE", "Free space in your Google account before retrying.", false, 0)
	}
	if resp.StatusCode == 429 {
		return nil, model.NewFault(vendor+"_RATE_LIMIT", "Provider rate limit. Retry scheduled.", true, delay)
	}
	if resp.StatusCode == 401 || resp.StatusCode == 403 || strings.Contains(text, "invalid_grant") {
		return nil, model.NewFault(vendor+"_AUTH", "Check credentials and reconnect "+vendor+".", false, 0)
	}
	return nil, model.NewFault(
		fmt.Sprintf("%s_%d", vendor, resp.StatusCode),
		fmt.Sprintf("%s returned HTTP %d", vendor, resp.StatusCode),
		resp.StatusCode >= 500 || resp.StatusCode == 408,
		delay,
	)
}

type cancelReadCloser struct {
	io.ReadCloser
	cancel context.CancelFunc
}

func (c *cancelReadCloser) Close() error {
	defer c.cancel()
	return c.ReadCloser.Close()
}
