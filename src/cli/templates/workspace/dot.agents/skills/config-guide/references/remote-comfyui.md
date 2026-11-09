# ComfyUI on the user's machine, konte on a remote VM

Connect konte to a ComfyUI on the user's own machine over a private network, never a public port; done = `konte doctor --backends` reports `comfyui` connected.

## The user's machine

Hand the user these steps:

1. Join the machine to a private network the VM also joins (Tailscale: the same tailnet).
2. Start ComfyUI listening on that network's address only: `--listen <the machine's tailnet IP>`, its port unchanged (ComfyUI Desktop: 8000, otherwise 8188) — `0.0.0.0` also exposes it on the LAN.
3. Allow only the VM to reach that port (Tailscale: an ACL grant from the VM's device to the machine on `tcp:<port>`) — ComfyUI has no authentication of its own.

- Never a router port forward, Tailscale Funnel or a public tunnel URL.

## The VM

- `comfy.comfyui.url` = `http://<the machine's tailnet IP or MagicDNS name>:<port>`.
- The VM reaches the network only through an HTTP proxy (Tailscale userspace networking) → set `HTTP_PROXY` to its `http://` address where konte runs, the way API keys are set. Leave `HTTPS_PROXY` unset — fal and Comfy Cloud are `https://` and stay direct.
- **`comfy.comfyui.autoInstallNodes: false`** — a custom node pack runs arbitrary code on the user's machine. Hand the user the packs each comfy adapter's `nodes` lists to install.
- `comfy.comfyui.autoInstallModels` writes to the user's disk — ask the user before leaving it on.
- An authenticating reverse proxy in front of ComfyUI → `comfy.comfyui.headers` (the ComfyUI connection section); it must also forward the WebSocket upgrade on `/ws`.

## Pitfalls

- `cannot reach <url>` → the machine is asleep, ComfyUI started before the network had its address, or the ACL omits the VM.
- A job keeps waiting while the machine is unreachable — a remote ComfyUI has no unreachable timeout by default (`comfy.comfyui.unreachableTimeoutMinutes`).
