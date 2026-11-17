package main

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"unicode"
	"unicode/utf8"
)

var (
	errBadName    = errors.New("invalid file name")
	errBadContent = errors.New("the content is not a supported image (JPEG, PNG, GIF, WebP)")
	errExists     = errors.New("a file with this name already exists")
	errNotFound   = errors.New("photo not found")
)

// extKind maps each accepted extension to the content type it must hold.
var extKind = map[string]string{
	".jpg":  "image/jpeg",
	".jpeg": "image/jpeg",
	".png":  "image/png",
	".gif":  "image/gif",
	".webp": "image/webp",
}

var kindExt = map[string]string{
	"image/jpeg": ".jpg",
	"image/png":  ".png",
	"image/gif":  ".gif",
	"image/webp": ".webp",
}

// writeMu serializes writes so that "check, then rename" is atomic.
var writeMu sync.Mutex

type Photo struct {
	Name  string `json:"name"`
	Size  int64  `json:"size"`
	MTime int64  `json:"mtime"` // Unix milliseconds
}

func nameKind(name string) string {
	return extKind[strings.ToLower(filepath.Ext(name))]
}

// validName only accepts a plain file name: no separator, no hidden file, a
// known image extension. Every disk access goes through it; this is what keeps
// clients inside the shared directory.
func validName(name string) error {
	if name == "" || len(name) > 200 || !utf8.ValidString(name) || strings.HasPrefix(name, ".") {
		return errBadName
	}
	for _, r := range name {
		if unicode.IsControl(r) || strings.ContainsRune(`/\<>:"|?*`, r) {
			return errBadName
		}
	}
	if name != filepath.Base(name) || nameKind(name) == "" {
		return errBadName
	}
	if strings.TrimSpace(strings.TrimSuffix(name, filepath.Ext(name))) == "" {
		return errBadName
	}
	return nil
}

// sanitizeStem makes the name (without extension) of an imported file usable.
func sanitizeStem(name string) string {
	name = strings.ToValidUTF8(name, "_")
	if i := strings.LastIndexAny(name, `/\`); i >= 0 {
		name = name[i+1:]
	}
	name = strings.TrimSuffix(name, filepath.Ext(name))
	name = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || strings.ContainsRune(`/\<>:"|?*`, r) {
			return '_'
		}
		return r
	}, name)
	name = strings.TrimSpace(strings.TrimLeft(name, "."))
	if len(name) > 120 {
		name = strings.ToValidUTF8(name[:120], "")
	}
	return name
}

func listPhotos(dir string) ([]Photo, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	photos := []Photo{}
	for _, e := range entries {
		if !e.Type().IsRegular() || validName(e.Name()) != nil {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		photos = append(photos, Photo{Name: e.Name(), Size: info.Size(), MTime: info.ModTime().UnixMilli()})
	}
	sort.Slice(photos, func(i, j int) bool {
		if photos[i].MTime != photos[j].MTime {
			return photos[i].MTime > photos[j].MTime
		}
		return photos[i].Name < photos[j].Name
	})
	return photos, nil
}

func countPhotos(dir string) int {
	photos, _ := listPhotos(dir)
	return len(photos)
}

// photoFile returns the path of an existing photo (regular file, not a symlink).
func photoFile(dir, name string) (string, os.FileInfo, error) {
	if err := validName(name); err != nil {
		return "", nil, err
	}
	p := filepath.Join(dir, name)
	info, err := os.Lstat(p)
	if err != nil || !info.Mode().IsRegular() {
		return "", nil, errNotFound
	}
	return p, info, nil
}

func exists(p string) bool {
	_, err := os.Lstat(p)
	return err == nil
}

// freeName returns stem+ext, or stem-1, stem-2… when the name is taken.
func freeName(dir, stem, ext string) string {
	name := stem + ext
	for i := 1; exists(filepath.Join(dir, name)); i++ {
		name = fmt.Sprintf("%s-%d%s", stem, i, ext)
	}
	return name
}

type saveMode int

const (
	saveNew       saveMode = iota // fails if the name exists
	saveOverwrite                 // replaces the existing file
	saveUnique                    // name has no extension: it comes from the content, and a suffix avoids collisions
)

// savePhoto writes an image into dir through a temporary file and a rename,
// after checking that the content really is an image.
func savePhoto(dir, name string, body io.Reader, mode saveMode) (string, error) {
	head := make([]byte, 512)
	n, err := io.ReadFull(body, head)
	if err != nil && err != io.ErrUnexpectedEOF {
		return "", errBadContent
	}
	head = head[:n]
	kind := http.DetectContentType(head)
	ext, ok := kindExt[kind]
	if !ok {
		return "", errBadContent
	}
	if mode != saveUnique {
		if err := validName(name); err != nil {
			return "", err
		}
		if nameKind(name) != kind {
			return "", fmt.Errorf("the extension of %q does not match its content (%s)", name, kind)
		}
	}

	tmp, err := os.CreateTemp(dir, ".rps-*.tmp")
	if err != nil {
		return "", err
	}
	defer os.Remove(tmp.Name())
	if _, err := io.Copy(tmp, io.MultiReader(bytes.NewReader(head), body)); err != nil {
		tmp.Close()
		return "", err
	}
	if err := tmp.Close(); err != nil {
		return "", err
	}
	os.Chmod(tmp.Name(), 0o644)

	writeMu.Lock()
	defer writeMu.Unlock()
	switch mode {
	case saveUnique:
		name = freeName(dir, name, ext)
	case saveNew:
		if exists(filepath.Join(dir, name)) {
			return "", errExists
		}
	case saveOverwrite:
		if info, err := os.Lstat(filepath.Join(dir, name)); err == nil && !info.Mode().IsRegular() {
			return "", errBadName
		}
	}
	if err := os.Rename(tmp.Name(), filepath.Join(dir, name)); err != nil {
		return "", err
	}
	return name, nil
}

// renamePhoto renames without changing the extension or overwriting a file.
func renamePhoto(dir, from, to string) error {
	if err := validName(to); err != nil {
		return err
	}
	if !strings.EqualFold(filepath.Ext(from), filepath.Ext(to)) {
		return errors.New("the extension cannot be changed")
	}
	writeMu.Lock()
	defer writeMu.Unlock()
	src, _, err := photoFile(dir, from)
	if err != nil {
		return err
	}
	dst := filepath.Join(dir, to)
	if exists(dst) {
		return errExists
	}
	return os.Rename(src, dst)
}
