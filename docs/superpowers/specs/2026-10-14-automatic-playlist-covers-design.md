# Automatic playlist covers

> Historical record. This document describes the approved work at the time, including its earlier architecture, build and installation steps. Use [the current README](../../../README.md) for current behavior and setup. It does not authorize repeating past live tests or replacing an installed app.

## Outcome and scope

New Wavelength playlists receive a free, on-device square cover after all songs have been confirmed. The cover uses the playlist title and an abstract wave design in the app's charcoal, violet and related accent palette. Attach it to the playlist in Music without Accessibility, clicks, keystrokes or foreground control. Then verify the actual image directly.

Integrate this into the existing native app and existing feature branch. Build and review a new signed bundle, then replace `~/Applications/Wavelength.app`, preserving the previous bundle and all saved data. No GitHub push is included.

Do not change discovery, AI filtering, listening history or HTTP song insertion. Do not apply covers to legacy jobs, older unmarked jobs, partial/cancelled/failed playlists or unrelated library items. Do not add an image-provider key, cover editor, export flow or artwork replacement for existing user playlists.

## Tested behavior

The picture-data setter was isolated and verified on two fresh empty playlists and one populated playlist. The populated playlist's track remained unchanged. The user confirmed that its purple/yellow generated cover also appeared on the web or another Apple Music device.

Music reported script error `1` and an artwork count of zero despite successful attachment. Direct `data of artwork 1` reads returned bytes identical to the generated JPEG. Therefore neither an error response nor artwork enumeration determines success. Image read-back does.

These results prove feasibility for the tested account, not guaranteed cloud delivery on every job. The app verifies local attachment; Music manages subsequent cloud synchronization. HTTP-created playlist correlation remains an integration acceptance check.

## Components and identity

Use the existing WebMusicBridge executable, with a separate native artwork module behind an injected Foundation-only interface. Its driver receives only validated job identity, title and canonical playlist tracks, never credentials. Keeping it in the same process lets the existing operation lock cover generation validation, authenticated playlist inspection and the local cover operation without a disconnect race.

For new jobs, persist the job UUID and cover eligibility before the playlist creation POST. Pass the UUID through Jobs, the adapter and native request allowlists. Creation sets a description marker derived from that UUID, such as `Wavelength playlist job <UUID>`. This marker is visible in Music and is reserved for correlation, not a documented cloud-ID conversion.

Before each cover operation, under the shared lock:

1. Require the expected saved connection generation.
2. Fetch the exact saved cloud playlist ID. Require an editable playlist with the expected name and UUID marker.
3. Reconcile its entire ordered catalog-song list against the completed job. Use a dedicated complete-order check, not the existing append/rebind validator that requires a remaining song position.
4. Obtain canonical title, artist, album and duration metadata from that cloud playlist response, rather than assuming discovery metadata matches Music.
5. Resolve exactly one local Music playlist with the UUID marker. Verify its name and full ordered track metadata against the canonical snapshot. Save its hexadecimal persistent ID; recheck marker, name, ID and tracks before any later write.

Convert cloud duration milliseconds to Music duration seconds and allow at most three seconds of difference. Normalize title, artist and album by trimming, collapsing Unicode whitespace to a single space and applying locale-independent lowercase on both sides, then require equality. Missing or ambiguous identity, incomplete metadata, changed tracks or changed marker blocks the cover. Never guess by name or convert a cloud ID into a local ID. Existing jobs without a creation marker remain untouched.

## Rendering and attachment

Render a deterministic 1024-pixel JPEG with title text and code-drawn waves. Bound title input and image dimensions; use platform drawing APIs and no new dependency. Derive colors from stable job/title information. Do not use artist photos or paid generation services.

Keep the immutable image, its SHA-256 and a small native cover journal in an owned, private Wavelength Application Support directory addressed only by validated job UUID. Reject symlinks, unexpected file ownership, oversized files and image/journal hash disagreement. Reuse an existing attempted image after upgrades; do not silently rerender it.

Music may be opened in the background without activation when needed. No Music navigation, playback commands, dialog dismissal, Accessibility calls or foreground manipulation are permitted. If Automation permission is missing, leave the cover blocked and offer an explicit native permission action. A denied permission never affects completed songs.

