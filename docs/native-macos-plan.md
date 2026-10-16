# Native Wavelength

> Historical record. This document describes the approved work at the time, including its earlier architecture, build and installation steps. Use [the current README](../README.md) for current behavior and setup. It does not authorize repeating past live tests or replacing an installed app.

The user approved a real SwiftUI macOS app using the existing discovery and Music engine. Keep the wide desktop design and Slate/Iris palette from the approved interface. Install it locally for Spotlight.

## Global constraints

- Genuine SwiftUI/AppKit controls. No Safari, embedded browser, WebKit, Electron, or Terminal window.
- Self-contained app bundle with Bun runtime, engine sources and precompiled MusicBridge. No installed Bun, source-folder or runtime compiler dependency.
- Preserve existing data in ~/Library/Application Support/Wavelength and existing Music playlists.
- Include AI artists is an explicit toggle, off on every launch. Unknown provenance is not a claim of human authorship.
- Keep loopback Host/Origin/token validation and existing server-issued selection/preflight safety.
- No new Music writes, security permission grants, pushes, updater, login item or unrelated features during this conversion.
- Build output under the project output folder, installation at `~/Applications/Wavelength.app` by the controller after review.

## Task 1: Build the native interface and app bundle

Work in the repository root on native-macos. Existing engine and browser developer UI remain intact.

### Files and interfaces

Create focused Swift files under native/App for Codable API types, URLSession transport, MainActor observable UI model, SwiftUI views, engine lifecycle and app entry point. Add scripts/build-app.ts and relevant native model/lifecycle/bundle tests. Update package scripts, README and macOS CI where needed. Small backend changes are permitted for lightweight readiness and deterministic bundled helper lookup, with tests.

Use URLSession against the bundled loopback engine. All writes include exact Origin and x-wavelength-token acquired from /api/session. Use a lightweight readiness endpoint that does not invoke Music or prompt permissions. Launch child engine without --open, log outside signed bundle, choose a private available loopback port rather than relying on a developer server. The app owns its engine, must never kill unrelated processes, and cleans up owned subprocesses on quit. Warn before quitting an active creation. Startup errors are visible and retryable. Reopening the app shows its existing native window.

Native flows must include genre/artist seeds, genre suggestions, length 1-50, essentials/mix/recent selection, per-artist 1-3, six existing stores, AI toggle, preview progress/cancel, track artwork/title/artist/album/source/provenance/duration, selection/removal, review sheet with saved evidence and local classification, playlist name, read-only library preflight counts before Create, saved job progress/errors/cancel/retry/open, permission guidance and visible status. Uncertain matches start unselected. Selection/AI/provenance changes invalidate preflight; async stale responses cannot re-enable Create. Poll active jobs and restore latest saved job. Avoid blocking UI on network.

Match rectangular desktop proportions, approximately 1100x780 with sidebar and wide review panel, resizable with a usable desktop minimum size. Use native keyboard/accessibility labels, dark Slate/Iris palette and subtle circular instrument accents. No vertical phone layout.

Build with local xcrun swiftc, bundle installed Bun executable and engine resources, precompile MusicBridge, add Info.plist with stable bundle identifier local.wavelength.app and NSAppleEventsUsageDescription. Ad-hoc sign nested executables then whole bundle. Do not change signed resources at runtime. Keep writable database/cache/log files outside bundle. Minimum deployment target should match actually used APIs, preferably macOS 14 or newer.

### Steps and evidence

1. Read touched backend/UI files and write failing focused tests for native state safety, transport headers/error handling, readiness, packaged resource resolution and owned engine shutdown. Run them and record expected failure before implementation.
2. Implement native UI, transport/model, lifecycle and build script. Run focused checks after each logical change.
3. Run full Bun suite, typecheck, native self-checks and compile/build the actual app. Expected all green with no warnings. Inspect plist, codesign and bundle resources. Do not launch Music jobs.
4. Self-review actual diff, report files changed, RED/GREEN evidence, test commands/output, build path, limitations. Do not commit before independent review. No subagents.

## Controller verification and review

A separate reviewer checks the actual result for spec compliance and quality, especially stale preflight, AI gating, packaged paths, lifecycle ownership and first-launch permissions. Controller runs full checks and live native UI preview with no Music writes, tests launch/relaunch/quit, then installs app and registers it with LaunchServices/Spotlight. Local commit only after review; no push without permission.
