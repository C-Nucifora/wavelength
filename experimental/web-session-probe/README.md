# Wavelength web-session probe

Historical native feasibility probe. This remains a separate app with a separate bundle ID and Keychain item. Its credentials are not migrated into Wavelength. The main app now uses the integrated web-session writer described in [the current README](../../README.md). Building or checking this probe does not change the installed app, jobs or history.

The `amp-api.music.apple.com` host and reuse of web-player credentials are unofficial. On 14 October 2026, a scoped live test created a playlist with Radiohead's "No Surprises", appended "Karma Police" and read both catalog IDs back in order. This confirms that test account and session only. Sessions can expire, and Apple can change the contract. A build or mocked test alone is not live acceptance.

## Build and check

From the app repository:

```sh
bun experimental/web-session-probe/check.ts
bun experimental/web-session-probe/build.ts
```

The build reserves the next numbered directory under `../web-session-probe/`, compiles with `swiftc`, and ad hoc signs and verifies the bundle. It does not launch, install or register the app in Spotlight. The first bundle is `../web-session-probe/001/Wavelength Web Session Probe.app`. macOS 14 or later is required. The build targets the current machine's architecture.

Checks run the real Swift client and model through a `URLProtocol` fixture at the network boundary. Credential and attempt storage are fakes. They do not read or delete real Keychain items and do not contact Apple.

## Manual test in your own account

These steps change your Apple Music library. Run them only when you deliberately authorize that test, not as part of routine fixture checks. Do not share HAR captures or unredacted account data.

1. Open `music.apple.com` manually in Safari and sign in to your own Apple Music account.
2. If Safari's Develop menu is missing, open Safari > Settings > Advanced and turn on "Show features for web developers". Open Develop > Show Web Inspector, then its Network tab.
3. Open your library on the web player. Select a request to `amp-api.music.apple.com` and find its Request Headers.
4. Open the separate probe bundle in Finder. Copy only the value of `Authorization` into its first secure field and only the value of `Media-User-Token` into its second. The Authorization value may include `Bearer`. Never paste these values into chat, a terminal, an issue, a screenshot or a document.
5. Click "Save locally". The fields clear after a successful save. The app stores the values in its own macOS Keychain item and never displays the saved values.
6. Click "Check connection". This makes only GET requests, reads your authenticated storefront and searches for Radiohead's "No Surprises" and "Karma Police". Both title and artist must match exactly, ignoring case. Review the displayed catalog IDs and song order.
7. Click "Create test playlist" only when ready. This creates one uniquely named "Wavelength connection test" playlist with the first catalog song, appends the second song in a separate POST, then reads the tracks back. Success requires both catalog identities in the expected order. Inspect the playlist in Apple Music as well.

The app never opens a login page or extracts browser credentials. "Delete saved connection" deletes only the exact probe credential item. It does not delete playlists or the attempt record.

## Write outcomes

The probe allows one write attempt per saved attempt record. It records the attempt before sending the create request and saves a returned playlist ID before appending. Further writes stay blocked after reopening or rebuilding. The record contains only the attempt flag and playlist ID, at `~/Library/Application Support/Wavelength Web Session Probe/probe-attempt.json`.

No POST is retried by the probe. A network failure or malformed create reply may leave a playlist without a known ID. An uncertain append is followed only by readback. Readback allows five GET attempts with one second between them. If both identities and order remain unconfirmed, the result stays uncertain and the known ID remains visible. A 204 response alone is never success. Pagination, missing catalog mappings or malformed replies prevent confirmation. The app has no playlist deletion or automatic recovery action.

Keep the window open during a write. Closing or quitting shows a warning while the write is in progress. The saved attempt prevents a blind repeat after interruption. A returned ID is preserved when the process can receive and save it; a response lost during termination cannot be recovered by this spike.

Credentials use the fixed Keychain service `local.wavelength.web-session-probe.credentials.v1` and account `own-apple-music-web-session`, with `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`. The client uses an ephemeral `URLSession` without cookies, cache or credential storage, sends to a fixed Apple host and rejects every redirect. Errors expose safe classifications, never request headers, token values, raw server bodies or underlying error text.

## Contract references

Apple documents the public API host, playlist paths and resource shapes. This probe uses those paths on the unofficial web-player host. The scoped result above is not a supported API contract or a guarantee for other accounts.

- [Create a new library playlist](https://developer.apple.com/documentation/applemusicapi/create-a-new-library-playlist) describes attributes and the initial tracks relationship.
- [Add tracks to a library playlist](https://developer.apple.com/documentation/applemusicapi/add-tracks-to-a-library-playlist) describes a `data` array of catalog song references.
- [Get a library playlist's relationship directly by name](https://developer.apple.com/documentation/applemusicapi/fetch-a-relationship-on-this-resource-by-name-5l22w) documents `/v1/me/library/playlists/{id}/tracks` and shows library-song `attributes.playParams.catalogId` in its response example.
- [Get a library song](https://developer.apple.com/documentation/applemusicapi/get-a-library-song) also shows the catalog mapping. Library IDs such as `i.*` are never treated as catalog IDs.
- [bootleg client source](https://github.com/moudlajs/bootleg/blob/main/internal/applemusic/client.go), [playlist source](https://github.com/moudlajs/bootleg/blob/main/internal/applemusic/playlist.go) and [token documentation](https://github.com/moudlajs/bootleg/blob/main/docs/tokens.md) were read as a public reference. The Swift implementation is independent; no Go source was copied. Its mocked tests are not proof of a working live route.
- [Safari developer tools](https://support.apple.com/guide/safari/use-the-developer-tools-in-the-develop-menu-sfri20948/mac) and [Web Inspector Network tab](https://webkit.org/web-inspector/network-tab/) describe the manual browser workflow.

The recorded live result does not establish clean-machine installation or behavior for every account. Routine checks use fixtures and do not read the real Keychain or modify Music. See the main README for current integrated-app acceptance and limits.