After rendering and safe target resolution, durably record the intended target and write-attempt flag before dispatching the picture-data setter. Use bounded AppleScript calls and an overall bounded helper request. Always attempt direct image read-back after the setter, including error responses and zero enumeration counts. An exact expected JPEG hash confirms local attachment. Otherwise report an unconfirmed outcome, not success or assumed absence.

## Job state and recovery

Persist song state `complete` and initial cover state `pending` together before starting cover handling. Catch cover failures outside the song-job failure handler so they cannot turn a completed playlist into a failed song job or repeat additions.

Use optional, independent cover state on new jobs: `pending`, `applying`, `verified`, `blocked` or `uncertain`. Create `pending` only when every song is confirmed, then persist `applying` before helper dispatch. An exact image match becomes `verified`; a known failure before setter dispatch becomes `blocked`; a dispatched setter without matching read-back or a lost helper reply becomes `uncertain`. Existing job records remain decodable. Serialize active cover work with song work; update native polling and busy controls so song completion does not hide an in-progress cover.

The native journal is authoritative about whether a setter may have been dispatched. Its durable write-attempt flag is conservative because a crash can occur between saving the flag and sending the setter. Record backend helper dispatch separately from native setter intent, and return typed results that distinguish a known pre-write block from an attempted native write. Backend IPC uncertainty may occur before any native write. On restart or lost IPC response, reconcile read-only, even if the native journal is absent. Never interpret an absent journal or image as permission to repeat an uncertain setter.

Provide an explicit cover-only retry/check action for eligible completed jobs. It reads first and returns verified without writing when the expected image already matches. A known pre-write block can be retried after the remedy. A prior dispatched or uncertain write remains read-only unless a future separately approved recovery design permits reapplication. Never resend songs or create another playlist to fix a cover.

Automatic cover work uses the job's saved generation. After reconnection, only an explicit retry may use the current generation, and only after revalidating ownership, marker and ordered tracks under that generation. Do not silently follow an account change.

## Native UI and packaging

Keep the existing desktop layout. Show the generated thumbnail and cover status in the completed job panel. Load the thumbnail from the validated UUID-scoped private local image, not inline JPEG bytes in helper JSON, which has a 128 KiB output limit. The browser compatibility view may show text status only. Keep song totals and their completion message accurate when a cover is blocked. Distinguish the permission remedy, a pre-write retry and read-only verification of an uncertain write.

Update the AppleEvents purpose text to describe both requested history reads and automatic playlist artwork updates. Clarify that HTTP song creation does not need Music's UI, while covers need background Music and Automation permission. Accessibility remains unnecessary.

Bump the bundle build from 3 to 4 and package the artwork sources into the existing helper. Preserve the approved app icon. Build, validate signatures and independently review the resulting bundle before installation. If Wavelength is running, defer replacement until it is safely closed; never overwrite a running bundle or discard an active job's uncertainty record. Preserve the prior build in a versioned backup and register the new Applications copy for Spotlight.

## Verification and acceptance

Offline regression checks must cover count-zero and errored-write image success, wrong/unreadable images, strict marker and catalog-order validation, canonical/local metadata mismatch, generation changes, explicit retry, duplicate names, durable native write flags, lost replies and restart reconciliation without another setter. Test that cover errors preserve song completion and legacy jobs never acquire cover work.

Renderer checks cover dimensions, valid JPEG decoding, title bounds, deterministic output, distinct job designs and immutable existing assets. UI/model checks cover cover polling, busy-state exclusion, permission/error text, cover-only retry and preserved song results. Run the full Bun, TypeScript, native and helper suites, plus signed packaging checks.

After review, live acceptance must exercise a newly HTTP-created, uniquely marked playlist with songs, resolve its local counterpart, attach a generated cover and confirm direct read-back. The user's web/other-device check confirms cloud appearance separately. No arbitrary existing playlist may be selected for this acceptance test. Request a fresh clearly labelled test job if one is needed.

Installation acceptance verifies source/installed bundle equality, build 4, signatures, preserved build 3 and Spotlight registration. Saved jobs, history and Keychain records must remain unchanged by installation.
