# Web-session playlist writer

## Outcome and scope

Replace Wavelength's playlist creation and song addition path with direct Apple Music web-session requests. Keep the native SwiftUI desktop app, Bun discovery engine, saved jobs, history reports and default-off AI artist setting.

The live probe passed on 14 October 2026. It authenticated against the AU storefront, created a playlist containing one catalog song, appended a second song, and read both catalog IDs back in order. This proves this account can use the route now. It does not make the route supported by Apple or establish embedded login and long-term session renewal.

Work stays on `feature/apple-music-web-session`. Do not push, merge, install over the existing app, delete playlists, or run additional account writes as part of implementation checks. Preserve old bundles and personal data.

Automatic sign-in is a separate, agent-owned feasibility spike. The writer must work with explicit local session setup even if that spike cannot capture the credentials. Do not replace the native app with Electron.

## Architecture

Keep `Jobs` and the authenticated localhost API as the queue and persistence boundary. Add a web-session adapter for the existing playlist operations, extending their internal contract with the ordered context and typed outcomes below. Keep the read-only Music history adapter separate.

Package a native Swift `WebMusicBridge` beside the engine. It owns Keychain access and all authenticated Apple requests. The Bun engine passes operation data to the bridge through bounded JSON on standard input and receives safe JSON results on standard output. Tokens must never enter Bun, command-line arguments, environment variables, engine logs, server responses, or job records.

The SwiftUI app's local connection setup calls the same native bridge directly, without sending credentials through the localhost API. The bridge stores a validated pair in a dedicated production Keychain item. Importing the probe connection or granting a new executable access requires explicit user consent at the time; implementation and tests must not read the existing probe item.

Use the probe's proven request and readback contracts, but separate production code from the one-attempt test application. Do not modify the running probe or its saved test record.

## Connection boundary

Production Keychain service: `local.wavelength.apple-music.web-session.v1`. Account: `apple-music-web-session`. Store the bearer token, media user token and a new random UUID connection generation as one credential record. Keychain changes and checks must expose only safe status, storefront and that nonsecret generation, never the credential values.

Explicit local Save and Check actions precede playlist writes. Invalidate selection receipts when the saved connection changes. Disable save, disconnect and reconnect while a job has an operation in flight. Session rejection produces a reconnect-required status and does not fall back to Music automation.

Enforce that rule in the native bridge, not only in SwiftUI or Bun. All bridge processes use the same private interprocess operation lock. Hold it from credential loading and generation validation through request completion and readback. Save and disconnect require the same lock and fail safely as busy rather than changing the credential record during an operation. Validate the expected generation before any authenticated operation; a mismatch starts no request.

Preflight returns the current generation. The server binds it to its selection receipt, and the job persists it before creation. Every authenticated bridge operation carries that expected generation. Initial status can return an absent generation. Save and disconnect compare the expected current generation or absent state under the same lock before changing it. A local save that bypasses Bun still makes an old receipt unusable at the native boundary.

After reconnect, a job with a known cloud ID may be rebound only by explicit Retry followed by a read-only check under the new generation. That check must confirm the playlist exists in the current authenticated library and has the expected ordered prefix. Persist the new generation before another write. A different account, unreadable playlist, conflicting contents or unknown create outcome cannot be rebound automatically.

The native writer sends only to `https://amp-api.music.apple.com`, with `Origin: https://music.apple.com`. Reject redirects, including same-host redirects. Use an ephemeral URLSession without shared cookies, caches or URL credential storage. Validate route identifiers and all request sizes before network access. Return allowlisted errors instead of raw Apple response bodies or underlying transport descriptions.

The automatic login spike may return a complete credential pair through this connection boundary only after its own origin checks and read-only live validation pass. Passwords and two-factor codes stay in Apple's login page and must not be inspected by Wavelength.

## Native bridge operations

- `status`: inspect only the bridge's own local saved-connection state. Do not contact Apple or launch Music automatically.
- `checkConnection`: explicitly validate the saved session and obtain its storefront through authenticated reads.
- `inspectTracks`: validate the selected catalog IDs in that storefront through reads. Return availability, not promises about local Music library additions.
- `ensurePlaylist`: create a named empty playlist, or validate ownership and existence of the supplied cloud playlist ID through the authenticated library API. Return a cloud ID only after a valid create response.
- `addTrackToPlaylist`: inspect the existing playlist before adding one catalog song, append once when safe, then verify the catalog identity and order through bounded readback.
- `saveConnection` and `disconnect`: callable from native local setup, with no credential return values. Disconnect deletes only the production credential item, not playlists, jobs, history or Safari's session.

Production append confirmation must support library-song `attributes.playParams.catalogId`. A local library ID, title match, 204 response, or missing mapping alone cannot establish successful insertion. Follow pagination only through validated routes on the fixed host. Never attach credentials to an arbitrary response URL.

## Ordered adapter contract

Extend the internal adapter rather than hiding uncertainty in an error string:

```typescript
type WriterContext = {
  connectionGeneration: string;
  expectedCatalogIds: string[];
  position: number;
  reconcileOnly: boolean;
};

type TrackWriteOutcome =
  | {kind: "confirmed"; catalogId: string; alreadyPresent: boolean; libraryId?: string}
  | {kind: "not-added"; message: string}
  | {kind: "uncertain"; message: string}
  | {kind: "conflict"; message: string};
```

`ensurePlaylist` receives the expected connection generation and full catalog-ID sequence. `addTrackToPlaylist` receives `WriterContext` and returns `TrackWriteOutcome`. The bridge validates that the selected track equals `expectedCatalogIds[position]` and that existing contents are exactly the expected prefix for that position. A prefix already including that track can return confirmed without a POST. Missing preceding tracks or extra/conflicting contents return conflict.

