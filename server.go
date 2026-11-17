package main

import (
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	qrcode "github.com/skip2/go-qrcode"
)

//go:embed web
var webFS embed.FS

const maxUpload = 100 << 20

type App struct {
	store    *Store
	port     int
	thumbDir string
}

func (a *App) routes() http.Handler {
	mux := http.NewServeMux()
	static, _ := fs.Sub(webFS, "web/static")
	mux.Handle("GET /static/", http.StripPrefix("/static/", http.FileServerFS(static)))

	// Client side (local network)
	mux.HandleFunc("GET /{$}", page("web/home.html"))
	mux.HandleFunc("GET /api/shares", a.handleShares)
	mux.HandleFunc("GET /s/{id}", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, r.URL.Path+"/", http.StatusMovedPermanently)
	})
	mux.HandleFunc("GET /s/{id}/{$}", a.withShare(func(w http.ResponseWriter, r *http.Request, _ Share) {
		page("web/gallery.html")(w, r)
	}))
	mux.HandleFunc("GET /s/{id}/api/list", a.withShare(a.handleList))
	mux.HandleFunc("GET /s/{id}/img/{name}", a.withShare(a.handleImage))
	mux.HandleFunc("GET /s/{id}/thumb/{name}", a.withShare(a.handleThumb))
	mux.HandleFunc("PUT /s/{id}/img/{name}", a.withShare(a.handleSave))
	mux.HandleFunc("POST /s/{id}/api/upload", a.withShare(a.handleUpload))
	mux.HandleFunc("POST /s/{id}/api/rename", a.withShare(a.handleRename))

	// Administration (host machine only)
	mux.HandleFunc("GET /admin", adminOnly(page("web/admin.html")))
	mux.HandleFunc("GET /admin/api/state", adminOnly(a.handleAdminState))
	mux.HandleFunc("GET /admin/api/browse", adminOnly(a.handleBrowse))
	mux.HandleFunc("GET /admin/api/qr", adminOnly(a.handleQR))
	mux.HandleFunc("POST /admin/api/shares", adminOnly(a.handleAddShare))
	mux.HandleFunc("DELETE /admin/api/shares/{id}", adminOnly(a.handleRemoveShare))

	return guard(mux)
}

// guard restricts the service to the local network and rejects mutating
// requests issued from another site (CSRF).
func guard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		addr, ok := remoteAddr(r)
		if !ok || !(addr.IsLoopback() || addr.IsPrivate() || addr.IsLinkLocalUnicast()) {
			http.Error(w, "access restricted to the local network", http.StatusForbidden)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			if origin := r.Header.Get("Origin"); origin != "" {
				u, err := url.Parse(origin)
				if err != nil || u.Host != r.Host {
					http.Error(w, "origin not allowed", http.StatusForbidden)
					return
				}
			}
		}
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Content-Security-Policy", "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'")
		next.ServeHTTP(w, r)
	})
}

func remoteAddr(r *http.Request) (netip.Addr, bool) {
	ap, err := netip.ParseAddrPort(r.RemoteAddr)
	if err != nil {
		return netip.Addr{}, false
	}
	return ap.Addr().Unmap().WithZone(""), true
}

func isLocalRequest(r *http.Request) bool {
	addr, ok := remoteAddr(r)
	if !ok || !addr.IsLoopback() {
		return false
	}
	// Checking the Host header blocks DNS rebinding.
	host := r.Host
	if h, _, err := net.SplitHostPort(r.Host); err == nil {
		host = h
	}
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}

func adminOnly(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !isLocalRequest(r) {
			http.Error(w, "the administration is only available from the machine running the server (https://localhost)", http.StatusForbidden)
			return
		}
		next(w, r)
	}
}

func (a *App) withShare(next func(http.ResponseWriter, *http.Request, Share)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sh, ok := a.store.Get(r.PathValue("id"))
		if !ok {
			fail(w, http.StatusNotFound, errors.New("this directory is not (or no longer) shared"))
			return
		}
		next(w, r, sh)
	}
}

func page(name string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		data, err := webFS.ReadFile(name)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		w.Write(data)
	}
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	json.NewEncoder(w).Encode(v)
}

