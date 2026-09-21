---
name: config-guide
description: Read when a key "is not set" or konte doctor reports a backend failure — API keys, the ComfyUI connection, editor type-checking.
user-invocable: false
---

Configure the required backends and editor; done = those backends pass `konte doctor --backends`.

## API keys

1. Run `konte doctor --backends` — each unconfigured backend prints the variable name and where to obtain it.
   - **WARN = survey only** — configure only the backends you'll use; plain `konte doctor` FAILs on one an asset uses.
2. Ask the user to run `konte settings` and set the listed keys on the **Credentials** tab — you cannot read or edit `konte.credentials.json`. Name the keys and the source URL from the message.
3. Re-run `konte doctor --backends` to confirm the backends you need now report connected.

- **An adapter missing from `konte adapter list`** → its backend is unconfigured (`--all` shows it); `generate` refuses it. `file`/`local` assets need no backend.

## ComfyUI connection

- **`comfyui.url`** — edit `konte.config.json` directly, or use `konte settings`' **Config** tab.
- `cannot reach <url>` → check in order: ① ComfyUI is running, ② `comfyui.url` host/port, ③ the host resolves from where konte runs (WSL2: below).
- `rejected the credentials` → check the `comfyui.headers` placeholder and its Credentials entry.
- **A ComfyUI behind an auth front** (a remote pod, a reverse proxy) takes `comfyui.headers`, sent on every request. **A credential header is always a `${VAR}` placeholder** (an auth scheme may precede it), stored under Credentials — a literal is rejected.

  ```json
  { "comfyui": { "url": "https://…", "headers": { "Authorization": "Bearer ${COMFYUI_TOKEN}" } } }
  ```

- **WSL2: `127.0.0.1` points at WSL itself, not a ComfyUI running on Windows** — either enable WSL mirrored networking (`networkingMode=mirrored` in `%UserProfile%\.wslconfig`, then `wsl --shutdown`; needs Win11 22H2+) so `127.0.0.1` works unchanged, or set `comfyui.url` to the Windows host IP (can change on reboot).

## Editor type-checking

`konte lsp` is a language server providing TypeScript diagnostics and completion in `video.tsx` / `animatic.tsx`.

- **Claude Code**: automatic — `konte workspace new` ships a `konte-lsp` plugin under `.claude/skills/`. Accept the workspace trust prompt.
- **VSCode**: no setup.
- **Neovim**: use the workspace binary's absolute path with `lsp` as the language-server command, and `konte.config.json` as its root marker.

## Done

- **Return to the skill that sent you**; on a fresh project with no video yet, start with the `drafting-guide` skill.
