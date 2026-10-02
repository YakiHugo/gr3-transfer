# GR III Transfer

A small, self-hostable **Ricoh GR III** JPEG-transfer prototype: browse a contact sheet, select originals, transfer with progress, and save them through your browser. The camera's JPEG rendering, EXIF and other bytes are passed through unchanged.

**Status:** a working local prototype with synthetic fixtures and a community-protocol adapter. **No physical camera, Mac or phone has been tested.** This is not a Ricoh product or an official API client.

## Run

Requires Node.js 22 or newer. No runtime packages, account, API key, build step or Internet connection are needed.

```sh
git clone https://github.com/YakiHugo/gr3-transfer.git
cd gr3-transfer
npm start
```

Open **http://127.0.0.1:4317** on the same computer. The app starts disconnected. **Try demo** uses 12 generated geometric JPEGs, never your photos. To use a different local port: `PORT=4318 npm start`.

## Connect a GR III

1. Start the bridge on the computer you want to receive the photos.
2. Turn on the GR III's wireless LAN and join its Wi-Fi network through your computer's normal Wi-Fi settings. Use the network/password shown by your camera. This network may have no Internet access.
3. Keep the camera awake and close other apps communicating with it.
4. In the local browser page, choose **Connect GR III**. The bridge checks the device model and lists JPEGs.
5. Browse/select images, transfer selected originals, then use each file's **Save** button. Confirm the files appear in your browser's Downloads destination. The app cannot verify that the browser saved them to disk.

Only an exact normalized `RICOH GR III` device identity is accepted. IIIx, IV and other cameras are intentionally outside this prototype. Unknown firmware response shapes fail with a visible error. No automatic Wi-Fi/Bluetooth configuration is attempted.

## What is implemented

- Responsive desktop/phone-width gallery, previews, selection and filters
- Explicit disconnected, synthetic-demo and real-camera modes
- Read-only Wi-Fi adapter, filename filtering and sequential camera reads
- Original JPEG transfers without resizing, conversion or EXIF rewriting
- Per-file progress, cancellation and manual retry; interrupted files are not offered for saving
- Byte-length and incremental JPEG marker validation before a transfer completes
- Synthetic original/thumbnail fixtures and automated regression tests
- All application assets served locally, with no external analytics or font requests

## Phone scope

The layout adapts to a phone screen. **A real phone cannot reach a bridge bound to another computer's localhost.** This version deliberately binds only to `127.0.0.1`; it does not expose LAN access, create a tunnel or configure a firewall. A separately reviewed/authorized LAN or native-phone path is still needed for real phone transfers. No QR pairing is faked. Mobile file downloads also depend on the browser; saving to Files/Downloads is distinct from importing into Photos.

## Original JPEG guarantee and limits

Original requests use `/v1/photos/{folder}/{filename}` with **no `size` query**. Gallery thumbnails use `?size=thumb`; larger previews use `?size=view`. Byte-preservation tests compare hashes and embedded fixture metadata, including split HTTP chunks. The bridge does not recompress, rotate, strip metadata, apply looks or convert RAW. Any camera look already baked into the original JPEG stays in those bytes.

Marker validation detects incomplete segments, missing frame/scan markers and false end markers inside EXIF thumbnails. It is not a full entropy decoder, a cryptographic camera-origin guarantee or proof of an actual camera transfer. There is no camera-provided checksum available in the researched API. A 128 MiB per-file limit protects memory/resource use; failed/cancelled transfers restart from the beginning. HTTP Range/resume support is not assumed.

Browser transfer status is local to the current session, not the camera's official transfer flag or a durable backup index. Filenames can repeat across folders; check destination names when saving. This prototype does not silently overwrite a chosen filesystem directory or remove anything from the camera.

## Safety

- Fixed camera target: `http://192.168.0.1`; no generic proxy or user-configurable URL
- Allowlisted GET reads only: camera properties, full photo list, original/thumbnail JPEGs
- No deletion, capture, power-off, transfer-flag writes, firmware or camera-setting changes
- Loopback binding with strict Host, Origin, fetch-site, CSRF, CSP and no-store controls
- No redirects from camera responses; unexpected response encodings are rejected
- Only safe camera properties are exposed. Wi-Fi keys, GPS, serials and MAC addresses are not returned/logged
- JPEGs stream through memory and are not written to bridge storage or uploaded anywhere
- Disconnect/reconnect invalidates old download URLs and cancels queued camera reads

This local prototype is not a hardened multi-user or Internet-facing service. Its current protections intentionally reject remote use. Do not change the bind address to work around them.

## Verify

```sh
npm run test:core           # no packages needed
npm ci --ignore-scripts      # installs dev-only DOM test dependency
npm test
npm run check
```

Tests use injected fake camera responses and local synthetic files. They never contact `192.168.0.1`. Happy DOM is a pinned development-only dependency for interaction tests, not a real-browser or visual test. Starting the app does not require installing it. See [docs/verification.md](docs/verification.md) for completed checks and the pending hardware checklist.

## Protocol evidence

Ricoh officially documents GR III support and wireless-LAN image import in [GR WORLD](https://www.ricoh-imaging.co.jp/english/products/app/gr-world/). It does **not** document this HTTP API.

The adapter was independently written using these read-only references, researched October 1, 2026:

- [Community OpenAPI specification](https://github.com/CursedHardware/ricoh-wireless-protocol/blob/main/openapi.yaml): `/v1/props`, directory/file-string listing and original/thumbnail request shapes
- [GRsync implementation](https://github.com/clyang/GRsync/blob/master/GRsync.py): explicit GR III support and original downloads without a size parameter
- [Requested feasibility reference](https://github.com/Nielk74/ricoh-gr3-android/blob/main/research/FEASIBILITY.md): orientation and references, not hardware validation of this prototype

The unofficial protocol may differ by firmware. No external repository code was executed. Photo transfers use Wi-Fi, not Bluetooth. List pagination is not guessed: this version requests the full directory listing and filters JPEGs locally; the published `after` field is a date-time filter, not a verified filename cursor.
