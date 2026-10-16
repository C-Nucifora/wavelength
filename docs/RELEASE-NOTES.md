# Wavelength 0.1.0 experimental

This first download is for Apple Silicon Macs running macOS 14 or later. It is ad hoc signed and unnotarized. It has not been tested on a clean Mac, and some machines may block it. Follow [Apple's instructions for opening an app from an unidentified developer](https://support.apple.com/en-au/102445) if you choose to approve it. Do not disable Gatekeeper or remove quarantine.

The app uses your Apple Music web session to create playlists. Treat that session as a credential. Music Automation is optional and supports cover updates and listening-history scans. The README explains connection storage, disconnecting, AI filtering and current limitations. Apple does not endorse this app.

Wavelength's first-party code is GPL-3.0-only. The bundled Bun runtime and its dependencies keep their upstream licenses. Keep the matching source archives, notices, manifest and checksums alongside this download. Bun 1.3.14+0d9b296af is pinned to the official Apple Silicon executable; ad hoc signing changes its packaged file hash, recorded separately in the manifest.

A clean Bun source rebuild and a modified-library relink have not been run for this release. See `licenses/RUNTIME-REBUILD.md` in the source archive for the tagged upstream build procedure and runtime replacement steps. The packaging checks establish file identity and signatures, not legal clearance or Apple service compatibility.
