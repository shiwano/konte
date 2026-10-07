---
name: arch-comfy-api-guide
description: Read when touching where a comfy asset runs — comfy.adapters routing, Comfy Cloud's catalog check, the comfy-api backend, and a Comfy API deployment's Build, release, bring-up and idle close.
user-invocable: false
---

How a comfy asset is routed off a ComfyUI, and how a Comfy API deployment lives and dies (`src/comfy-api/`).

## Routing

- **Candidates** — `comfy.adapters[<workflow without .json>] ?? comfy.adapters["*"] ?? ["comfyui", "comfycloud"]`; the first usable wins (`ComfyRouter`). A key naming no `adapters/comfy/<key>.json`, or a `comfyapi:<name>` with no declaration, is a config error.
- **Usable** — `comfyui`: `comfy.comfyui.url` set. `comfycloud`: `COMFY_API_KEY` set and every `class_type` of the pruned graph is in Cloud's `/api/object_info` and every remaining model's `models/<folder>/<filename>` is in `/api/assets` (`ComfyCloudCatalog`, cached an hour in the workspace's `.konte/comfycloud.json`; `object_info`'s COMBO lists lag, so models are never read there). `comfyapi:<name>`: key set.
- **A deployment needs a live daemon** — reaching one with none refuses with `COMFY_API_DAEMON_REQUIRED` instead of falling through. Daemons register in `.konte/daemons/<pid>.json`, alive by pid + start time (`daemon-registry.ts`).
- **The route is never hashed** — it rides the job (`comfyTarget`, backend kind `comfy-api`), decided once by the spend gate (`assertSpendAllowed` → `SpendRoutes.targetOf`).
- **Prereqs by route** (`ensureComfyPrereqJobs`) — `comfyui`: model/node jobs; deployment: its `comfy-api-deploy` job; `comfycloud`: none.

## Runtime (`ComfyApiBackend`)

- One v2 client for Cloud and a deployment's `endpointUrl`; `backendJobId` is `<target>|<jobId>`.
- **Inputs** — blake3 → `HEAD by-hash` → `from-hash`, else multipart `POST /assets`; substituted into the graph as `core/ASSET` references.
- **Idempotency-Key = variant id** — so `beginSubmission` lets a comfy-api job resubmit, under the first attempt's seed and input files; a lost answer or `idempotency_key_reuse` is looked up in a deployment's `GET /jobs`, and is `SUBMISSION_UNCONFIRMED` on Cloud (no list). A 429 retries for 15 minutes.
- **Outputs** — the adapter's output node's, else every media output; `content`'s 302 is followed without the key. A failure writes `node_errors` and, on a deployment, the run's log to the job log.
- **A deployment submit** (`submitOnDeployment`) reconciles it with the current Build and compute, then records the job in `sentJobs` and uploads and POSTs, under its lock; delivery upscales skip the bring-up job. A deferred replacement holds it; a cancel then sends nothing.

## Deployment lifecycle (`deployment.ts`)

- **Build per deployment** — every workspace adapter whose whole-adapter route lands there (`routeAdapter`), models deduped by `type` + `filename` (two URLs for one is a config error), packs by id. A URL holding `${VAR}` is refused (`COMFY_API_AUTHENTICATED_MODEL`): the builder fetches anonymously and the definition would keep it.
- **Pins** — `baseComfyVersion` (GitHub latest release unless `comfyVersion`) and each pack's registry version are resolved only when the unpinned inputs change (`inputsHash`).
- **Bring-up** — Build create/`PATCH` → release (deduped per definition) → wait `deployable` → deployment with `min: 0` → wait `ready`. A release or GPU/region change, or a `failed`/`unhealthy` one, is deleted and recreated; `max` is `PATCH`ed. A replacement with a job on it (backend id recorded, or in `sentJobs` until it settles; never one still waiting to submit, or two would deadlock) is `COMFY_API_DEPLOY_DEFERRED`: the deploy job goes back to pending. The create is stored before sending (`pendingCreate`) and resent unchanged under its Idempotency-Key before a bring-up or a close. `job cancel` is read between steps; a deployment seen `stopped` while awaited is started. Serialized per deployment by `.konte/comfyapi-<name>.lock`; ids live in `.konte/comfyapi.json`, never a secret.
- **Close** — `close: delete` (default) or `stop` (a `stop_failed` one is closed again), once no video's job is pending/running on it and `idleMinutes` (default 15) passed since its last job or bring-up. Judged by the daemon each minute and at start, and at `job wait`'s end: there `idleMinutes: 0` closes, as does any with no daemon alive.
- **Daemon exit** — SIGINT/SIGTERM spawns `konte mcp close-deployments` detached: the host kills the daemon within ~0.5s and a cut-off DELETE does not take. It closes everything idle unless another daemon is alive.
