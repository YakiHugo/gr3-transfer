# GR Relay: product and transport audit
Date: 2026-10-20. Scope: desktop/browser JPEG workflow, not a new release.

## Product references and decisions
This is a review of primary product descriptions and published protocol/source material, not hands-on testing of those apps. Their artwork, screenshots and code are not copied into this project.

- [RICOH GR WORLD](https://www.ricoh-imaging.co.jp/english/products/app/gr-world/) separates camera connection, image import and a local image experience. GR Relay uses that task sequence, but deliberately excludes remote shutter, firmware and recipe controls.
- [Image Sync](https://www.ricoh-imaging.co.jp/english/products/app/image-sync2/) offers image browsing/copying alongside camera control. Its broader feature set is not a reason to crowd a transfer-only screen. We keep the contact sheet prominent and advanced details secondary.
- [GR Viewer](https://apps.apple.com/us/app/gr-viewer-for-gr2-gr3/id941671702) describes multi-selection and distinct camera-roll/in-app destinations. GR Relay makes destination state explicit: received into temporary memory, then handed to the browser, then user verification on disk. We do not imply the browser can certify the final disk write.
- [GR Link](https://gr-link.liljackson.org/) describes batch download, preview and direct connection, among many unrelated camera features. The transferable idea is a photo-first workflow with visible batch status, not copying its native pairing or background-transfer claims.

### Implemented experience
1. Graphite camera-like masthead, warm contact-sheet surface, restrained rust signal colour and consistent square-ish controls replace the generic dashboard styling.
2. A three-step journey and state-derived next action distinguish selection, active transfer, interruption, pending save and browser handoff.
3. Uncropped 3:2 thumbnail frames offer comfortable/compact density without changing source files or making extra original requests.
4. A paginated selection review shows chosen frames across folders and filters, with explicit per-frame removal and one transfer action.
5. Full-width transfer desk separates the gallery from the received-file list. It has honest received-file counts, batch progress, preserved retry/pause controls and clear save actions.
6. Gallery state chips explain which frames are queued, transferring, waiting to be saved, handed to the browser or interrupted. Already queued selections cannot accidentally start a duplicate transfer.
7. Mobile-width layouts retain a useful route to transfer/save records after selection is cleared. Battery is shown only when the camera returned it.

## Open-source transport evaluation
### GRsync (MIT)
[Repository](https://github.com/clyang/GRsync), [source](https://github.com/clyang/GRsync/blob/master/GRsync.py), [license](https://github.com/clyang/GRsync/blob/master/LICENSE).
Useful evidence: fixed camera address, properties/list endpoints and original-photo URL construction. Not a drop-in dependency: the inspected script calls camera shutdown after a full transfer and skips existing local filenames without validating their contents. Both are poor matches for this application's strictly read-only, integrity-first workflow. No code is vendored.

### Tote (GPLv3)
[Repository](https://github.com/brianmichel/Tote), [API documentation](https://github.com/brianmichel/Tote/wiki/Ricoh-Wireless-API), [license](https://github.com/brianmichel/Tote/blob/main/LICENSE).
Useful evidence: documented GR III JSON responses, list format, original photo paths and derivative-size semantics. The published note warns that resized images can lose orientation data. This reinforces keeping derivatives separate from original-byte transfer; it does not establish the behaviour of every firmware. No code or assets are incorporated.

### grit (GPLv3 as stated by its author)
[Repository](https://github.com/aspyct/grit).
Useful corroboration: a simple local HTTP photo-list/download model is enough for a desktop transfer utility. Its author lists hardware they tested, but that does not validate GR Relay. We use the existing bounded adapter rather than introducing a second transport stack.

## Current transport contract
The existing adapter already follows the narrow, evidenced API:
- GET http://192.168.0.1/v1/props for identity; only model, firmware and bounded battery leave the adapter.
- GET /v1/photos for inventory; JPEG only, RAW companions disclosed but never downloaded or converted.
- GET /v1/photos/{folder}/{filename}?size=thumb or ?size=view for derivatives.
- GET /v1/photos/{folder}/{filename} without a size parameter for the original.
- One in-flight camera read, strict path allowlist, bounded files/JSON, no redirects, no compressed transport, incomplete-JPEG rejection.
- No transfer-flag mutation, camera power-off, deletion, shooting, configuration, credentials, BLE or external upload.

These safeguards remain unchanged. A simple HTTP API makes implementation tractable, not hardware validation optional.

## Acceptance and evidence
Run the exact branch's protocol/DOM suite, Chromium UI/download-byte checks and portable desktop workflow. New DOM coverage targets next-step states, cross-folder selection review, bounded review pagination, density preservation, ZIP-handoff counts and real battery projection. Browser checks cover uncropped thumbnails, review open/remove/close/reopen, next-step navigation and existing interrupted/repeated transfers.

Screenshots and verification.json are produced by the existing browser workflow. A passing synthetic browser run is not a camera, physical Mac or phone test. Exact-head CI results and independent review are required before merging.

No package version change, new release, external fonts/assets, background sync or new camera permissions are included.
