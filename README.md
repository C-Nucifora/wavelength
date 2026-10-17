# Wavelength

An experimental macOS app that turns genres, artist seeds and artist discographies into Apple Music playlists. The native SwiftUI interface runs a bundled local Bun engine. Songs use your own Apple Music web session; generated covers use background Music Automation. An Apple Music subscription and sensitive session credentials are required, but no registered developer key.

Wavelength source is licensed under [GPL-3.0-only](LICENSE). Apple does not support this web-session reuse route and may change or expire it. This project is not affiliated with Apple or the discovery services below.

## Status and installation

Source builds are available now. An Apple Silicon experimental prerelease is being prepared; no public download is declared ready here. The planned download targets arm64 and macOS 14 or later, with ad hoc signing and no Apple notarization. Intel and universal downloads are not promised. Gatekeeper and clean-machine installation remain unverified. Some Macs may block the app. Follow [Apple's supported per-app approval instructions](https://support.apple.com/en-us/102445) only if you trust the source and artifact. Do not disable Gatekeeper or remove quarantine.

The current native source is build 5. Earlier account acceptance confirmed web playlist creation and appending, and the user confirmed integrated generated covers locally and in the cloud. A read-only live discography preview returned 273 songs across 28 releases. These checks do not establish behavior for every account, machine or catalog. Real Apple CSV-export compatibility remains unverified.

To build on macOS 14 or later, install [Bun 1.3.14](https://bun.com) and Apple's Command Line Tools, then run:

```sh
bun install --frozen-lockfile
bun run build:app
```

The build prints a new `Wavelength.app` path under `../builds.noindex/native-*/`; it does not replace an installed app. Review the bundle before copying it to your Applications folder. It includes Bun, engine sources and a precompiled WebMusicBridge, so running it needs no source checkout, installed Bun or compiler. Source builds target the build Mac's architecture with macOS 14 as the minimum.

The app starts its engine on a private loopback port, offers Retry startup after failures and stops its owned engine and helpers on quit. Quitting during playlist creation asks first; saved unfinished jobs can be retried under the safeguards below.

Local builds use `WAVELENGTH_SIGN_IDENTITY`, then the fingerprint in the ignored `.wavelength-signing-identity` file, then ad hoc signing if neither is configured. A stable certificate can avoid repeated permission prompts after rebuilding. These builds are not notarized. Keep personal signing configuration out of archives.

## Connect and create

Open Discover's Apple Music connection panel. Experimental sign-in opens Apple's page in a temporary native WebKit session. Enter your password and verification code yourself. Captured credentials stay in memory until you choose Validate and save locally. The manual fallback accepts Authorization and Media-User-Token values in secure fields. Never paste these into chat, issues, a terminal or screenshots. Validation sends them only to `https://amp-api.music.apple.com`; Save stores a complete pair and connection generation in a dedicated Keychain item. If macOS asks for Keychain access, choose Always Allow for Wavelength to remember the signed helper. Check connection and Save can request access; startup and background operations never display a Keychain prompt. A locked keychain, changed signing identity, or expired Apple session can require access or sign-in again.

1. Choose a genre or artist seed, region, playlist length and song selection. Preview songs and review sources and uncertain matches, which start unselected.
2. Select songs and name the playlist. Check selection validates availability in your authenticated storefront. Deselect unavailable songs, then check again. Selection, AI preference or connection changes require a fresh check.
3. Choose Create playlist. Nothing creates automatically. Songs are added in displayed order and confirmed by catalog identity and readback, not just HTTP success.

Creation saves possible-write intent before the first POST, then retains the returned playlist ID. It stops at the first unconfirmed addition. Cancellation waits for the in-flight operation. Retry checks account ownership and ordered contents first; uncertain writes use reads only. An unknown creation outcome cannot retry the create POST. Inspect Apple Music before starting another job in that case. Legacy Music-app jobs retain IDs and counts, but their old retry path is disabled. Find created playlists in your Apple Music library; the app offers no unverified cloud-ID link and removes no songs or playlists.

Song creation needs no open Music window, Accessibility, foreground controls or idle keyboard. Completed new marked playlists receive generated covers through background Music and Automation permission. If blocked, choose Allow Music Automation, then Retry cover. Check cover only reads an uncertain result, without resending songs or reapplying an image. Cover verified means Music on this Mac returned the exact generated image; Music controls cloud synchronization. Older unmarked jobs receive no covers. The native job panel shows a local thumbnail; the browser developer view shows text status.

### Artist discographies

Choose Discography, find an Apple Music artist and select the exact catalog identity. This requires a saved connection and matching storefront. Preview reads every page of albums, EPs, singles and tracklists, then orders releases by Apple's listed date and songs by disc and track. Repeated songs across releases and separate editions remain separate. Music videos are skipped. Discovery length and per-artist caps do not apply.

Review release headers and dates, then Check selection and Create playlist. Removing one occurrence preserves other copies. Catalogs above 1,000 song occurrences, incomplete pages or malformed responses fail visibly without a partial draft. Regional availability and reissue dates may differ from the artist's historical discography.

Genre discovery uses Every Noise's largely historical map and representative tracks with current Apple metadata. Artist discovery uses MusicBrainz and ListenBrainz, with a visible seed-only fallback. Essentials uses search ranking, not a verified greatest-hits list. Recent sorts returned releases by catalog date, so reissues can appear recent. Mixed selection alternates essentials and recent releases. Sources may throttle or fail; previews report shortfalls.

## AI artists

Include AI artists starts off on every launch. It excludes only artists recorded as AI in local assessments. There is no comprehensive AI database or inference from sound, names or artwork. Unknown remains unknown, not certified human-made. Review sources lets you save evidence and an assessment. Turning AI on allows recorded AI artists; it does not generate music or use a paid AI service. Retrying a saved AI-enabled job requires turning it on again.

## Listening history

Read Music library explicitly scans current metadata, cumulative play counts, last-played dates, skips and favourites. It is read-only and may request Automation permission. Startup restores saved history and jobs without scanning Music or beginning sign-in. Library snapshots cannot reconstruct listening dates or minutes; zero-play tracks remain visible.

Request data at [Apple's data and privacy site](https://privacy.apple.com), extract the archive and choose one CSV. Review the detected profile, accepted/rejected rows, missing fields, date and reported-duration coverage, exact library enrichment and warnings. Only Import saves it. Replacement requires confirmation naming the source and import date; cancelling leaves history intact. Parser fixtures cover Play activity, Daily tracks and Recently played headers, but real exports remain unverified.

Library and export reports remain separate. Exports are not complete lifetime history; Recently played is last-seen ranking, not an event timeline. Charts and native tables use the same bounded rows and disclose exclusions and time zone. Only supplied reported duration counts as listening time, never track length multiplied by plays. Date-only records retain their dates; unresolved local timestamps cannot supply hourly bins.

Artist cards fill a Discover seed. Replacing a draft asks first; Preview and Create remain separate actions and the AI preference stays unchanged. Forget history confirms removal of local history and pending history work while preserving drafts, jobs, assessments and Music. It does not securely erase disk data or backups.

## Privacy and safety

The engine binds only to `127.0.0.1`; writes require a local Host, Origin and per-process session token. Bun never receives Apple session credentials. Native setup passes them to WebMusicBridge through bounded standard input, not arguments, environment or logs. The helper owns Keychain access, rejects redirects and authenticates only against Apple's fixed web-player host. Locks and generation checks guard against stale selections or account changes during requests. Disconnect removes only Wavelength's production connection, not Safari sessions, jobs, history or playlists. Separate probe credentials are not imported.

There is no added telemetry. Artist names, search terms and selected discovery region go to the relevant services below; artwork loads from Apple's image servers. Every Noise requests are cached and limited to the index and selected genre pages, not bulk crawling. No website dataset is bundled. Public Apple searches are paced, so longer previews can take several minutes.

Drafts, jobs, assessments, history, discovery cache, private cover assets and per-launch logs stay in `~/Library/Application Support/Wavelength/`. Runtime files never modify the signed bundle. Do not publish this folder, tokens, HAR captures, logs or personal signing material. Ignore rules reduce accidental inclusion but cannot prevent every disclosure or remove tracked data. See [security guidance](SECURITY.md).

## Development

The browser interface is a developer view of the engine, with no credential fields or setup endpoints. Use the native app to connect. `bun start` or `Start Wavelength.command` opens the developer interface in Safari at `http://127.0.0.1:8769`; Control-C stops it. `bun run dev` starts without opening a browser. `WAVELENGTH_DATA_DIR` and `PORT` select developer data and loopback port. The native app uses its own Application Support location and private port. A standalone engine needs an explicitly selected compiled helper via `WAVELENGTH_WEB_MUSIC_BRIDGE`; it never compiles or falls back to the old UI helper.

```sh
bun install --frozen-lockfile
bun test
bun run typecheck
node --check public/app.js
bun run test:native
bun scripts/check-web-music.ts
bun scripts/check-artwork.ts
bun experimental/web-session-probe/auth-wrapper/check.ts
```

These fixture checks use fake account and Music boundaries, not live library writes. `bun run test:native /path/to/Wavelength.app/Contents/Resources` also checks packaged engine lifecycle using temporary data. See [contributing](CONTRIBUTING.md) before live tests. Historical plans under `docs/` describe earlier implementations, not current setup instructions. There are no runtime npm dependencies.

## Sources and licenses

[Every Noise at Once](https://everynoise.com/) by Glenn McDonald supplies the genre map. [Apple's Search API](https://performance-partners.apple.com/search-api) supplies public metadata. [MusicBrainz](https://musicbrainz.org/doc/MusicBrainz_API) resolves names and [ListenBrainz Labs](https://labs.api.listenbrainz.org/similar-artists) supplies related artists. Draft songs retain source links. Each service's terms still apply.

The [GPLv3 text](LICENSE) applies to Wavelength as GPL-3.0-only. Third-party software, including Bun and its components, retains its own licenses and notices; Wavelength's license does not replace them. Binary preparation must include matching source, dependency notices and the runtime's required source/rebuild materials before a download is called distributable. Licensing does not establish rights to third-party data, trademarks or service access.
