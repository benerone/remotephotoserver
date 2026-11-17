// SPDX-License-Identifier: LGPL-2.1-only
// Copyright (C) 2026 benerone
// This file is part of remotephotoserver; see the LICENSE file for the terms.

package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
)

// Share is a shared directory. Its random ID is its address (/s/<id>/) and
// is what the QR code encodes.
type Share struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	Path string `json:"path"`
}

type Store struct {
	mu     sync.RWMutex
	file   string
	shares []Share
}

func openStore(file string) (*Store, error) {
	s := &Store{file: file}
	data, err := os.ReadFile(file)
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return nil, err
	}
	var cfg struct {
		Shares []Share `json:"shares"`
	}
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, err
	}
	s.shares = cfg.Shares
	return s, nil
}

func (s *Store) saveLocked() error {
	data, err := json.MarshalIndent(struct {
		Shares []Share `json:"shares"`
	}{s.shares}, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.file + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.file)
}

func (s *Store) List() []Share {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return append([]Share(nil), s.shares...)
}

func (s *Store) Get(id string) (Share, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, sh := range s.shares {
		if sh.ID == id {
			return sh, true
		}
	}
	return Share{}, false
}

// Add shares a directory; an already shared directory is returned as is.
func (s *Store) Add(path, name string) (Share, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return Share{}, err
	}
	info, err := os.Stat(abs)
	if err != nil {
		return Share{}, err
	}
	if !info.IsDir() {
		return Share{}, errors.New("this path is not a directory")
	}
	if name == "" {
		name = filepath.Base(abs)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, sh := range s.shares {
		if sh.Path == abs {
			return sh, nil
		}
	}
	buf := make([]byte, 8)
	if _, err := rand.Read(buf); err != nil {
		return Share{}, err
	}
	sh := Share{ID: hex.EncodeToString(buf), Name: name, Path: abs}
	s.shares = append(s.shares, sh)
	return sh, s.saveLocked()
}

func (s *Store) Remove(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, sh := range s.shares {
		if sh.ID == id {
			s.shares = append(s.shares[:i], s.shares[i+1:]...)
			return s.saveLocked()
		}
	}
	return errors.New("unknown share")
}
