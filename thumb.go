// SPDX-License-Identifier: LGPL-2.1-only
// Copyright (C) 2026 benerone
// This file is part of remotephotoserver; see the LICENSE file for the terms.

package main

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	"image/jpeg"
	_ "image/png"
	"io"
	"os"
	"path/filepath"
	"runtime"

	xdraw "golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
)

const (
	thumbSize      = 480
	maxThumbPixels = 120_000_000 // refuse to decode anything larger
)

var thumbSem = make(chan struct{}, max(1, runtime.NumCPU()/2))

// thumbnail returns the path of the JPEG thumbnail of src, creating it if
// needed. The cache is keyed by path, time and size, so a modified photo gets
// a new thumbnail.
func thumbnail(cacheDir, src string, info os.FileInfo) (string, error) {
	sum := sha256.Sum256(fmt.Appendf(nil, "%s|%d|%d", src, info.ModTime().UnixNano(), info.Size()))
	out := filepath.Join(cacheDir, hex.EncodeToString(sum[:16])+".jpg")
	if _, err := os.Stat(out); err == nil {
		return out, nil
	}

	thumbSem <- struct{}{}
	defer func() { <-thumbSem }()

	f, err := os.Open(src)
	if err != nil {
		return "", err
	}
	defer f.Close()
	cfg, _, err := image.DecodeConfig(f)
	if err != nil {
		return "", err
	}
	if cfg.Width*cfg.Height > maxThumbPixels {
		return "", errors.New("image too large")
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return "", err
	}
	orientation := exifOrientation(f)
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return "", err
	}
	img, _, err := image.Decode(f)
	if err != nil {
		return "", err
	}

	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	if w > thumbSize || h > thumbSize {
		if w >= h {
			w, h = thumbSize, max(1, h*thumbSize/w)
		} else {
			w, h = max(1, w*thumbSize/h), thumbSize
		}
	}
	small := image.NewRGBA(image.Rect(0, 0, w, h))
	xdraw.Draw(small, small.Bounds(), image.White, image.Point{}, xdraw.Src)
	xdraw.BiLinear.Scale(small, small.Bounds(), img, b, xdraw.Over, nil)
	small = orient(small, orientation)

	tmp, err := os.CreateTemp(cacheDir, "tmp-*")
	if err != nil {
		return "", err
	}
	defer os.Remove(tmp.Name())
	if err := jpeg.Encode(tmp, small, &jpeg.Options{Quality: 82}); err != nil {
		tmp.Close()
		return "", err
	}
	if err := tmp.Close(); err != nil {
		return "", err
	}
	return out, os.Rename(tmp.Name(), out)
}

// exifOrientation reads the EXIF orientation (1 to 8) of a JPEG; 1 if absent.
func exifOrientation(r io.Reader) int {
	buf := make([]byte, 256<<10)
	n, _ := io.ReadFull(r, buf)
	buf = buf[:n]
	if len(buf) < 4 || buf[0] != 0xFF || buf[1] != 0xD8 {
		return 1
	}
	for i := 2; i+4 <= len(buf); {
		if buf[i] != 0xFF {
			return 1
		}
		marker := buf[i+1]
		if marker == 0xDA || marker == 0xD9 {
			return 1
		}
		size := int(binary.BigEndian.Uint16(buf[i+2:]))
		if size < 2 || i+2+size > len(buf) {
			return 1
		}
		seg := buf[i+4 : i+2+size]
		i += 2 + size
		if marker != 0xE1 || len(seg) < 14 || string(seg[:6]) != "Exif\x00\x00" {
			continue
		}
		tiff := seg[6:]
		var bo binary.ByteOrder
		switch string(tiff[:2]) {
		case "II":
			bo = binary.LittleEndian
		case "MM":
			bo = binary.BigEndian
		default:
			return 1
		}
		off := int(bo.Uint32(tiff[4:]))
		if off < 8 || off+2 > len(tiff) {
			return 1
		}
		count := int(bo.Uint16(tiff[off:]))
		for e := 0; e < count; e++ {
			p := off + 2 + e*12
			if p+12 > len(tiff) {
				return 1
			}
			if bo.Uint16(tiff[p:]) == 0x0112 {
				if o := int(bo.Uint16(tiff[p+8:])); o >= 1 && o <= 8 {
					return o
				}
				return 1
			}
		}
		return 1
	}
	return 1
}

// orient applies the EXIF orientation to the image.
func orient(src *image.RGBA, o int) *image.RGBA {
	if o <= 1 || o > 8 {
		return src
	}
	w, h := src.Bounds().Dx(), src.Bounds().Dy()
	dw, dh := w, h
	if o >= 5 {
		dw, dh = h, w
	}
	dst := image.NewRGBA(image.Rect(0, 0, dw, dh))
	for y := 0; y < dh; y++ {
		for x := 0; x < dw; x++ {
			var sx, sy int
			switch o {
			case 2:
				sx, sy = w-1-x, y
			case 3:
				sx, sy = w-1-x, h-1-y
			case 4:
				sx, sy = x, h-1-y
			case 5:
				sx, sy = y, x
			case 6:
				sx, sy = y, h-1-x
			case 7:
				sx, sy = w-1-y, h-1-x
			case 8:
				sx, sy = w-1-y, x
			}
			dst.SetRGBA(x, y, src.RGBAAt(sx, sy))
		}
	}
	return dst
}
