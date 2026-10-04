# Product decision: recover an interrupted batch

Research and implementation: October 4, 2026. Starting point: `324b2c3`, after the original-byte/ZIP reliability changes.

## What official camera apps teach us

- **GR WORLD:** Ricoh documents multi-image batches, but says an interrupted transfer requires selecting the unfinished images again and retrying. Its transferred-image marker depends on app history, which is reset on uninstall. This makes the recovery path and the meaning of “transferred” important product decisions. [Official FAQ](https://www.ricoh-imaging.co.jp/english/support/qa/gr-world/)
- **Image Sync:** The connection guide separates joining the camera's wireless network from the Camera Image Mode used to browse photos. Bluetooth can assist connection, while images use wireless LAN. A transfer recovery action should tell the user when the camera network must be restored, rather than suggesting that a retry button configures Wi-Fi. [Official connection guide](https://www.ricoh-imaging.co.jp/english/products/app/image-sync2/connect.html)
- **SnapBridge:** Nikon distinguishes its reduced-size automatic transfers from manually downloaded originals. An original-JPEG product should continue making the original-file guarantee visible during recovery, without silently trading image quality for convenience. [Official product overview](https://imaging.nikon.com/imaging/lineup/software/snapbridge/)

These are documentation comparisons, not hands-on testing or measurements of the apps. They do not establish compatibility with this prototype's unofficial camera adapter.

## Observed gap in this prototype

Completed JPEGs were already retained, and one file could be retried safely. However, a cancelled 48-frame batch could require up to 48 separate Retry clicks. The summary counted failures but omitted cancelled entries, making it harder to understand what was left. This is a directly reproducible gap with synthetic fixtures; it does not need a new camera protocol or an expanded hardware claim.

## Chosen change

Add a recovery block above the tray's file list:

1. Show completed, browser-handed, waiting, failed and cancelled counts together.
2. Offer **Retry unfinished (N)** with a clear description: it retries eligible failed and cancelled entries from the current connection, restarting each file from the beginning.
3. Preserve ready JPEGs and already handed-off files. Individual Retry remains single-file only.
4. Explain why other entries cannot be included: the source changed, its URL is no longer usable, or it reached three attempts.
5. Immediately invalidate a previously prepared partial ZIP before starting any recovered reads. Rebuild from the completed tray afterward.

The action is explicit. It does not retry automatically, remove files, clear the tray, change networking, mutate the camera or imply that browser handoff proves disk persistence. A different connection session requires reselection, because matching filenames alone cannot establish that the camera/card content is identical.

## Why this first

The recovery improvement removes repeated work from a failure users can encounter during the core import task. It builds on the completed-file preservation already in place, preserves exact JPEG bytes and works entirely inside the read-only adapter boundary. A refreshed brand would not fix this interruption, and persistent “already imported” history would require stronger identity and save-verification semantics than the prototype currently has.

## Acceptance and remaining evidence

Success means an interrupted batch can be explicitly recovered in one action, each eligible file is read once per retry, completed bytes remain identical, and stale/exhausted entries never restart through either batch or individual controls. All cases have automated synthetic coverage; see [verification.md](verification.md#batch-recovery-qa-october-4-2026).

Actual GR III firmware responses, Wi-Fi-loss behavior, browser rendering, mobile layout and saving to disk remain unverified. The implementation does not establish support for another camera model or a native-phone transfer path. Product naming remains separate from this change.
