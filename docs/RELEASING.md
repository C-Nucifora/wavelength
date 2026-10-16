# Preparing an experimental release

Prepare locally on Apple Silicon macOS. Publication, signing enrollment and notarization are separate decisions. The release helper never installs or launches the app, reads an Apple Music account, or uses a personal signing identity.

## Review the source snapshot

Run the tests and review the working tree, including staged changes and untracked feature files. The source must include the current covers, discography and signing code, even when those files are absent from HEAD. Preserve the existing index.

Create a JSON array containing the exact relative paths approved for release. Keep this review list and its generated snapshot outside the repository. Compare the list with `git ls-files --cached --others --exclude-standard`; do not blindly approve the command's output. Exclude personal signing configuration, data, credentials, dependencies and scratch artifacts. The helper refuses missing, extra, changed or forbidden files, and refuses symlinks.

```sh
bun scripts/release.ts snapshot . /path/to/reviewed-files.json /path/to/new-snapshot.json
```

Have a separate reviewer check the snapshot list and the actual files it identifies. Any later edit requires a fresh snapshot and review of that edit. Git HEAD alone does not identify this working tree.

## Prepare runtime materials

`licenses/runtime-sources.json` names each required companion file and its SHA256 hash. Download or copy exactly those files into a separate materials directory, preserving their relative paths. The inventory includes the Bun source, patched WebKit, TinyCC and other native dependencies, npm fallback sources and Cargo sources. `licenses/BUN-LICENSE.md` preserves Bun's tagged notice; `licenses/THIRD-PARTY-NOTICES.txt` contains the collected license text. The source archives retain file-level copyright notices too.

The official runtime archive and extracted executable are pinned in `scripts/release.ts`. Verify the archive SHA256, extract it in the materials directory and use that executable to run the release helper. A local Bun installation with the same version number is insufficient if its hash differs.

```sh
/path/to/bun-darwin-aarch64/bun scripts/release.ts package \
  /path/to/reviewed-snapshot.json /path/to/materials /path/to/new-release-directory
```

The output directory must not exist. The helper checks the snapshot and materials before building, builds from a separate extracted source tree, forces ad hoc signing, verifies the app and nested executable signatures, checks arm64 architecture, and creates the app ZIP with `ditto`. No certificate or Keychain operation is needed. Local development builds keep their existing signing behavior.

The release directory contains the app and matching source ZIPs, companion runtime sources, a source snapshot, release notes, GPL license, a provenance manifest and `SHA256SUMS`. Companion archives remain separate to stay below GitHub's 2 GiB per-asset limit. A failed build can leave an incomplete output directory; inspect it and use a new directory for a retry.

## Verify before publication

```sh
bun scripts/release.ts verify /path/to/release-directory
cd /path/to/release-directory
shasum -a 256 -c SHA256SUMS
```

Extract both ZIPs to new directories. Compare source files with `source-snapshot.json`, inspect the packaged resources for credentials and personal paths, and run the packaged-engine and icon checks. Verify strict signatures again after extraction. Run the full Bun suite, typecheck, JavaScript syntax checks and Swift fixture suites without live account or Music operations. Review the actual artifacts independently.

Record which machine and toolchain performed verification. Disclose unverified clean-machine, Gatekeeper and clean Bun rebuild behavior. Keep all companion files available beside the binary. Do not describe a release as distributable while `runtime-sources.json` lists unresolved requirements. Pattern scans do not prove the absence of secrets. Current-document cleanup does not remove names, email addresses or paths from Git history.
