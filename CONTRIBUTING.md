# Contributing

Keep changes focused and preserve existing user data and unrelated work. Follow the TypeScript and Swift style already present. Discuss substantial behavior changes before implementing them. Contributions to Wavelength use GPL-3.0-only; preserve third-party license notices.

On macOS 14 or later with Bun 1.3.14 and Apple's Command Line Tools, run the fixture commands in [README.md](README.md#development). Add a focused regression check for behavior changes. The WebMusic, artwork, auth-wrapper and native suites use fake account/Music boundaries. Keep CI credential-free.

Do not read real Keychain items, connect an Apple account, scan Music or create/change playlists as part of routine checks. Live acceptance needs the account owner's explicit authorization, a narrow test scope and a separate report of observed results. Never substitute mocked tests for clean-machine or account acceptance.

Before submitting, run `git diff --check`, inspect the actual diff and remove private data, HAR captures, personal absolute paths, generated bundles and signing material. Ignore rules are a backup, not a disclosure check. Explain what changed, which checks passed and what remains unverified. Use short commit messages without AI authorship credit. See [SECURITY.md](SECURITY.md) for vulnerability reports.
