# Wavelength public release implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Prepare GPL-3.0 source and an unnotarized experimental native Mac download locally, without publishing.

**Architecture:** Keep the SwiftUI app and bundled Bun engine. Extend existing checks and packaging with version-pinned notices, explicit source provenance and separate ad hoc release signing.

**Tech stack:** Swift, TypeScript, Bun 1.3.14, macOS `codesign` and `ditto`.

**Spec:** `docs/superpowers/specs/2026-10-16-public-release-design.md`.

## Global constraints

- GPL-3.0-only for Wavelength; retain separate upstream licenses and satisfy bundled-runtime source/relink requirements.
- Apple Silicon, macOS 14 minimum, explicitly unnotarized experimental release.
- Preserve existing approved features, dirty index and user data. No installed-app replacement or live account tests.
- No GitHub writes, destructive history changes or personal signing material in release artifacts.
- Outputs stay beneath the existing T3 project directory. No arbitrary untracked/ignored file inclusion.
- Use the existing worker and a separate reviewer. Local commits only after review and ownership checks; do not bypass a configured signing requirement.

## Review focus

- Old HEAD is missing current features: the source archive must represent the reviewed shipped snapshot.
- A release must not inherit the personal development certificate or local signing configuration.
- Missing runtime notices or source/relink materials must block distribution, not become a warning hidden in logs.
- An extracted ZIP must preserve executable modes and valid app signatures.
- CI and release checks must not access real Keychain credentials or modify Music.

## Task 1: Public source documentation and checks

**Files:** `LICENSE`, `README.md`, `SECURITY.md`, `CONTRIBUTING.md`, `package.json`, `.gitignore`, `.github/workflows/check.yml`, the four audited planning documents and `experimental/web-session-probe/README.md`.

**Produces:** GPL license declaration, accurate public instructions, retained historical context, safer ignore rules and credential-free fixture coverage.

- [ ] Add the unmodified official GPLv3 text and a GPL-3.0-only package/README declaration. Keep npm `private: true`.
- [ ] Refresh stale build/integration claims and document architecture, limitations, privacy and unnotarized-install caveats. Do not claim clean-machine acceptance.
- [ ] Replace personal absolute paths in current documents with portable locations. Do not rewrite Git history.
- [ ] Add concise contributing/security instructions. Do not invent an enabled private-reporting feature or publish a private contact address.
- [ ] Exclude HAR captures and private signing/archive artifacts without hiding source fixtures. Document that ignore rules cannot prevent every accidental disclosure.
- [ ] Add `contents: read` and existing safe WebMusic/artwork/auth-wrapper fixture commands to CI.
- [ ] Check documentation links, `git diff --check`, typecheck and existing commands. Have the separate reviewer inspect this task before committing exact owned changes.

## Task 2: Runtime redistribution and release packaging

**Files:** `scripts/build-app.ts`, a small release script and focused `tests/release.test.ts`, versioned third-party notice files and release instructions. Reuse `scripts/signing.ts`; do not alter local signing configuration.

**Consumes:** GPL declaration and the existing build output. **Produces:** fresh ad hoc app, explicit reviewed source snapshot, complete dependency materials, release notes, manifest and checksums in a new local release directory.

- [ ] Finish the exact Bun 1.3.14 notice/source/relink audit. Record upstream revision, dependency pins and required materials. Stop and report any unresolved distribution requirement.
- [ ] Write failing tests for missing/mismatched runtime provenance, missing licensing materials, dirty/unaccounted source files, personal signing configuration inclusion, existing output collisions and archive manifest/hash validation. Use temporary fixtures, not the production app or Keychain.
- [ ] Run focused tests and confirm each fails because the release behavior is absent.
- [ ] Implement the smallest packaging helper that enforces those conditions. Use explicit allowlists or a clean reviewed commit, not a blanket filesystem archive. Never silently omit current untracked feature files.
- [ ] Ensure the release build explicitly uses ad hoc signing and checks the resulting app for ad hoc signatures. Local development builds retain their current signing behavior.
- [ ] Bundle the required licenses/notices and runtime source/rebuild materials. Keep them associated with the exact binary, not an unversioned upstream link.
- [ ] Run focused tests to green and request independent review. Fix important findings and rerun checks before any local commit.

## Task 3: Build and inspect the actual local release

- [ ] Run `bun install --frozen-lockfile`, `bun test`, `bun run typecheck`, `node --check public/app.js`, `bun run test:native`, `bun scripts/check-web-music.ts`, `bun scripts/check-artwork.ts` and `bun experimental/web-session-probe/auth-wrapper/check.ts`. Only mocked boundaries and isolated data are allowed.
- [ ] Build the fresh ad hoc app. Verify `codesign --verify --deep --strict`, app architecture/version/minimum OS and packaged-engine checks. Run the conditional packaging test with `WAVELENGTH_PACKAGING_APP` pointing at this new bundle.
- [ ] Package with `ditto`, extract to a temporary directory and repeat signature/resource/mode checks. Inspect the matching source archive, required third-party materials and checksum manifest.
- [ ] Repeat redacted credential/personal-data scans on final source and extracted artifacts. Do not print tokens or private values.
- [ ] Have the separate reviewer check source-to-artifact correspondence and remaining limits. Record fresh evidence in the release folder.
- [ ] Hand off local artifact paths and outstanding publication steps. Leave the private repository, installed app and user data unchanged.
