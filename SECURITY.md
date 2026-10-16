# Security

Wavelength is experimental. Apple web-session credentials can authorize account access. Do not post Authorization or Media-User-Token values, passwords, HAR files, Keychain exports, Application Support data, private signing material or unredacted logs.

For a suspected vulnerability, first check whether this repository offers GitHub's private vulnerability reporting option. Use it only if available. Otherwise, open a minimal public issue asking the maintainer to arrange a private reporting channel. Do not include exploit details, credentials or private files in that issue. No private reporting channel or response deadline is promised here.

A private report should identify the source revision or app version, affected component, expected and observed behavior, and reproduction steps using synthetic data. Redact account and machine information. Do not test against someone else's account or a live library without explicit authorization.

Session storage uses a dedicated macOS Keychain item. Local jobs, history, covers and logs remain in Application Support. Disconnect removes Wavelength's saved connection; it does not revoke the underlying Apple session or clear Safari. If credentials leak, use Apple's account/session controls and reconnect only after addressing the exposure.

The engine's loopback binding and request validation do not protect against every malicious process running as your user. `.gitignore` also cannot remove tracked secrets or guarantee safe archives. Inspect staged changes and release artifacts before sharing. Historical commits may retain author addresses and paths even after current documents are cleaned up.
