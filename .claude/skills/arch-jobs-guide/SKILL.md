---
name: arch-jobs-guide
description: Read when touching the job pipeline — standalone job kinds (comfy model/node provisioning, export), leader-elected run leases, keyframe normalization, and the MCP watcher's job handling.
user-invocable: false
---

How konte schedules, waits on, and finalizes backend jobs.

## Job kinds

Each job records its backend kind and the asset addresses it depends on, and auto-submits once all those dependencies have a ready variant. Besides generation jobs, several standalone kinds carry no asset/variant of their own:

A `defineComfyAsset` adapter declares its ComfyUI dependencies so konte provisions them before generating: `models` (weights — konte writes them into ComfyUI's model root when reachable, `HF_TOKEN` as bearer; gated repos need that, else Manager) and `nodes` (custom node packs via ComfyUI-Manager, by registry `cnr_id` only — a pack outside it is not auto-installed, and its `id` is the `custom_nodes` directory konte looks for). `konte adapter comfy import` scaffolds both blocks commented-out from an imported workflow.

- **comfy model downloads** — deduped by install target (`type` + `savePath` + `filename`), so one filename across savePaths gets a job each; reuse refreshes the declaration and resets any terminal job, completed included, so a fixed `url` or a deleted file retries.
  Presence is read from the loader combos in `/object_info`, falling back to the `savePath` root's `/api/models/<root>` listing for a model no node exposes as a combo.
- **comfy node installs** — shared/deduped per pack, install-to-disk only — paired with an **activate** job that reboots ComfyUI once (under a server-wide reboot lock keyed by baseUrl) so the new nodes load. Deduped per pack set (one per run, not per asset), reset like the installs above. A generation job that needs nodes depends on the activate job, so nothing generates mid-reboot.
- **`export` jobs** — a leaf render job (see the `arch-delivery-guide` skill).

A reboot is destructive (a server not under a relauncher won't return): on failure konte raises `COMFY_NODE_RESTART_REQUIRED` for a manual restart; shared servers set `comfyui.autoRebootAfterNodeInstall: false`. Activation also holds while any comfy job (generation, model-download, node-install) is running workspace-wide, or the reboot orphans it.

## Leader-elected waiting

When several processes (the MCP watcher, a `konte job wait`) await the same running job, a **run lease** (`job.lease`) makes exactly one the _owner_ — it runs the backend wait, downloads/normalizes the output, and commits the terminal state; the rest only _monitor_ the job record. If the owner crashes, its lease lapses and a monitor reclaims and re-attaches via the persisted backend job id (every backend job is re-observable by id). The same lease protects export and model-download workers.

Waiting is unbounded, except comfy, whose prompt lives in the server process: it fails after `comfyui.unreachableTimeoutMinutes` of silence (default 15, 0 = never).

Before calling a backend, `submissionStartedAt` is persisted under the submit lease. A reclaimed external job with that stamp and no backend id fails with `SUBMISSION_UNCONFIRMED`: check the backend before rerolling. A claim that never began submission and a local operation may retry.

Transient result-fetch and download-stream failures retry against the existing backend id. A wait timeout releases the run lease; the next waiter resumes retrieval.

## One daemon, every video

`konte mcp serve` runs per workspace: a `VideoRegistry` (`src/mcp/video-registry.ts`) keeps a `JobWatcher` per video under `videos/`, following videos as they appear and disappear (`fs.watch` plus a 5s reconcile poll, since `fs.watch` drops events under WSL2). Credentials are re-applied each tick, dropping stale-keyed backends. `konte workspace new` configures it in `.mcp.json` (Claude Code) and `.codex/config.toml` (Codex).

It registers **no tool, resource or prompt**. Outcomes come from `konte job wait`, which drives the same cascade itself and so works with the daemon down.

Every daemon of the workspace appends to `.konte/logs/mcp.log` (`src/mcp/mcp-log.ts`): its start and stop, the videos it watches, and each info-or-above event it sends its client, tagged with a per-daemon instance id and URLs redacted. Past 5 MB the file moves to `mcp.log.1`.

## What a judge reads

A cascade pass lists jobs, then reloads the definitions (`reloadLoadedDefinitions`), per iteration — no job is judged by definitions older than itself, in the daemon or in `job wait`. A job records a **source fingerprint** at creation (`definition-source.ts`). On a hash mismatch, fingerprint moved → the definition changed and the job fails; unchanged → the judge is stale: it **releases** the job (`releaseIfOwner`) and the daemon restarts (`RESTART_EXIT_CODE`, `supervise.ts`); a second stale judge fails it. Exports do the same via `planDigest` / `decideExportRender`.

## Keyframe normalization

A produced video whose keyframes are sparser than ~2s apart is re-encoded (before hashing) to add a keyframe roughly every second, so HyperFrames seeks reliably. It skips non-videos, already-dense videos, and alpha/HDR sources (a re-encode would degrade them); the action is logged to the job log.
