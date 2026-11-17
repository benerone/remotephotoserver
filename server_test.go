// SPDX-License-Identifier: LGPL-2.1-only
// Copyright (C) 2026 benerone
// This file is part of remotephotoserver; see the LICENSE file for the terms.

package main

import (
	"bytes"
	"encoding/json"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func testJPEG(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{uint8(x), uint8(y), 120, 255})
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, nil); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

type client struct {
	t      *testing.T
	h      http.Handler
	remote string
	host   string
}

func (c client) do(method, url string, body []byte, hdr ...string) *httptest.ResponseRecorder {
	c.t.Helper()
	r := httptest.NewRequest(method, url, bytes.NewReader(body))
	r.RemoteAddr = c.remote
	r.Host = c.host
	for i := 0; i+1 < len(hdr); i += 2 {
		r.Header.Set(hdr[i], hdr[i+1])
	}
	w := httptest.NewRecorder()
	c.h.ServeHTTP(w, r)
	return w
}

func newApp(t *testing.T) (*App, string) {
	t.Helper()
	store, err := openStore(filepath.Join(t.TempDir(), "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	return &App{store: store, port: 8443, thumbDir: t.TempDir()}, t.TempDir()
}

func TestValidName(t *testing.T) {
	good := []string{"a.jpg", "Photo 1.JPEG", "été.png", "a.b.webp", "x.gif"}
	bad := []string{"", ".a.jpg", "a.txt", "a", "../a.jpg", "a/b.jpg", `a\b.jpg`, "a:b.jpg", ".jpg", " .jpg", "a\x00.jpg", strings.Repeat("a", 300) + ".jpg"}
	for _, n := range good {
		if err := validName(n); err != nil {
			t.Errorf("%q should be accepted: %v", n, err)
		}
	}
	for _, n := range bad {
		if err := validName(n); err == nil {
			t.Errorf("%q should be rejected", n)
		}
	}
}

func TestAccessControl(t *testing.T) {
	app, _ := newApp(t)
	h := app.routes()
	cases := []struct {
		name, remote, host, method, url, origin string
		want                                    int
	}{
		{"internet rejected", "8.8.8.8:1", "example.com", "GET", "/", "", 403},
		{"LAN home", "192.168.1.20:1", "192.168.1.10:8443", "GET", "/", "", 200},
		{"LAN admin rejected", "192.168.1.20:1", "192.168.1.10:8443", "GET", "/admin", "", 403},
		{"LAN admin API rejected", "192.168.1.20:1", "192.168.1.10:8443", "POST", "/admin/api/shares", "", 403},
		{"local admin", "127.0.0.1:1", "localhost:8443", "GET", "/admin", "", 200},
		{"local IPv6 admin", "[::1]:1", "[::1]:8443", "GET", "/admin", "", 200},
		{"rebinding rejected", "127.0.0.1:1", "evil.example:8443", "GET", "/admin", "", 403},
		{"CSRF rejected", "127.0.0.1:1", "localhost:8443", "POST", "/admin/api/shares", "https://evil.example", 403},
	}
	for _, c := range cases {
		var hdr []string
		if c.origin != "" {
			hdr = []string{"Origin", c.origin}
		}
		w := client{t, h, c.remote, c.host}.do(c.method, c.url, nil, hdr...)
		if w.Code != c.want {
			t.Errorf("%s: got status %d, want %d", c.name, w.Code, c.want)
		}
	}
}

func TestShareFlow(t *testing.T) {
	app, dir := newApp(t)
	h := app.routes()
	admin := client{t, h, "127.0.0.1:1", "localhost:8443"}
	lan := client{t, h, "192.168.1.20:1", "192.168.1.10:8443"}

	body, _ := json.Marshal(map[string]string{"path": dir})
	w := admin.do("POST", "/admin/api/shares", body)
	if w.Code != 200 {
		t.Fatalf("adding the share: %d %s", w.Code, w.Body)
	}
	var sh Share
	json.Unmarshal(w.Body.Bytes(), &sh)
	base := "/s/" + sh.ID

	if w := lan.do("GET", base+"/", nil); w.Code != 200 {
		t.Fatalf("gallery: %d", w.Code)
	}
	if w := lan.do("GET", "/s/unknown/api/list", nil); w.Code != 404 {
		t.Fatalf("unknown share: %d", w.Code)
	}

	jpg := testJPEG(t, 800, 600)
	w = lan.do("POST", base+"/api/upload", jpg)
	if w.Code != 200 {
		t.Fatalf("upload: %d %s", w.Code, w.Body)
	}
	var up struct{ Name string }
	json.Unmarshal(w.Body.Bytes(), &up)
	if !strings.HasPrefix(up.Name, "photo-") || !strings.HasSuffix(up.Name, ".jpg") {
		t.Fatalf("unexpected name: %q", up.Name)
	}

	// Import: the original name is kept, the extension follows the content, no escape from the directory.
	w = lan.do("POST", base+"/api/upload?keep=1&name=..%2F..%2Fmy+holiday.png", jpg)
	json.Unmarshal(w.Body.Bytes(), &up)
	if w.Code != 200 || up.Name != "my holiday.jpg" {
		t.Fatalf("import: %d %q", w.Code, up.Name)
	}
	w = lan.do("POST", base+"/api/upload?keep=1&name=my+holiday.jpg", jpg)
	json.Unmarshal(w.Body.Bytes(), &up)
	if up.Name != "my holiday-1.jpg" {
		t.Fatalf("duplicate name: %q", up.Name)
	}
	if w := lan.do("POST", base+"/api/upload", []byte("not an image")); w.Code != 400 {
		t.Fatalf("invalid content accepted: %d", w.Code)
	}

	// Saving an edited image
	if w := lan.do("PUT", base+"/img/edit.jpg", jpg); w.Code != 200 {
		t.Fatalf("new image: %d %s", w.Code, w.Body)
	}
	if w := lan.do("PUT", base+"/img/edit.jpg", jpg); w.Code != 409 {
		t.Fatalf("overwrite without the flag: %d", w.Code)
	}
	small := testJPEG(t, 10, 10)
	if w := lan.do("PUT", base+"/img/edit.jpg?overwrite=1", small); w.Code != 200 {
		t.Fatalf("replacement: %d", w.Code)
	}
	if got, _ := os.ReadFile(filepath.Join(dir, "edit.jpg")); !bytes.Equal(got, small) {
		t.Fatal("the file was not replaced")
	}
	if w := lan.do("PUT", base+"/img/edit.png", jpg); w.Code != 400 {
		t.Fatalf("mismatched extension accepted: %d", w.Code)
	}
	if w := lan.do("PUT", base+"/img/..%2Fevil.jpg", jpg); w.Code == 200 {
		t.Fatal("directory traversal accepted")
	}
	var pngBuf bytes.Buffer
	png.Encode(&pngBuf, image.NewRGBA(image.Rect(0, 0, 4, 4)))
	if w := lan.do("PUT", base+"/img/t.png", pngBuf.Bytes()); w.Code != 200 {
		t.Fatalf("png : %d", w.Code)
	}

	// Renaming
	ren := func(from, to string) int {
		b, _ := json.Marshal(map[string]string{"from": from, "to": to})
		return lan.do("POST", base+"/api/rename", b).Code
	}
	if c := ren("edit.jpg", "invoice.jpg"); c != 200 {
		t.Fatalf("rename: %d", c)
	}
	if c := ren("invoice.jpg", "t.png"); c == 200 {
		t.Fatal("extension change accepted")
	}
	if c := ren("invoice.jpg", "my holiday.jpg"); c != 409 {
		t.Fatalf("rename onto a taken name: %d", c)
	}
	if c := ren("invoice.jpg", "../x.jpg"); c != 400 {
		t.Fatalf("rename outside the directory: %d", c)
	}
	if c := ren("missing.jpg", "y.jpg"); c != 404 {
		t.Fatalf("rename of a missing file: %d", c)
	}

	// Listing, image, thumbnail
	w = lan.do("GET", base+"/api/list", nil)
	var list struct{ Photos []Photo }
	json.Unmarshal(w.Body.Bytes(), &list)
	if len(list.Photos) != 5 {
		t.Fatalf("want 5 photos, got %d: %s", len(list.Photos), w.Body)
	}
	if w := lan.do("GET", base+"/img/invoice.jpg", nil); w.Code != 200 || !bytes.Equal(w.Body.Bytes(), small) {
		t.Fatalf("image: %d", w.Code)
	}
	w = lan.do("GET", base+"/thumb/my%20holiday.jpg", nil)
	cfg, _, err := image.DecodeConfig(w.Body)
	if w.Code != 200 || err != nil || cfg.Width != thumbSize || cfg.Height != thumbSize*600/800 {
		t.Fatalf("thumbnail: %d %v %+v", w.Code, err, cfg)
	}
	// A symlink pointing outside the share is not served.
	secret := filepath.Join(t.TempDir(), "secret.jpg")
	os.WriteFile(secret, jpg, 0o600)
	os.Symlink(secret, filepath.Join(dir, "link.jpg"))
	if w := lan.do("GET", base+"/img/link.jpg", nil); w.Code != 404 {
		t.Fatalf("symlink served: %d", w.Code)
	}

	// QR code, then unsharing
	if ips := lanIPs(); len(ips) > 0 {
		w := admin.do("GET", "/admin/api/qr?id="+sh.ID+"&ip="+ips[0].String(), nil)
		if _, err := png.Decode(w.Body); w.Code != 200 || err != nil {
			t.Fatalf("QR code: %d %v", w.Code, err)
		}
	}
	if w := admin.do("GET", "/admin/api/qr?id="+sh.ID+"&ip=1.2.3.4", nil); w.Code != 400 {
		t.Fatalf("QR for an unknown address: %d", w.Code)
	}
	if w := admin.do("DELETE", "/admin/api/shares/"+sh.ID, nil); w.Code != 200 {
		t.Fatalf("removing the share: %d", w.Code)
	}
	if w := lan.do("GET", base+"/api/list", nil); w.Code != 404 {
		t.Fatalf("removed share still reachable: %d", w.Code)
	}
}

func TestExifOrientation(t *testing.T) {
	// Minimal JPEG: SOI + APP1 Exif (big-endian) with orientation = 6
	exif := []byte{0xFF, 0xD8, 0xFF, 0xE1, 0x00, 0x22, 'E', 'x', 'i', 'f', 0, 0,
		'M', 'M', 0, 42, 0, 0, 0, 8, 0, 1,
		0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0,
		0, 0, 0, 0, 0xFF, 0xD9}
	if o := exifOrientation(bytes.NewReader(exif)); o != 6 {
		t.Fatalf("orientation %d, want 6", o)
	}
	if o := exifOrientation(bytes.NewReader(testJPEG(t, 4, 4))); o != 1 {
		t.Fatalf("orientation %d, want 1", o)
	}
	src := image.NewRGBA(image.Rect(0, 0, 3, 2))
	src.SetRGBA(0, 1, color.RGBA{255, 0, 0, 255}) // bottom-left corner
	dst := orient(src, 6)                         // 90° clockwise: it moves to the top-left
	if dst.Bounds().Dx() != 2 || dst.Bounds().Dy() != 3 || dst.RGBAAt(0, 0).R != 255 {
		t.Fatalf("wrong rotation: %v", dst.Bounds())
	}
}
