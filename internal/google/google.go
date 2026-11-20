package google

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"rivosnap/internal/config"
	"rivosnap/internal/httpclient"
	"rivosnap/internal/model"
)

const EditScope = "https://www.googleapis.com/auth/photoslibrary.edit.appcreateddata"

var Scopes = []string{
	"https://www.googleapis.com/auth/photoslibrary.appendonly",
	"https://www.googleapis.com/auth/photoslibrary.readonly.appcreateddata",
	EditScope,
}

const rootURL = "https://photoslibrary.googleapis.com/v1/"

var (
	ctrlRe         = regexp.MustCompile(`[\x00-\x1f\x7f]`)
	itemCapacityRe = regexp.MustCompile(`(?i)album.*(limit|full)|20,?000`)
	itemStorageRe  = regexp.MustCompile(`(?i)storage`)
)

func Consent(env config.Env, state string) (string, error) {
	if env.GoogleClientID == "" || env.GoogleClientSecret == "" {
		return "", model.NewFault("GOOGLE_CONFIG", "Configure the Google OAuth client first.", false, 0)
	}
	v := url.Values{}
	v.Set("response_type", "code")
	v.Set("client_id", env.GoogleClientID)
	v.Set("redirect_uri", env.GoogleRedirectURI)
	v.Set("scope", strings.Join(Scopes, " "))
	v.Set("access_type", "offline")
	v.Set("prompt", "consent")
	v.Set("state", state)
	return "https://accounts.google.com/o/oauth2/v2/auth?" + v.Encode(), nil
}

type TokenResult struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	Scope        string `json:"scope"`
}

func Token(ctx context.Context, env config.Env, fields map[string]string) (TokenResult, error) {
	v := url.Values{}
	v.Set("client_id", env.GoogleClientID)
	v.Set("client_secret", env.GoogleClientSecret)
	for k, val := range fields {
		v.Set(k, val)
	}
	encoded := v.Encode()
	resp, err := httpclient.Request(
		ctx,
		"https://oauth2.googleapis.com/token",
		http.MethodPost,
		map[string]string{"Content-Type": "application/x-www-form-urlencoded"},
		strings.NewReader(encoded),
		int64(len(encoded)),
		"GOOGLE",
		90*time.Second,
	)
	if err != nil {
		return TokenResult{}, err
	}
	defer resp.Body.Close()
	var res TokenResult
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil || res.AccessToken == "" {
		return TokenResult{}, errors.New("invalid OAuth token response")
	}
	return res, nil
}

func Refresh(ctx context.Context, env config.Env, refreshToken string) (TokenResult, error) {
	return Token(ctx, env, map[string]string{
		"grant_type":    "refresh_token",
		"refresh_token": refreshToken,
	})
}

func apiCall(ctx context.Context, path, accessToken string, body any, method string) ([]byte, error) {
	if method == "" {
		if body != nil {
			method = http.MethodPost
		} else {
			method = http.MethodGet
		}
	}
	var reader io.Reader
	var length int64
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(b)
		length = int64(len(b))
	}
	resp, err := httpclient.Request(
		ctx,
		rootURL+path,
		method,
		map[string]string{
			"Authorization": "Bearer " + accessToken,
			"Content-Type":  "application/json",
		},
		reader,
		length,
		"GOOGLE",
		90*time.Second,
	)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	return io.ReadAll(resp.Body)
}

func Title(name *string, lineGroupID string) string {
	clean := ""
	if name != nil {
		clean = strings.TrimSpace(ctrlRe.ReplaceAllString(*name, " "))
	}
	if clean == "" {
		suffix := lineGroupID
		if len(suffix) > 8 {
			suffix = suffix[len(suffix)-8:]
		}
		clean = "Group " + suffix
	}
	runes := []rune("LINE - " + clean)
	if len(runes) > 500 {
		runes = runes[:500]
	}
	return string(runes)
}

type AlbumInfo struct {
	ID              string
	MediaItemsCount int
}

