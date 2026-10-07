---
name: arch-comfy-api-guide
description: Read when touching where a comfy asset runs — comfy.adapters routing, Comfy Cloud's catalog check, the comfy-api backend, and a Comfy API deployment's Build, release and readiness gate.
user-invocable: false
---

How a comfy asset is routed off a ComfyUI, and how konte builds a Comfy API deployment's Build and finds the deployment the human made of it (`src/comfy-api/`).

## Routing

- **Candidates** — `comfy.adapters[<workflow without .json>] ?? comfy.adapters["*"] ?? ["comfyui", "comfycloud"]`; the first usable wins (`ComfyRouter`). A key naming no `adapters/comfy/<key>.json`, or a `comfyapi:<name>` with no declaration, is a config error.
- **Usable** — `comfyui`: `comfy.comfyui.url` set. `comfycloud`: `COMFY_API_KEY` set and every `class_type` of the pruned graph is in Cloud's `/api/object_info` and every remaining model's `models/<folder>/<filename>` is in `/api/assets` (`ComfyCloudCatalog`, cached an hour in the workspace's `.konte/comfycloud.json`; `object_info`'s COMBO lists lag, so models are never read there). `comfyapi:<name>`: key set.
- **A deployment must be ready** — the spend gate refuses with `COMFY_API_DEPLOYMENT_NOT_READY` instead of falling through when a deployment it reaches is `unbuilt` or `undeployed` (`deploymentReadiness`); `doctor` reports the same.
- **The route is never hashed** — it rides the job (`comfyTarget`, backend kind `comfy-api`), decided once by the spend gate (`assertSpendAllowed` → `SpendRoutes.targetOf`).
- **Prereqs by route** (`ensureComfyPrereqJobs`) — `comfyui`: model/node jobs; off a ComfyUI: none.

## Runtime (`ComfyApiBackend`)

- One v2 client for Cloud and a deployment's `endpointUrl`; `backendJobId` is `<target>|<jobId>` on Cloud and `<target>|<deploymentId>|<jobId>` on a deployment.
- **Inputs** — blake3 → `HEAD by-hash` → `from-hash`, else multipart `POST /assets`; substituted into the graph as `core/ASSET` references.
- **Idempotency-Key = variant id** — so `beginSubmission` lets a comfy-api job resubmit, under the first attempt's seed, input files and deployment (`chooseSubmissionSite`, recorded before the POST); a lost answer or `idempotency_key_reuse` is looked up in a deployment's `GET /jobs`, and is `SUBMISSION_UNCONFIRMED` on Cloud (no list). A 429 retries for 15 minutes.
- **Outputs** — the adapter's output node's, else every media output; `content`'s 302 is followed without the key. A failure writes `node_errors` and, on a deployment, the run's log to the job log.
- **A deployment submit** goes to a ready deployment of the recorded release (`usableDeployment`); none is `COMFY_API_DEPLOYMENT_NOT_READY`.

## Build and readiness (`deployment.ts`)

konte never creates, stops or deletes a deployment; the human does, on the Build page (`https://platform.comfy.org/profile/builds/<buildId>`).

- **Build per deployment** — every workspace adapter whose whole-adapter route lands there (`routeAdapter`), models deduped by `type` + `filename` (two URLs for one is a config error), packs by id. A URL holding `${VAR}` is refused (`COMFY_API_AUTHENTICATED_MODEL`): the builder fetches anonymously and the definition would keep it.
- **Versions** — `baseComfyVersion` is the deployment's required `comfyVersion`; each pack's registry version is resolved only when the inputs change (`inputsHash`).
- **`konte adapter comfy build [<name>]`** (`buildDeployment`) — the only writer to the platform: Build create/`PATCH` → release (deduped per definition) → wait `deployable`. Then it finds a ready deployment of the release; with none it opens the Build page, prints its URL and exits 1. A deployment of a `pastReleaseIds` release is named as outdated. Serialized per deployment by `.konte/comfyapi-<name>.lock`; ids live in `.konte/comfyapi.json`, never a secret.
- **Readiness** — `unbuilt` when no release is recorded or `inputsHash` no longer matches what routes there; `undeployed` when `GET /deployments` holds no `ready` deployment of the release; else `ready`.
