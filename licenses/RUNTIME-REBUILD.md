# Bun source and replacement instructions

The shipped runtime starts with Bun `1.3.14+0d9b296af`, source commit `0d9b296af33f2b851fcbf4df3e9ec89751734ba4`. Wavelength changes its signature to ad hoc but does not patch its executable code. The release manifest records the original and packaged hashes.

Bun's `LICENSE.md` identifies static JavaScriptCore/WebKit under LGPL-2 and TinyCC under LGPL-2.1. Their full source, upstream licenses and Bun's build scripts and patches accompany this release. Wavelength imposes no additional restriction on modifying these libraries, relinking the runtime, or reverse engineering needed to debug those modifications. Other components retain their upstream terms. This source package is provided with the binary, rather than as a promise to provide it later.

## Sources and prerequisites

Extract `bun-1.3.14.tar.gz` and `webkit-full-source.tar.gz` into a separate workspace. Preserve the sources' directory layout. The latter extracts to `WebKit-5488984d20e0dbfe4be2c3ba8fb18eb81a5e0e8b/` and contains the full upstream Git archive, including tests. The inventory pins WebKit `5488984d20e0dbfe4be2c3ba8fb18eb81a5e0e8b` and TinyCC `12882eee073cfe5c7621bcfadf679e1372d4537b`. Bun applies `patches/tinycc/tcc.h.patch` during dependency preparation. Other patches remain in the Bun archive.

Use the instructions in that archive's `CONTRIBUTING.md` and its `scripts/build/` implementation. This tag requires LLVM 21.1.8, Xcode/SDK tools, CMake, Ninja, Rust nightly with `rust-src`, and the other prerequisites listed there. Bun downloads its pinned Zig compiler. The companion `zig-source.tar.gz` also preserves that fork's source and standard library at `04e7f6ac1e009525bc00934f20199c68f04e0a24`. A bootstrap Bun executable is also needed. These development tools are separate from the supplied program sources.

The old `make jsc` / `zig build` sequence in Bun's license page does not describe this tag's current build system. Its `build:release:local` command selects local WebKit and rebuilds it with Bun's bindings.

## Rebuild with changed libraries

From the extracted Bun directory, install its locked build dependencies with lifecycle scripts disabled, then use the tagged build command. Set `BUN_WEBKIT_PATH` to the extracted, optionally modified WebKit tree.

```sh
bun install --frozen-lockfile --ignore-scripts
BUN_WEBKIT_PATH=/absolute/path/to/WebKit-source bun run build:release:local
```

The result is `build/release-local/bun`, with an unstripped `bun-profile` alongside it. This is the tagged upstream local rebuild procedure. It does not promise bit-for-bit equivalence with Bun's optimized upstream CI release. Inspect the tag's build prerequisites before running it. A clean build and modified-library relink have not been tested here. The upstream configuration requests Rust nightly with `rust-src` but does not pin the official build's nightly revision. Rust license texts in the notice appendix are references, not an assertion of that compiler version.

The native dependency archives are the exact pins from `scripts/build/deps/`. Bun's fetch helper caches them by the SHA256 of `https://github.com/OWNER/REPO/archive/REVISION.tar.gz`, using the first 16 hexadecimal characters. For example, `tinycc-HASH.tar.gz` goes under `cacheDir/tarballs`. Select a separate cache with `bun scripts/build.ts --profile=release-local --build-dir=build/release-local --cache-dir=/absolute/path/to/rebuild-cache`. The archive inventory includes each repository and revision. The standard build can also fetch those same pinned upstream sources.

To modify TinyCC, first let the tagged build prepare `vendor/tinycc` and apply its patch. Modify that prepared tree while preserving its `.ref` marker, then rebuild. The build compares the pinned source and patch identity, and preserves local edits when that identity matches. Changing the dependency pin or patches can invalidate and replace the prepared tree, so keep your modifications separately.

`npm-fallback-sources.tar.gz` contains the 128 non-platform-compiler npm tarballs in `src/node-fallbacks/bun.lock`, their URLs and integrity values. No package lifecycle scripts were run while collecting them. `lolhtml-cargo-sources.tar.gz` contains the 43 crates selected by the supplied lol-html `c-api/Cargo.lock`, including Cargo's checksums and licenses. To use those crates offline, extract them and configure Cargo's `source.crates-io.replace-with` to a `source.vendored-sources.directory` pointing at that extracted directory, in the rebuild workspace only. Rust compiler standard-library sources come with the chosen `rust-src` toolchain.

## Replace the runtime in your app copy

Work on a separate extracted copy of `Wavelength.app`. Quit that copy first. Replace `Contents/Resources/bin/bun` with your rebuilt executable, preserve executable permissions, then sign that executable and the outer app ad hoc and verify the result.

```sh
cp /path/to/rebuilt/bun /path/to/Wavelength.app/Contents/Resources/bin/bun
chmod 755 /path/to/Wavelength.app/Contents/Resources/bin/bun
codesign --force --sign - --identifier local.wavelength.engine /path/to/Wavelength.app/Contents/Resources/bin/bun
codesign --force --sign - /path/to/Wavelength.app
codesign --verify --deep --strict /path/to/Wavelength.app
```

This uses no personal certificate. Do not disable Gatekeeper or remove quarantine. macOS may require a new per-app approval and may block an unnotarized copy. The release helper intentionally accepts only the pinned official runtime for the original public artifact; it does not prevent you from rebuilding and replacing the runtime in your own copy.