func Album(ctx context.Context, id, token string) (AlbumInfo, error) {
	raw, err := apiCall(ctx, "albums/"+url.PathEscape(id), token, nil, http.MethodGet)
	if err != nil {
		return AlbumInfo{}, err
	}
	var parsed struct {
		ID              string `json:"id"`
		MediaItemsCount any    `json:"mediaItemsCount"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil || parsed.ID == "" {
		return AlbumInfo{}, errors.New("invalid album response")
	}
	count := 0
	switch v := parsed.MediaItemsCount.(type) {
	case string:
		count, _ = strconv.Atoi(v)
	case float64:
		count = int(v)
	}
	return AlbumInfo{ID: parsed.ID, MediaItemsCount: count}, nil
}

func CreateAlbum(ctx context.Context, name, token string) (string, error) {
	raw, err := apiCall(ctx, "albums", token, map[string]any{
		"album": map[string]string{"title": name},
	}, http.MethodPost)
	if err != nil {
		return "", err
	}
	var parsed struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil || parsed.ID == "" {
		return "", errors.New("invalid createAlbum response")
	}
	return parsed.ID, nil
}

func RenameAlbum(ctx context.Context, id, name, token string) (string, error) {
	raw, err := apiCall(
		ctx,
		"albums/"+url.PathEscape(id)+"?updateMask=title",
		token,
		map[string]string{"title": name},
		http.MethodPatch,
	)
	if err != nil {
		return "", err
	}
	var parsed struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil || parsed.ID == "" {
		return "", errors.New("invalid renameAlbum response")
	}
	return parsed.ID, nil
}

type MediaItem struct {
	ID         string `json:"id"`
	BaseURL    string `json:"baseUrl,omitempty"`
	ProductURL string `json:"productUrl,omitempty"`
	Filename   string `json:"filename,omitempty"`
}

func Item(ctx context.Context, id, token string) (MediaItem, error) {
	raw, err := apiCall(ctx, "mediaItems/"+url.PathEscape(id), token, nil, http.MethodGet)
	if err != nil {
		return MediaItem{}, err
	}
	var m MediaItem
	if err := json.Unmarshal(raw, &m); err != nil || m.ID == "" {
		return MediaItem{}, errors.New("invalid media item")
	}
	return m, nil
}

func Bytes(ctx context.Context, filePath, mime, token string) (string, error) {
	st, err := os.Stat(filePath)
	if err != nil {
		return "", err
	}
	f, err := os.Open(filePath)
	if err != nil {
		return "", err
	}
	defer f.Close()
	resp, err := httpclient.Request(
		ctx,
		rootURL+"uploads",
		http.MethodPost,
		map[string]string{
			"Authorization":              "Bearer " + token,
			"Content-Type":               "application/octet-stream",
			"Content-Length":             strconv.FormatInt(st.Size(), 10),
			"X-Goog-Upload-Content-Type": mime,
			"X-Goog-Upload-Protocol":     "raw",
		},
		f,
		st.Size(),
		"GOOGLE",
		600*time.Second,
	)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	res := strings.TrimSpace(string(b))
	if res == "" {
		return "", model.NewFault("GOOGLE_UPLOAD", "Missing upload token.", true, 0)
	}
	return res, nil
}

func CreateMedia(ctx context.Context, albumID, uploadToken, fileName, token string) (MediaItem, error) {
	raw, err := apiCall(ctx, "mediaItems:batchCreate", token, map[string]any{
		"albumId": albumID,
		"newMediaItems": []map[string]any{
			{
				"simpleMediaItem": map[string]string{
					"uploadToken": uploadToken,
					"fileName":    fileName,
				},
			},
		},
	}, http.MethodPost)
	if err != nil {
		return MediaItem{}, err
	}
	var data struct {
		NewMediaItemResults []struct {
			Status struct {
				Code    int    `json:"code"`
				Message string `json:"message"`
			} `json:"status"`
			MediaItem MediaItem `json:"mediaItem"`
		} `json:"newMediaItemResults"`
	}
	if err := json.Unmarshal(raw, &data); err != nil || len(data.NewMediaItemResults) == 0 {
		return MediaItem{}, errors.New("invalid batchCreate response")
	}
	result := data.NewMediaItemResults[0]
	if result.Status.Code != 0 {
		code := result.Status.Code
		msg := result.Status.Message
		if code == 2 || code == 4 || code == 13 || code == 14 {
			return MediaItem{}, model.NewFault("MEDIA_UNCERTAIN", "Google could not confirm the media creation result.", false, 0)
		}
		if itemCapacityRe.MatchString(msg) {
			return MediaItem{}, model.NewFault("ALBUM_CAPACITY", "Album capacity reached.", false, 0)
		}
		if itemStorageRe.MatchString(msg) {
			return MediaItem{}, model.NewFault("GOOGLE_STORAGE", "Google account storage exhausted.", false, 0)
		}
		return MediaItem{}, model.NewFault(
			fmt.Sprintf("GOOGLE_ITEM_%d", code),
			fmt.Sprintf("Google rejected the media item (status %d).", code),
			code == 8,
			0,
		)
	}
	if result.MediaItem.ID == "" {
		return MediaItem{}, errors.New("missing mediaItem id")
	}
	return result.MediaItem, nil
}

func Reconcile(ctx context.Context, albumID, filename, token string) (*MediaItem, error) {
	var pageToken string
	var match *MediaItem
	for {
		body := map[string]any{
			"albumId":  albumID,
			"pageSize": 100,
		}
		if pageToken != "" {
			body["pageToken"] = pageToken
		}
		raw, err := apiCall(ctx, "mediaItems:search", token, body, http.MethodPost)
		if err != nil {
			return nil, err
		}
		var page struct {
			MediaItems    []MediaItem `json:"mediaItems"`
			NextPageToken string      `json:"nextPageToken"`
		}
		if err := json.Unmarshal(raw, &page); err != nil {
			return nil, err
		}
		for _, m := range page.MediaItems {
			if m.Filename == filename {
				if match != nil {
					// Duplicate matches -> ambiguous
					return nil, nil
				}
				mCopy := m
				match = &mCopy
			}
		}
		if page.NextPageToken == "" {
			break
		}
		pageToken = page.NextPageToken
	}
	return match, nil
}

func Validate(ctx context.Context, token string) error {
	_, err := apiCall(ctx, "albums?pageSize=1", token, nil, http.MethodGet)
	return err
}
