---
name: arch-managed-binaries-guide
description: Read when touching binary provisioning — the version-pinned managed ffmpeg/ffprobe, Chromium, tsc and cloudflared, the pinned-checksum manifest, the workspace tool cache, and how each one's override and fallback differ.
user-invocable: false
---

How konte supplies its external tools — each a version-pinned build fetched on first use — and where each one's override/fallback diverges.

The tools: **ffmpeg/ffprobe** (local media ops, rendering, audio muxing), **Chromium** (HyperFrames rendering), **tsc** (type-checking user workspaces — the native TypeScript build, shipped as the platform package `@typescript/typescript-<platform>-<arch>`), **cloudflared** (`konte preview --tunnel`), and the embedded **hyperframes** runtime assets.

- **ffmpeg/ffprobe** default to the managed build; override with `KONTE_FFMPEG_PATH` / `KONTE_FFPROBE_PATH`, or `local.ffmpegPath` / `local.ffprobePath` in `konte.config.json` (an override is version-checked; there is no automatic PATH fallback).
  - konte's own calls spawn the absolute path, but HyperFrames hardcodes `spawn("ffmpeg")` with no path option, so `ensureHyperFrames` calls `leadPathWithFfmpeg()` to put the resolved binaries' directory at the head of `PATH`. It skips an override a PATH lookup cannot honor (a bare name is already one; a renamed `ffmpeg-7` is not a name to look up), so `vitest.setup.ts`'s bare-name override leaves `PATH` untouched.
- **cloudflared** defaults to the managed build; override with `KONTE_CLOUDFLARED_PATH` (not version-checked).
- **tsc** defaults to the managed build; override with `KONTE_TSC_PATH` (not version-checked). The type-check passes `--noEmit --pretty` (which the JS `tsc` also accepts, so the test suite pins the override at the repo's `tsc` to keep a cold cache offline); `konte lsp` passes `--lsp -stdio`, which only the native build takes.
- **Chromium** defaults to the managed `chrome-headless-shell`, installed by `@puppeteer/browsers` into `chromium-<buildId>/`; override with `KONTE_CHROMIUM_PATH` (not version-checked). The build id is pinned to puppeteer's own `PUPPETEER_REVISIONS`, since HyperFrames drives the shell over CDP through its bundled puppeteer.
  - `ensureChromium` also exports `PRODUCER_HEADLESS_SHELL_PATH`, the env var HyperFrames reads before falling back to `~/.cache/puppeteer` — a cache only `bun install` fills, so a released konte binary finds nothing there. That fallback is why the managed build cannot be optional.

## Checksums

Every managed-tool artifact is pinned by SHA-256 in `src/core/tool-checksums.ts`, keyed by its download URL. `downloadFile` resolves that pin before fetching, hashes the stream, and checks it in `streamToFileAtomic`'s verify hook — before the rename, so a mismatch (`CHECKSUM_MISMATCH`) leaves nothing at the destination. An unpinned URL fails too (`CHECKSUM_UNKNOWN`): every caller of `downloadFile` is a managed tool, so there is no unverified download to add, and no skip flag. Chromium is the one artifact konte does not fetch itself — `ensureChromium` hands the same pin to `install({ expectedHash })`.

A pin only holds against an immutable artifact, which is why ffmpeg fetches BtbN's dated `autobuild-<date>` tag (`BTBN_TAG` + `BTBN_BUILD`) and not its rolling `latest` — a month-end tag, as BtbN prunes the others after about two weeks; `BTBN_VERSION` is the branch it was cut from.

Each runtime directory carries a `.konte-verified` marker holding the pins it was built from, written last, and every resolver asks `toolCacheReady(dir, pin, files)` rather than `existsSync`: the marker says the bytes were verified into it, `files` that they are still there. One check, four holes: an install left by a konte that verified nothing, a half-extracted one, a binary deleted underneath a good marker, and a pin that moves under an unchanged directory name (a BtbN tag-only bump).

Provisioning runs inside `withToolCacheLock`, which re-checks readiness once it holds the lock. The lock is what makes `resetToolCacheDir` safe: emptying the directory first is the only way to keep `@puppeteer/browsers` from extracting a killed download's leftover archive (it skips `expectedHash` for one already on disk), but two processes doing it unlocked would delete each other's downloads. The lock file is a sibling of the directory, never inside it. Still unaddressed: a pin bumped while another process holds a memoized path into that directory.

`bun run update:tool-checksums` regenerates the manifest across every supported platform/arch (targets in `scripts/lib/tool-download-urls.ts`). Run it after bumping a version and read the diff: a hash that moved without its version is an artifact replaced in place. `tool-checksums.test.ts` does not trust that target list — it sweeps the whole platform × arch product and pins whatever a resolver hands back a URL for.

## The tool cache

`toolCacheDir(name)` (`src/core/tool-cache.ts`) resolves where a runtime lives, in order:

1. `KONTE_CACHE_DIR` — a shared cache for CI or Nix. `vitest.setup.ts` points it at a throwaway dir so no test can write the developer's real cache.
2. `<workspace>/.konte/tools/` — the default. Deleting a workspace removes everything konte installed into it.
3. `$XDG_CACHE_HOME/konte` or `~/.cache/konte` — the fallback outside a workspace, needed because an editor launches `konte lsp` from anywhere and it still needs tsc.

The workspace root comes from `workspaceRootOrNull()` (`src/core/workspace-context.ts`), a process global set once in the CLI preAction.

Each directory name pins the identity of what it holds — `ffmpeg-<version>`, `tsc-<version>`, `chromium-<version>`, `hyperframes-<contentHash>`. hyperframes is keyed by content hash. It is written out of the binary rather than downloaded, so it is the one runtime with nothing to pin, and the one whose resolver still goes by the files existing.

`konte workspace new` prefetches ffmpeg, tsc, Chromium and cloudflared (sequentially — parallel progress lines interleave into noise). A prefetch failure warns and continues.
