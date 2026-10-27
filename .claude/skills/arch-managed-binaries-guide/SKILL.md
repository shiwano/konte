---
name: arch-managed-binaries-guide
description: Read when touching binary provisioning — the version-pinned managed ffmpeg/ffprobe, Chromium, tsc and cloudflared, the pinned-checksum manifest, the workspace tool cache, and how each one's override and fallback differ.
user-invocable: false
---

How konte supplies its external tools — each a version-pinned build fetched on first use — and where each one's override/fallback diverges.

The tools: ffmpeg/ffprobe (local media ops, rendering, audio muxing), Chromium (HyperFrames rendering), tsc (type-checking user workspaces — the native TypeScript build, platform package `@typescript/typescript-<platform>-<arch>`), cloudflared (`konte preview --tunnel`), sherpa-onnx + its models (song analysis, line hearing), Beat This! (song beat tracking), and the embedded hyperframes runtime assets.

- ffmpeg/ffprobe — managed by default; override `KONTE_FFMPEG_PATH` / `KONTE_FFPROBE_PATH` or `local.ffmpegPath` / `local.ffprobePath` in `konte.config.json` (version-checked; no automatic PATH fallback).
  - konte spawns the absolute path, but HyperFrames hardcodes `spawn("ffmpeg")`, so `ensureHyperFrames` calls `leadPathWithFfmpeg()` to put the resolved binaries' directory at the head of `PATH`. It skips an override a PATH lookup cannot honor (a bare name already is one; a renamed `ffmpeg-7` is not), so `vitest.setup.ts`'s bare-name override leaves `PATH` untouched.
- cloudflared — managed, fetched on the first tunnel; override `KONTE_CLOUDFLARED_PATH` (not version-checked).
- tsc — managed; override `KONTE_TSC_PATH` (not version-checked). The type-check passes `--noEmit --pretty`, which the JS `tsc` also accepts — the test suite pins the override at the repo's `tsc` to keep a cold cache offline; `konte lsp` passes `--lsp -stdio`, native build only.
- sherpa-onnx — models fetched on first use; override `KONTE_SHERPA_SEPARATION_PATH` / `KONTE_SHERPA_RECOGNIZER_PATH` / `KONTE_SPLEETER_MODEL_DIR` / `KONTE_SENSE_VOICE_MODEL_DIR`.
- Beat This! — model fetched on first use, `onnxruntime-web` WASM embedded; override `KONTE_BEAT_THIS_MODEL_DIR`.
- Chromium — managed `chrome-headless-shell` (Chrome for Testing's `chrome.exe` on Windows, whose shell is a console binary that opens a console window per child process), installed by `@puppeteer/browsers` into `chromium-<buildId>/`; override `KONTE_CHROMIUM_PATH` (not version-checked). The build id is pinned to puppeteer's `PUPPETEER_REVISIONS` — HyperFrames drives the shell over CDP through its bundled puppeteer.
  - `ensureChromium` also exports `PRODUCER_HEADLESS_SHELL_PATH`, which HyperFrames reads before falling back to `~/.cache/puppeteer` (filled only by `bun install`) — so the managed build cannot be optional.

## Checksums

- Every managed-tool artifact is pinned by SHA-256 in `src/core/tool-checksums.ts`, keyed by download URL. `downloadFile` resolves the pin before fetching, hashes the stream, and checks it in `streamToFileAtomic`'s verify hook before the rename — a mismatch (`CHECKSUM_MISMATCH`) leaves nothing at the destination.
- An unpinned URL fails (`CHECKSUM_UNKNOWN`) — every `downloadFile` caller is a managed tool, so there is no unverified download and no skip flag.
- Chromium is the one artifact konte does not fetch itself — `ensureChromium` hands the same pin to `install({ expectedHash })`.
- A pin holds only against an immutable artifact — ffmpeg fetches BtbN's dated `autobuild-<date>` tag (`BTBN_TAG` + `BTBN_BUILD`), never the rolling `latest`, and a month-end one, as BtbN prunes the others after about two weeks; `BTBN_VERSION` is the branch it was cut from.
- Each runtime directory carries a `.konte-verified` marker of its pins, written last; every resolver asks `toolCacheReady(dir, pin, files)`, never `existsSync` — the marker says the bytes were verified in, `files` that they are still there. It catches an unverified install, a half-extracted one, a binary deleted under a good marker, and a pin moving under an unchanged directory name (a BtbN tag-only bump).
- Provisioning runs inside `withToolCacheLock`, which re-checks readiness once held. The lock makes `resetToolCacheDir` safe: emptying the directory first is the only way to stop `@puppeteer/browsers` extracting a killed download's leftover archive (it skips `expectedHash` for one already on disk), and two unlocked processes would delete each other's downloads. The lock file is a sibling of the directory, never inside it. Still open: a pin bumped while another process holds a memoized path into that directory.
- `bun run update:tool-checksums` regenerates the manifest across every supported platform/arch (targets in `scripts/lib/tool-download-urls.ts`). Run it after a version bump and read the diff — a hash that moved without its version is an artifact replaced in place. `tool-checksums.test.ts` sweeps the whole platform × arch product, not that target list, and pins whatever a resolver returns a URL for.

## The tool cache

`toolCacheDir(name)` (`src/core/tool-cache.ts`) resolves a runtime's directory, in order:

1. `KONTE_CACHE_DIR` — a shared cache for CI or Nix; `vitest.setup.ts` points it at a throwaway dir so no test writes the developer's real cache.
2. `<workspace>/.konte/tools/` — the default; deleting a workspace removes everything konte installed into it.
3. `$XDG_CACHE_HOME/konte` or `~/.cache/konte` — outside a workspace, since an editor launches `konte lsp` from anywhere and it still needs tsc.

- The workspace root is `workspaceRootOrNull()` (`src/core/workspace-context.ts`), a process global set once in the CLI preAction.
- Each directory name pins its contents' identity — `ffmpeg-<version>`, `tsc-<version>`, `chromium-<version>`, `hyperframes-<contentHash>`. hyperframes is written out of the binary, not downloaded — the one runtime with nothing to pin, whose resolver still checks the files exist.
- `konte workspace new` prefetches ffmpeg, tsc, Chromium and sherpa-onnx one at a time; a failure warns and continues.