Use reconcile-only mode after an ambiguous or interrupted append. It performs GETs only. It may confirm an existing expected prefix, but absence is not proof that a delayed POST will never apply, so it must not issue another append. A definitively rejected, not-added operation may be retried after a fresh connection/prefix check.

## Jobs, interruption and uncertain writes

Tag new jobs with the `web-session` writer. Existing jobs with no writer tag remain legacy Music-app jobs. Do not reinterpret their sixteen-character persistent IDs as cloud IDs, change their added counts, or silently recreate them. Show old jobs and explain that their original retry path is unavailable under the new writer. Preserve their existing playlists.

Persist a create-in-flight state before sending a create POST. Save the returned cloud playlist ID before attempting any track addition. On restart, a create-in-flight state without an ID becomes an unknown creation outcome. Do not automatically POST another create request for that job; tell the user to inspect Apple Music first.

Persist track operations before sending their POST. A timeout or interrupted append is uncertain, not immediately eligible for another append. Retry first reads the known playlist. If the expected song is present in the correct ordered prefix, mark it confirmed without another POST. If state cannot be established, leave the job uncertain and do not blindly append again.

Stop the queue immediately after the first result that is not confirmed, including a known rejection. Do not inherit the current loop's continue-after-error behavior, because adding later songs would break the expected prefix. Leave later tracks pending. Persist a distinct uncertain/conflict outcome where applicable so restart and Retry select reconciliation rather than an append. Only a confirmed result advances the position.

Use the job's ordered catalog-ID list as the expected sequence. Do not mark complete unless the readback confirms that sequence. If the playlist has conflicting edits, missing catalog mappings or unresolvable pagination, report the conflict instead of guessing. No automatic playlist deletion or song removal is permitted.

Cancellation still stops after the in-flight operation settles. Persist its confirmed or uncertain outcome. Preserve AI exclusions and the current server-issued draft selection checks on creation and retry.

## Preflight and desktop UI

Retain the preflight receipt, ten-minute expiry, selected-draft binding and AI-policy validation. Change its meaning from local library inspection to Apple Music session and selected-catalog availability.

Display selected, available and unavailable catalog counts plus the authenticated storefront. Do not show the old exact "new library additions" count when no local-library inspection occurred. Do not call Add to Library separately.

Playlist status describes the Apple Music connection, not whether Music is running or Accessibility is enabled. No Accessibility prompt or Music foreground requirement belongs in the write flow. Expired sessions should offer reconnect while preserving the draft and known job state.

The current desktop layout and discovery controls stay intact. Connection setup can initially use the two secure fields already demonstrated by the probe. The agent-owned login sheet can replace manual entry after its separate acceptance checks pass. A manual fallback must not expose saved tokens.

Cloud jobs can offer a user-initiated Apple Music link after completion. Opening a link is optional, never required for adding songs. Do not invent a cloud-ID URL mapping; verify the returned or documented link before enabling it. Legacy jobs may retain their recorded information without an automatic opener.

## History, packaging and compatibility

Keep Apple activity export import and read-only local Music library history. Library statistics may still require Music Automation permission, but never Accessibility or scripted catalog additions. Explain that distinction on the History page.

Do not package the old Accessibility song-add helper as the active playlist writer. Adjust engine resource checks, helper cleanup and app packaging to use `WebMusicBridge`. Keep a read-only JXA resource only where the history adapter needs it. Update the Apple Events usage description to describe history reads rather than playlist creation.

Keep the existing macOS 14 minimum, native architecture build, ad hoc local signing and current app bundle identity. Preserve existing installed builds until a separately reviewed native build is ready and the user authorizes replacement. Keychain behavior under updated ad hoc signatures must be checked explicitly; do not promise prompt-free access across builds.

## Verification

Use fake credentials and an external-network fixture boundary for Swift checks. Use isolated stores and fake bridges for Bun, native model and packaged checks. No automated check may read the user's Keychain or contact their account.

Cover fixed host and redirect rejection, credential normalization and redaction, origin and localhost authorization, a local save racing a stale receipt, native generation enforcement, interprocess save/disconnect exclusion, reconnect to another account, session rejection, catalog unavailability, create uncertainty, returned-ID persistence failure, append uncertainty, delayed visibility, reconciliation without POST, stopping after the first unconfirmed track, pagination, wrong order, conflicting edits, cancellation, restart, legacy job protection, AI-off retries and unchanged history data.

Run focused RED/GREEN checks, the full Bun suite, TypeScript checks, native model checks, app compilation and strict signature verification. Have a separate reviewer inspect the actual result. Local commits are permitted only after review. Do not push without approval.

Final live acceptance uses one explicitly approved new playlist and checks returned catalog IDs and order. Do not repeat the completed probe's write or reset its guard. Automatic login and the integrated writer have separate live acceptance gates.

## Evidence

- Probe source: `experimental/web-session-probe/ProbeCore.swift`.
- Live result and independent review: `../web-session-probe/001/acceptance.md` and `../web-session-probe/001/review.md`.
- Wrapper feasibility: `../web-session-probe/wrapper-research.md`.
- [Create a new library playlist](https://developer.apple.com/documentation/applemusicapi/create-a-new-library-playlist).
- [Add tracks to a library playlist](https://developer.apple.com/documentation/applemusicapi/add-tracks-to-a-library-playlist).
- [Get a library playlist's relationship](https://developer.apple.com/documentation/applemusicapi/fetch-a-relationship-on-this-resource-by-name-5l22w).

These endpoints are documented on Apple's public API host. The successful probe used equivalent paths on the unofficial web-player host. Apple can change or invalidate that route.
