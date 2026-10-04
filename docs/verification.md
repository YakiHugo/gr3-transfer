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


## Additional synthetic retry/ZIP QA, October 3, 2026

A local follow-on to draft PR #1 found a stale partial-archive issue: after five of six transfers succeeded, preparing a ZIP and then successfully retrying the sixth file left the earlier five-file ZIP available. The scoped fix invalidates an existing archive whenever a transfer queue starts, including retries. A regression test verifies that the old archive disappears and the next archive contains all six ready entries.

The revised local code passes **85/85** checks (47 bridge/protocol/security, 9 packaging, 29 DOM interaction), plus syntax and whitespace checks. Added cases cover cancelled-file retry without restarting the rest of the cancelled queue, archive URL-allocation failure and recovery, and a two-session, 24-JPEG transfer followed by offline ZIP handoff and immediate tray clearing.

For independent archive decoding, Python 3 is optional:

```sh
RUN_PYTHON_ZIP_AUDIT=1 npm run check
```

This additional audit decodes the ZIP produced through the DOM transfer flow with Python's standard-library `zipfile`: all 24 JPEGs match their synthetic source bytes, CRC checks pass, SHA-256 and byte lengths match the manifest, and the two source sessions have separate archive paths. Ordinary `npm run check` remains Node-only.

These remain local synthetic HTTP/DOM and in-memory handoff checks. No physical camera, real browser rendering, phone transfer, or actual browser save to disk was verified. This follow-on is not evidence of a push, merge, CI run, or deployment.

## Batch recovery QA, October 4, 2026

The one-action **Retry unfinished (N)** flow passes **94/94** checks (47 bridge/protocol/security, 9 packaging, 38 DOM interaction) on Node.js 24.19.0, plus syntax and whitespace checks. `npm run test:core` independently passes 56/56. `RUN_PYTHON_ZIP_AUDIT=1 npm run check` also passes the existing 24-JPEG independent Python ZIP CRC, source-byte and SHA-256 audit.

Nine added regression scenarios verify:

- Cancel after one complete original, then explicitly retry the remaining 11 in one action; repeated clicks issue no duplicate reads, and all 12 final Blob payloads match their source fixtures
- Mixed old-session, stale-response, exhausted and retryable entries; only the eligible current-session file restarts, including attempts through detached individual Retry buttons
- Partial ZIP invalidation before batch recovery, with ready and already handed-off JPEG Blobs retained; replacement ZIP includes the recovered files
- Retry guards while ZIP preparation is active; cancellation and Clear correctly reset recovery controls
- Repeated transfer cancellation respects the three-attempt cap while keeping never-attempted files eligible
- The injected camera-protocol path (CameraAdapter → bridge → DOM), with a simulated Wi-Fi failure: only the missing original is fetched again, all reads remain GET requests, no resized variant is requested, and each final JPEG matches its source fixture
- A saved partial ZIP keeps its separate browser-download lease through retry, archive rebuilding and Clear, until the grace period expires
- An old individual Retry handle cannot revive a removed entry
- Delayed abort cleanup after a failed Disconnect cannot overwrite a newer successful retry or hide its individual Save action; the regression reproduced the original failure before the generation/attempt ownership guard was added

Manual acceptance additions: interrupt Wi-Fi without disconnecting the app session, restore camera Wi-Fi, and use Retry unfinished; then explicitly cancel and recover a partial batch. Check that the displayed count matches the restarted files, previous ready files are not transferred again, and any old partial ZIP must be prepared again. Separately test Disconnect/reconnect: old unfinished entries must require reselection. These checks are still pending on hardware and in an actual browser.

The product rationale and official comparison sources are in [batch-recovery.md](batch-recovery.md). No browser/OS Wi-Fi changes, camera mutations, new model support, background retries, persistent transfer history, HTTP Range resumption or verified save-to-disk behavior were added.

## Large-card gallery performance, October 4, 2026

The adapter permits 50,000 JPEGs, but the previous gallery rebuilt its filtered/sorted list on each selection and page change. A gallery render called it twice. Numeric `localeCompare` options were also processed for each sort comparison. On a shuffled synthetic 50,000-frame card, this froze the synchronous derivation for seconds even when the list had not changed.

The gallery now reuses two locale collators and caches one derived list, keyed by source-array identity, normalized search, folder and sort. Refresh/session changes replace the source array; disconnected/error/pagehide paths explicitly release the cache. No photo bytes or additional image payloads are cached. Selection and page changes reuse the list; filter changes replace it. The DOM still renders only 24 cards per page.

Repeatable measurement on Node.js 24.19.0, same container, `node scripts/benchmark-gallery.mjs [path-to-baseline-app.js]`:

| Derivation | Before | After |
| --- | ---: | ---: |
| Initial 50,000-frame filter/sort | 2855.209 ms | 220.482 ms |
| Repeated unchanged derivations (3) | 2829.273 / 2744.822 / 2749.706 ms | 0.100 / 0.023 / 0.020 ms |

These are one-run local microbenchmarks, not a browser-frame-rate, mobile-device, camera-transfer-speed or memory-usage claim. Exact timings vary. The deterministic regression asserts that 48 selection/page interactions perform **zero additional sorting comparisons**. Initial derivation still runs synchronously; selection summaries still scan the photo list. Further work should be guided by actual-browser profiling.

`RUN_PYTHON_ZIP_AUDIT=1 npm run check` passes **98/98** checks (47 bridge/protocol/security, 9 packaging, 3 gallery derivation, 39 DOM interaction), including the existing 24-JPEG independent Python ZIP/source-byte/CRC/SHA-256 audit. `npm run test:core` includes the new dependency-free gallery regressions. New coverage checks numeric/folder tie ordering, unknown metadata, non-mutating sorting, full-card cache reuse, filter/sort/source replacement invalidation, refresh metadata and selection pruning, page clamping, and reconnect source replacement.

No camera writes, network exposure, RAW support, new camera support, real-browser/mobile validation or save-to-disk claims were introduced. No CI configuration exists; these are local checks.

## Repeatable pull-request checks

`.github/workflows/verify.yml` runs the pinned DOM dependency install and complete
`npm run check` on Node.js 22 and 24 for pull requests and main-branch updates.
The jobs use read-only repository permission, no secrets, no install scripts,
a ten-minute timeout, and a serial matrix. They also print the synthetic
50,000-frame gallery benchmark; its timings are informational, not a hardware
throughput claim or a flaky performance threshold.

Run the same checks locally with `npm ci --ignore-scripts` followed by
`npm run check` and `node scripts/benchmark-gallery.mjs`. Fixture and injected
protocol tests never intentionally contact a physical camera. GitHub Actions
success still does not establish physical GR III compatibility, real browser
rendering, mobile connectivity, or a successful disk/Photos save. Inspect the
workflow run for the PR's exact final head before merging; a local pass is not
proof that hosted CI ran.

Connection cancellation: the connection dialog has an explicit Cancel action.
Close, Escape and backdrop dismissal stop pending work. The bridge aborts a
camera connection if its requesting browser connection disappears, and ignores
late camera responses. Cancellation keeps ready JPEGs in the tab; a failed
bridge-disconnect acknowledgement is reported rather than presented as success.