func fail(w http.ResponseWriter, code int, err error) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
}

// failFor picks the HTTP status from the domain error.
func failFor(w http.ResponseWriter, err error) {
	var tooBig *http.MaxBytesError
	switch {
	case errors.Is(err, errExists):
		fail(w, http.StatusConflict, err)
	case errors.Is(err, errNotFound):
		fail(w, http.StatusNotFound, err)
	case errors.As(err, &tooBig):
		fail(w, http.StatusRequestEntityTooLarge, errors.New("file too large"))
	case errors.Is(err, errBadName), errors.Is(err, errBadContent):
		fail(w, http.StatusBadRequest, err)
	default:
		fail(w, http.StatusBadRequest, err)
	}
}

// ---- Client ----

func (a *App) handleShares(w http.ResponseWriter, r *http.Request) {
	type item struct {
		ID    string `json:"id"`
		Name  string `json:"name"`
		Count int    `json:"count"`
		Cover string `json:"cover,omitempty"`
	}
	items := []item{}
	for _, sh := range a.store.List() {
		photos, err := listPhotos(sh.Path)
		if err != nil {
			continue
		}
		it := item{ID: sh.ID, Name: sh.Name, Count: len(photos)}
		if len(photos) > 0 {
			it.Cover = photos[0].Name
		}
		items = append(items, it)
	}
	writeJSON(w, map[string]any{"shares": items, "admin": isLocalRequest(r)})
}

func (a *App) handleList(w http.ResponseWriter, r *http.Request, sh Share) {
	photos, err := listPhotos(sh.Path)
	if err != nil {
		fail(w, http.StatusInternalServerError, errors.New("cannot read the directory"))
		return
	}
	writeJSON(w, map[string]any{"name": sh.Name, "photos": photos})
}

func serveFile(w http.ResponseWriter, r *http.Request, path string) {
	f, err := os.Open(path)
	if err != nil {
		failFor(w, errNotFound)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		failFor(w, errNotFound)
		return
	}
	// URLs carry ?v=<modification time>: the content behind a given URL never changes.
	if r.URL.Query().Has("v") {
		w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	} else {
		w.Header().Set("Cache-Control", "no-cache")
	}
	http.ServeContent(w, r, filepath.Base(path), info.ModTime(), f)
}

func (a *App) handleImage(w http.ResponseWriter, r *http.Request, sh Share) {
	path, _, err := photoFile(sh.Path, r.PathValue("name"))
	if err != nil {
		failFor(w, err)
		return
	}
	serveFile(w, r, path)
}

func (a *App) handleThumb(w http.ResponseWriter, r *http.Request, sh Share) {
	path, info, err := photoFile(sh.Path, r.PathValue("name"))
	if err != nil {
		failFor(w, err)
		return
	}
	thumb, err := thumbnail(a.thumbDir, path, info)
	if err != nil {
		// Go cannot decode this image: let the browser display the original.
		serveFile(w, r, path)
		return
	}
	serveFile(w, r, thumb)
}

// handleSave stores an edited image: a new file, or a replacement with ?overwrite=1.
func (a *App) handleSave(w http.ResponseWriter, r *http.Request, sh Share) {
	mode := saveNew
	if r.URL.Query().Get("overwrite") == "1" {
		mode = saveOverwrite
	}
	name, err := savePhoto(sh.Path, r.PathValue("name"), http.MaxBytesReader(w, r.Body, maxUpload), mode)
	if err != nil {
		failFor(w, err)
		return
	}
	writeJSON(w, map[string]string{"name": name})
}

// handleUpload receives a new photo (raw body). With ?keep=1 the original name
// is kept (import); otherwise the photo is named after the current time.
func (a *App) handleUpload(w http.ResponseWriter, r *http.Request, sh Share) {
	stem := ""
	if r.URL.Query().Get("keep") == "1" {
		stem = sanitizeStem(r.URL.Query().Get("name"))
	}
	if stem == "" {
		stem = "photo-" + time.Now().Format("20060102-150405")
	}
	name, err := savePhoto(sh.Path, stem, http.MaxBytesReader(w, r.Body, maxUpload), saveUnique)
	if err != nil {
		failFor(w, err)
		return
	}
	writeJSON(w, map[string]string{"name": name})
}

