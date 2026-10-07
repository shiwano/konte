---
name: config-guide
description: Read when a key "is not set", konte doctor reports a backend failure, or a comfy asset routes to the wrong place — API keys, the ComfyUI connection, Comfy Cloud and Comfy API routing, editor type-checking.
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

- **`comfy.comfyui.url`** — edit `konte.config.json` directly, or use `konte settings`' **Config** tab.
- `cannot reach <url>` → check in order: ① ComfyUI is running, ② `comfy.comfyui.url` host/port, ③ the host resolves from where konte runs (WSL2: below).
- `rejected the credentials` → check the `comfy.comfyui.headers` placeholder and its Credentials entry.
- **A ComfyUI behind an auth front** (a remote pod, a reverse proxy) takes `comfy.comfyui.headers`, sent on every request. **A credential header is always a `${VAR}` placeholder** (an auth scheme may precede it), stored under Credentials — a literal is rejected.

  ```json
  {
    "comfy": {
      "comfyui": { "url": "https://…", "headers": { "Authorization": "Bearer ${COMFYUI_TOKEN}" } }
    }
  }
  ```

- **WSL2: `127.0.0.1` points at WSL itself, not a ComfyUI running on Windows** — either enable WSL mirrored networking (`networkingMode=mirrored` in `%UserProfile%\.wslconfig`, then `wsl --shutdown`; needs Win11 22H2+) so `127.0.0.1` works unchanged, or set `comfy.comfyui.url` to the Windows host IP (can change on reboot).

## Comfy routing

- **`comfy.adapters`** — per adapter (workflow file name without `.json`), the targets tried in order; `*` is the default, an adapter's own key replaces it whole. `generate` prints each asset's target.
  - `comfyui` — usable when `comfy.comfyui.url` is set.
  - `comfycloud` — usable when `COMFY_API_KEY` is set and Comfy Cloud has every node and model the asset uses.
  - `comfyapi:<name>` — a deployment under `comfy.comfyapi.deployments` (optional `comfyVersion`). Usable when `COMFY_API_KEY` is set.
- **`COMFY_API_DEPLOYMENT_NOT_READY`** → the Comfy API deployment steps below.
- **`BACKEND_NOT_CONFIGURED` on a comfy asset** → each candidate's reason is listed; set what it names, or add a target to the adapter's key.
- **An adapter your ComfyUI cannot run (VRAM)** → give it its own key without `comfyui` — konte cannot tell.

## Comfy API deployment

konte builds a deployment's Build and release; the user creates and deletes the deployment on the Build page — konte never does.

1. **Run `konte adapter comfy build` in the background** — a changed Build takes several minutes. Exit 0 → ready; done.
2. **Exit 1** → it opened the Build page and printed its URL. Tell the user, with that URL:
   - press **Deploy** on the release it names, keeping **Always-warm workers** at 0 — above 0 bills a GPU for as long as the deployment exists
   - it reaches ready in a few minutes
3. **Once the user has deployed it**, run the command again until it exits 0.

- **A deployment named as running an earlier release** → ask the user to delete it on the same page — a deployment bills its models' storage until deleted.
- **Done with Comfy API for now** → the user may delete the deployment on the Build page; the next `konte adapter comfy build` asks for a new one.

## Editor type-checking

`konte lsp` is a language server providing TypeScript diagnostics and completion in `video.tsx` / `animatic.tsx`.

- **Claude Code**: automatic — `konte workspace new` ships a `konte-lsp` plugin under `.claude/skills/`. Accept the workspace trust prompt.
- **VSCode**: no setup.
- **Neovim**: use the workspace binary's absolute path with `lsp` as the language-server command, and `konte.config.json` as its root marker.

## Done

- **Return to the skill that sent you**; on a fresh project with no video yet, start with the `drafting-guide` skill.
