---
name: arch-jobs-guide
description: Read when touching the job pipeline — standalone job kinds (comfy model/node provisioning, export), leader-elected run leases, keyframe normalization, and the MCP watcher's job handling.
user-invocable: false
---

How konte schedules, waits on, and finalizes backend jobs.

## Job kinds

A job records its backend kind and the addresses it depends on, and auto-submits once each has a ready variant.

A `defineComfyAsset` adapter declares the ComfyUI dependencies konte provisions before generating:

- `models` — weights, written into ComfyUI's model root when reachable (`HF_TOKEN` as bearer, which gated repos need), else via Manager.
- `nodes` — custom node packs via ComfyUI-Manager, by registry `cnr_id` only; a pack outside the registry is not auto-installed. Its `id` is the `custom_nodes` directory konte looks for.
- `konte adapter comfy import` scaffolds both blocks commented-out from an imported workflow.

Standalone kinds carry no asset/variant:

- comfy model downloads — deduped by install target (`type` + `savePath` + `filename`), so one filename across savePaths gets a job each; reuse refreshes the declaration and resets any terminal job, completed included, so a fixed `url` or a deleted file retries. Presence is read from the loader combos in `/object_info`, falling back to the `savePath` root's `/api/models/<root>` listing for a model no node exposes as a combo.
- comfy node installs — install-to-disk only, deduped per pack, reset like model downloads — paired with an activate job, deduped per pack set (one per run), that reboots ComfyUI once under a server-wide reboot lock keyed by baseUrl. A generation job needing nodes depends on the activate job, so nothing generates mid-reboot.
- `export` — a leaf render job (`arch-delivery-guide`).
- `song-analysis` — `arch-direction-guide`.

Activation:

- A reboot is destructive — a server not under a relauncher won't return. On failure konte raises `COMFY_NODE_RESTART_REQUIRED` for a manual restart; shared servers set `comfy.comfyui.autoRebootAfterNodeInstall: false`.
- It holds while any comfy job (generation, model-download, node-install) runs workspace-wide — a reboot would orphan it.

## Leader-elected waiting

- When several daemons of the workspace await one running job, a run lease (`job.lease`) makes exactly one the _owner_ — it runs the backend wait, downloads/normalizes the output, and commits the terminal state; the rest only _monitor_ the job record. A crashed owner's lease lapses and a monitor reclaims and re-attaches via the persisted backend job id — every backend job is re-observable by id. The same lease protects export and model-download workers.
- Waiting is unbounded, except comfy, whose prompt lives in the server process: it fails after `comfy.comfyui.unreachableTimeoutMinutes` of silence (0 = never; default 15 on a loopback URL, 0 on a remote one).
- `submissionStartedAt` is persisted under the submit lease before calling a backend. A reclaimed external job with that stamp and no backend id fails with `SUBMISSION_UNCONFIRMED` — check the backend before rerolling. A claim that never began submission, and a local operation, may retry.
- A committed submit keeps the submit lease, and the daemon submits and waits under one `workerId`, so its waiter takes that lease over and the job is never unwatched between submit and wait.
- Transient result-fetch and download-stream failures retry against the existing backend id. A wait timeout releases the run lease; the next waiter resumes retrieval.

## One worker, every video

- `mcp serve` elects one workspace worker under a file lock. Registrations use instance ids; local liveness uses pid/start time, foreign PID namespaces a 5s heartbeat (30s expiry). Registration and heartbeat survive the submit drain. EOF stops each connection.
- Only the worker loads `VideoRegistry`: a `JobWatcher` per video, `fs.watch` plus a 5s poll, credentials refreshed before startup and each tick.
- `status` includes locally watched videos (empty on standby).
- `.konte/logs/mcp.log` records lifecycle, worker and job events, tagged by instance id, URLs redacted. It rotates to `mcp.log.1` at 5 MB.

## What a judge reads

A cascade pass lists jobs, then reloads the definitions (`reloadLoadedDefinitions`), per iteration — no job is judged by definitions older than itself. A job records a source fingerprint at creation (`definition-source.ts`). On a hash mismatch:

- fingerprint moved → the definition changed; the job fails.
- fingerprint unchanged → the judge is stale: it releases the job (`releaseIfOwner`) and the daemon restarts (`RESTART_EXIT_CODE`, `supervise.ts`); a second stale judge fails it.

Exports do the same via `planDigest` / `decideExportRender`.

## Finalizing a take

- Keyframe normalization — a produced video whose keyframes are sparser than ~2s apart is re-encoded (before hashing) to add a keyframe roughly every second, so HyperFrames seeks reliably. It skips non-videos, already-dense videos, and alpha/HDR sources, logging what it did.
- Variant check — a take owing a line, bar the song, is heard by SenseVoice into `heard.json`; an audio-bearing one is measured `silent` in its media record. `variant-check.ts` finds a silent audio or line take and one whose heard words miss its line (`line-hearing.ts`). `job wait` names a finding on landing; undecided and unvouched (`konte vouch`), it is a `take-silent` / `line-misheard` finding and `konte preview` refuses.
