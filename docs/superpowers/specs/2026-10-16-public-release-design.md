# Wavelength experimental public release

## Approved intent

Prepare the existing native macOS app and repository for public use. The owner selected GPL-3.0, a downloadable Mac app alongside source, and an explicitly unnotarized experimental first release. Publication itself is not authorized by this preparation task.

## Deliverables

- GPL-3.0-only licensing for Wavelength, with the full license and clear third-party exceptions. Preserve upstream notices and licenses.
- Current README, build/install instructions, concise contribution and security-reporting guidance. Explain experimental Apple web-session reuse, credential sensitivity, Music Automation for covers/history, AI filtering limits and known app limits.
- Remove personal absolute home paths from current planning documents. Keep historical plans clearly historical, rather than rewriting their architecture as current behavior.
- Extend existing macOS CI to run the WebMusic, artwork and auth-wrapper fixture checks with read-only repository permissions. No account credentials or live Music operations in CI.
- A fresh ad hoc-signed Apple Silicon app ZIP, matching Wavelength source archive, license/notices, release notes, provenance manifest and SHA256 checksums. macOS 14 minimum. No universal/Intel compatibility claim.
- Version-specific Bun licensing, source and rebuild/relink materials needed for the bundled runtime. A Wavelength source ZIP alone is not sufficient. Required dependency materials must be identified and accessible before calling the download distributable.
- A reviewed local release folder beneath the existing T3 project output directory. No runtime data, credentials, personal signing configuration or private certificate material in any artifact.

## Builder decisions

Use the existing SwiftUI/Bun architecture and build script. Add only small release helpers where they prevent packaging mistakes. Use `ditto` for the app ZIP. Record Bun 1.3.14 and its exact revision/hash rather than silently embedding an arbitrary runtime. Preserve the local development-signing configuration; override it with ad hoc signing for this separate release.

Prepare the first download as an experimental prerelease. No notarization setup, payment, Developer ID enrollment, updater, installer package or new app feature is in scope. Do not weaken Gatekeeper or remove quarantine. Link Apple's supported per-app approval instructions and disclose that some machines may block the build.

Source must match the shipped code, including previously approved covers and discography changes currently absent from HEAD. Establish an explicit reviewed snapshot before packaging. Do not silently archive old HEAD or indiscriminately include ignored/untracked files. Do not commit previous changes without checking their ownership and review status.

## Safety boundaries

- Preserve the dirty index and working tree while preparing changes. No resets, automatic bulk staging or history rewrites.
- Do not change the installed application, saved data, Apple Music connection or library.
- No push, release upload, tag push or visibility change without subsequent authorization.
- Existing author email and old personal paths remain in Git history. Surface this before publication; current-document cleanup does not erase history.
- Pattern scans are evidence, not proof of absence of secrets. Repeat the scan on final source and extracted artifacts.
- Licensing notices do not establish ownership, trademark clearance or compliance with service terms. Do not claim Apple support or legal clearance.

## Acceptance

Run the full Bun suite, typecheck, JavaScript syntax and all relevant Swift fixture suites. Build and verify strict signatures, the packaged-engine checks and packaged-icon test. Inspect extracted release contents and confirm source identity, license materials, architecture, signing state and checksums. Review the actual changes and artifacts independently. Report fresh results and any unverified Gatekeeper/clean-machine behavior. Stop if runtime redistribution materials remain incomplete.
