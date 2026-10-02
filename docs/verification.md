# Verification and hardware handoff

## Evidence boundary

Everything in this workspace was tested with wholly synthetic JPEGs and injected camera responses. No user photos, physical GR III, macOS machine or real phone were available. Do not describe the fixture tests as hardware tests or deployment.

## Automated checks

Reliability-pass check on October 2, 2026: **81/81 passing** (47 bridge/protocol/security checks, 9 file-packaging checks and 25 DOM interaction checks), plus JavaScript syntax checks, using Node.js 24.19.0. See `test-results.txt`. A separately generated 12-JPEG ZIP also passed Python standard-library `zipfile` decoding/CRC checks, source-byte equality, SHA-256 manifest comparisons and embedded fixture metadata checks. This is synthetic archive evidence, not an actual browser download. An earlier clean-copy check also passed 47/47 dependency-free tests, and its CLI startup served all static assets, disconnected state, demo connection, 12-photo listing and thumbnail/preview/original responses successfully. These counts do not include any real-browser or hardware test.

Run `npm run test:core` for dependency-free Node unit/integration suites. Install pinned development dependencies with `npm ci --ignore-scripts`, then run `npm test` for all suites, including Happy DOM interaction tests. They cover:

- Published camera list shape, JPEG-only filtering and exact model detection
- Safe projection of properties that can otherwise contain Wi-Fi keys, GPS or serials
- Fixed destination, GET-only allowlist, original query semantics and redirect rejection
- SHA-256 equality of synthetic original source versus downloaded bytes; EXIF preservation
- Byte splits, incomplete streams, malformed JPEG structure and size limits
- Same-origin/Host/fetch-site/CSRF controls, unknown routes and forbidden methods
- Connection/refresh cancellation, stale image URLs and serialized reads
- Demo isolation: no camera fetches

`npm run check` additionally checks JavaScript syntax. The server has no runtime dependencies. DOM tests use the pinned Happy DOM development dependency.

DOM interaction coverage includes search, sorting, folder filters, selection, pagination, modal close/reopen, unchanged Blob data, explicit Save handoff, cancellation, interruption/retry limits, invalid/oversized responses, safe text rendering, failed camera connection reconciliation, memory cleanup, mobile-transfer control wiring, unknown-metadata labels and simulated Back/Forward lifecycle restoration. Browser layout, mobile viewport behavior and actual save-to-disk are not established by these tests.

New regression coverage includes preserving completed files through active disconnect, session-scoped deduplication after reconnect, failed camera switches, stale-source retry prevention, archive save/cancel/clear, folder-scoped filenames, duplicate archive paths, declared memory/count limits object-URL allocation failure, and delayed release of browser download links when a user immediately clears the tray. The ZIP builder yields between 1 MiB CRC chunks and processes one source file at a time.

## Browser verification status

Desktop/mobile visual QA remains pending because the available browser could not open the loopback address. There is no verified UI screenshot. The local HTTP/API and DOM tests passed independently; they do not establish real-browser behavior, layout, or save-to-disk results.

## Public-source audit

The publication includes application code, tests, documentation, and 12 generated synthetic scenes with preview/thumbnail derivatives. Checks found no credential tokens, private keys, personal email addresses, private workspace paths, GPS tags, or camera serial numbers in the published files. Sensitive-property strings in tests are dummy values used to check that those properties never escape the adapter. Dependencies, caches, and local tool metadata are excluded. No CI workflow or hosted deployment is included.

## Manual GR III acceptance checklist (pending)

1. Confirm the device reports `RICOH GR III`; record firmware version without serial/Wi-Fi key/GPS.
2. On a computer joined to camera Wi-Fi, connect and compare displayed folders/JPEG count to the card. RAW/movie files should not appear.
3. Transfer one small and one full-resolution JPEG. Independently compare SHA-256 against the same originals copied from the card; inspect JPEG dimensions and EXIF/image-control look.
4. Try several selected originals, including same-named JPEGs in different folders. Verify individual saves and a ZIP save; extract the ZIP and compare every file against its SHA-256 manifest and card-reader original.
5. Interrupt Wi-Fi during transfer, then reconnect/retry. An incomplete file must not become a successful Save item.
6. Disconnect during a batch; confirm ready originals remain saveable and incomplete ones stop. Cancel ZIP preparation and retry it. Reconnect/refresh, and close/reopen previews. Old session responses must not populate the new gallery.
7. Confirm the camera remains on and no file/transfer status/settings changed.
8. Test a large card and measure thumbnail/download speed. Real list metadata, concurrency and timeout behavior may need firmware-specific adjustment.
9. Evaluate an explicitly authorized phone networking approach before attempting real phone transfers. Validate Android and iOS download/import behavior separately.

## Deliberately outside this build

BLE pairing/wake, direct native phone transfers, exposed LAN/QR sharing, cloud upload, background sync, resumable ranges, camera mutations, RAW processing, other camera models, or remote deployment.
