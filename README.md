# remotephotoserver

A local web server (LAN only, self-signed HTTPS) that shares photo directories with a phone: browse the photos, take new ones and edit them, all from the phone's browser.

## Usage

```bash
go build -o remotephotoserver .
./remotephotoserver
```

1. On the machine running the server, open `https://localhost:8443/admin` and accept the certificate warning.
2. Pick a directory and click "Share this directory": a QR code appears.
3. Scan the QR code with a phone on the same network and proceed past the "Your connection is not private" warning.

The admin page is only reachable from the host machine. The user interface is in English, or in French when the browser's language is French.

Options: `-port 8443`, `-data <configuration directory>` (default `~/.config/remotephotoserver`).

## What a client can do on a shared directory

- View every photo (thumbnail grid, full-screen viewer).
- Take a new photo with the phone's camera ("📷 Photo") or import existing ones.
- Rename a photo.
- Edit a photo:
  - pencil annotations, 5 colours and 5 sizes;
  - crop;
  - perspective crop ("Perspective"): place the four corners on a sheet photographed at an angle to get it back as a rectangle;
  - zoom for precise work: pinch with two fingers (which also pans), use the mouse wheel, or the −/+ buttons;
  - undo.
- Save over the original ("Save") or as a new image ("Save as…").

## Notes

- Requests from non-private addresses are rejected.
- A share is flat: subdirectories are not shown. Supported formats: JPEG, PNG, GIF, WebP.
- Clients cannot delete photos.
- The certificate is kept in the configuration directory, so a phone only has to accept it again when the server's address changes.

## Development

```bash
go test ./...
go vet ./... && gofmt -l .
```