func (a *App) handleRename(w http.ResponseWriter, r *http.Request, sh Share) {
	var req struct{ From, To string }
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req); err != nil {
		fail(w, http.StatusBadRequest, errors.New("invalid request"))
		return
	}
	if err := renamePhoto(sh.Path, req.From, strings.TrimSpace(req.To)); err != nil {
		failFor(w, err)
		return
	}
	writeJSON(w, map[string]string{"name": strings.TrimSpace(req.To)})
}

// ---- Administration ----

func (a *App) handleAdminState(w http.ResponseWriter, r *http.Request) {
	type item struct {
		Share
		Count   int  `json:"count"`
		Missing bool `json:"missing"`
	}
	items := []item{}
	for _, sh := range a.store.List() {
		it := item{Share: sh}
		if photos, err := listPhotos(sh.Path); err != nil {
			it.Missing = true
		} else {
			it.Count = len(photos)
		}
		items = append(items, it)
	}
	ips := []string{}
	for _, ip := range lanIPs() {
		ips = append(ips, ip.String())
	}
	home, _ := os.UserHomeDir()
	writeJSON(w, map[string]any{"shares": items, "ips": ips, "port": a.port, "home": home})
}

func (a *App) handleBrowse(w http.ResponseWriter, r *http.Request) {
	path := r.URL.Query().Get("path")
	if path == "" {
		path, _ = os.UserHomeDir()
	}
	path, err := filepath.Abs(path)
	if err != nil {
		fail(w, http.StatusBadRequest, err)
		return
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		fail(w, http.StatusBadRequest, fmt.Errorf("cannot read directory %s", path))
		return
	}
	dirs := []string{}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".") {
			continue
		}
		isDir := e.IsDir()
		if e.Type()&os.ModeSymlink != 0 {
			if info, err := os.Stat(filepath.Join(path, e.Name())); err == nil {
				isDir = info.IsDir()
			}
		}
		if isDir {
			dirs = append(dirs, e.Name())
		}
	}
	sort.Slice(dirs, func(i, j int) bool { return strings.ToLower(dirs[i]) < strings.ToLower(dirs[j]) })
	parent := filepath.Dir(path)
	if parent == path {
		parent = ""
	}
	writeJSON(w, map[string]any{"path": path, "parent": parent, "dirs": dirs, "photos": countPhotos(path)})
}

func (a *App) handleAddShare(w http.ResponseWriter, r *http.Request) {
	var req struct{ Path, Name string }
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192)).Decode(&req); err != nil || req.Path == "" {
		fail(w, http.StatusBadRequest, errors.New("invalid request"))
		return
	}
	sh, err := a.store.Add(req.Path, strings.TrimSpace(req.Name))
	if err != nil {
		fail(w, http.StatusBadRequest, err)
		return
	}
	writeJSON(w, sh)
}

func (a *App) handleRemoveShare(w http.ResponseWriter, r *http.Request) {
	if err := a.store.Remove(r.PathValue("id")); err != nil {
		fail(w, http.StatusNotFound, err)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

// clientURL builds the address clients use; an empty id means the home page.
func (a *App) clientURL(ip, id string) string {
	u := "https://" + net.JoinHostPort(ip, fmt.Sprint(a.port)) + "/"
	if id != "" {
		u += "s/" + id + "/"
	}
	return u
}

// handleQR returns the QR code (PNG) of a share for one of the server's addresses.
func (a *App) handleQR(w http.ResponseWriter, r *http.Request) {
	ip, id := r.URL.Query().Get("ip"), r.URL.Query().Get("id")
	known := false
	for _, have := range lanIPs() {
		known = known || have.String() == ip
	}
	if !known {
		fail(w, http.StatusBadRequest, errors.New("unknown address"))
		return
	}
	if id != "" {
		if _, ok := a.store.Get(id); !ok {
			fail(w, http.StatusNotFound, errors.New("unknown share"))
			return
		}
	}
	png, err := qrcode.Encode(a.clientURL(ip, id), qrcode.Medium, 480)
	if err != nil {
		fail(w, http.StatusInternalServerError, err)
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "no-store")
	w.Write(png)
}
