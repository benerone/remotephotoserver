// remotephotoserver shares photo directories on the local network over
// self-signed HTTPS; clients view, take and edit photos from their browser.
package main

import (
	"bytes"
	"crypto/tls"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

// filteredLog drops TLS handshake errors from the log: every client that has
// not yet accepted the self-signed certificate produces one.
type filteredLog struct{}

func (filteredLog) Write(p []byte) (int, error) {
	if !bytes.Contains(p, []byte("TLS handshake error")) {
		os.Stderr.Write(p)
	}
	return len(p), nil
}

func main() {
	port := flag.Int("port", 8443, "HTTPS listening port")
	dataDir := flag.String("data", "", "configuration directory (default: ~/.config/remotephotoserver)")
	flag.Parse()

	if *dataDir == "" {
		base, err := os.UserConfigDir()
		if err != nil {
			log.Fatalf("cannot locate the configuration directory: %v", err)
		}
		*dataDir = filepath.Join(base, "remotephotoserver")
	}
	if err := os.MkdirAll(*dataDir, 0o700); err != nil {
		log.Fatal(err)
	}
	cacheBase, err := os.UserCacheDir()
	if err != nil {
		cacheBase = *dataDir
	}
	thumbDir := filepath.Join(cacheBase, "remotephotoserver", "thumbs")
	if err := os.MkdirAll(thumbDir, 0o700); err != nil {
		log.Fatal(err)
	}

	store, err := openStore(filepath.Join(*dataDir, "config.json"))
	if err != nil {
		log.Fatalf("reading the configuration: %v", err)
	}
	cert, err := loadOrCreateCert(*dataDir, lanIPs())
	if err != nil {
		log.Fatalf("certificate: %v", err)
	}

	app := &App{store: store, port: *port, thumbDir: thumbDir}
	srv := &http.Server{
		Addr:              fmt.Sprintf(":%d", *port),
		Handler:           app.routes(),
		TLSConfig:         &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12},
		ReadHeaderTimeout: 10 * time.Second,
		ErrorLog:          log.New(filteredLog{}, "", log.LstdFlags),
	}

	fmt.Printf("Administration (this machine only): https://localhost:%d/admin\n", *port)
	ips := lanIPs()
	if len(ips) == 0 {
		fmt.Println("No local network address found: clients will not be able to connect.")
	}
	for _, ip := range ips {
		fmt.Printf("Client access (local network): https://%s\n", net.JoinHostPort(ip.String(), fmt.Sprint(*port)))
	}
	log.Fatal(srv.ListenAndServeTLS("", ""))
}
