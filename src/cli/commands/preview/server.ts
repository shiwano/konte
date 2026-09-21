import * as fs from "node:fs";
import * as path from "node:path";
import { addressFromCacheSegments, parseAddress } from "../../../core/address.js";
import { sha256Hex } from "../../../core/content-hash.js";
import { KonteError, errorMessage } from "../../../core/errors.js";
import { HYPERFRAME_RUNTIME } from "../../../core/generated/hyperframes-assets.js";
import { UI_ASSETS } from "../../../core/generated/ui-assets.js";
import { createAssetHandler } from "../../page-host/assets.js";
import type { PinGate } from "../../page-host/auth.js";
import { createPageLifecycle, type PageShutdownResult } from "../../page-host/lifecycle.js";
import {
  type AccessPolicy,
  checkRequestOrigin,
  errorResponse,
  listenWithPortFallback,
  LOOPBACK_ONLY,
  NativeResponse,
} from "../../page-host/http.js";
import { findLatestHandoff, loadHandoff } from "../../../core/loader.js";
import { loadPreviewDefinitions, reloadStageDefinition } from "./load-definitions.js";
import type { Handoff } from "../../../core/types/index.js";
import { REVIEW_DIR } from "../../../core/review-record.js";
import { StateManager } from "../../../core/state/index.js";
import { syncFileAssets } from "../../../core/file-sync.js";
import {
  assertPrerequisitesMet,
  findUnmetPrerequisites,
} from "../../../core/review-prerequisites.js";
import { isWithinRootReal } from "../../../core/path-containment.js";
import { PREROLL_ASSET_BASE, prerollCacheDir } from "../../../core/preview-preroll.js";
import type { StageDefinition } from "../../../core/types/index.js";
import {
  type ReviewOutcome,
  type ReportOutcome,
  mergeReviewOutcome,
  printReviewOutcome,
  recoverOutcome,
} from "./review-outcome.js";
import { handleGetDirectionState, handleDirectionSubmit } from "./direction-review.js";
import { handleGetReferenceState, handleReferenceSubmit } from "./reference-review.js";
import {
  assertReelBuilds,
  handleGetReelState,
  handleGetFullComposition,
  handleGetShotComposition,
  handleReelSubmit,
  warmReelPreroll,
} from "./reel-review.js";

export interface PreviewServerOptions {
  videoRoot: string;
  videoPath: string;
  port: number;
  // Retry on an ephemeral port when `port` is taken (set when the port was not explicitly asked for).
  allowPortFallback?: boolean;
  mode: "video-preview" | "animatic-preview" | "reference-preview" | "direction-preview";
  stage?: "animatic" | "video" | "reference" | "direction";
  autoClose?: boolean;
  // An explicit --handoff path; when set it overrides the auto-selection of the
  // latest handoff file matching the stage.
  explicitHandoffPath?: string;
  access?: AccessPolicy;
  /** Guards every non-loopback route. Omitted only where nothing but loopback is admitted. */
  gate?: PinGate;
  reviewId: string;
}

export async function createPreviewServer(opts: PreviewServerOptions): Promise<{
  server: ReturnType<typeof Bun.serve>;
  shutdown: Promise<PageShutdownResult>;
  triggerShutdown: () => void;
}> {
  const { videoRoot, videoPath, port, mode } = opts;
  const autoClose = opts.autoClose ?? true;
  const access = opts.access ?? LOOPBACK_ONLY;

  // Reassigned by the watcher below, which re-reads the same set on a definition edit.
  let { reference, animatic, direction, video } = await loadPreviewDefinitions({
    videoRoot,
    videoPath,
    mode,
  });
  // The stage the reel pages play: each mode loads its own entry fatally, so it is there whenever
  // a reel route can be reached.
  const currentReel = (): StageDefinition => {
    const reel = mode === "animatic-preview" ? animatic : video;
    if (!reel) throw new KonteError("ADDRESS_NOT_FOUND", `No reel is loaded in ${mode}`);
    return reel;
  };
  if ((mode === "animatic-preview" || mode === "video-preview") && animatic) {
    await assertReelBuilds(currentReel(), videoRoot, animatic);
  }

  // Select the handoff file for this stage: a handoff file is scoped to one stage, so the
  // auto-selection surfaces only the latest file matching this session. An explicit --handoff
  // path bypasses the matching.
  const stage: "animatic" | "video" | "reference" | "direction" =
    mode === "animatic-preview"
      ? "animatic"
      : mode === "reference-preview"
        ? "reference"
        : mode === "direction-preview"
          ? "direction"
          : "video";
  let handoff: Handoff | null = null;
  let handoffPath: string | null = null;
  if (opts.explicitHandoffPath) {
    handoffPath = opts.explicitHandoffPath;
    handoff = await loadHandoff(handoffPath);
  } else {
    const found = await findLatestHandoff(path.join(videoRoot, REVIEW_DIR), stage);
    if (found) {
      handoffPath = found.path;
      handoff = found.handoff;
    }
  }
  // Sync file assets under the state lock so the seconds-long media hashing cannot
  // clobber a concurrent watcher write. Route handlers reload their own snapshot.
  await StateManager.withLock(videoRoot, async (m) => {
    if (mode === "reference-preview" || mode === "direction-preview") {
      // Direction review is media-less; syncing the reference pool is enough to resolve the characters.
      await syncFileAssets({ reference }, m, { measure: true });
    } else {
      await syncFileAssets({ reference, animatic, video }, m, { measure: true });
    }
    // Refuse to open a review of half a target — after the sync, never before it: syncing is what
    // gives a `file` panel its accepted variant, so a check ahead of it would read that panel as
    // unbuilt and wave the page through with the movement still unwritten. Scoped to the stage
    // being opened, unlike the accept gate: another stage's unwritten movement is not this page's
    // to answer for, and the accept it would reach is gated on submit.
    if (stage) {
      assertPrerequisitesMet(
        findUnmetPrerequisites(stage, { animatic }, m.getState()),
        `Cannot open the ${stage} review`,
      );
    }
  });

  const wsClients = new Set<import("bun").ServerWebSocket<undefined>>();
  // The last submit's outcome, or null if the session closed without one.
  let outcome: ReviewOutcome | null = null;
  const reportOutcome: ReportOutcome = (o) => {
    outcome = mergeReviewOutcome(outcome, o);
  };
  const sessionStart = new Date().toISOString();
  // Whether any submit reached this server. The recovery below reads a record this process may not
  // have written — a second preview on the same stage writes into the same stream — so it is only
  // consulted once a submit has actually been taken here.
  let submitSeen = false;

  // Settled once the outcome is printed: `konte review wait` returns on it, so what it points the
  // agent at is already in the preview's output. Bun's stop() lets the waiting request run on.
  let settleEnded!: () => void;
  const ended = new Promise<void>((resolve) => {
    settleEnded = resolve;
  });

  const lifecycle = createPageLifecycle({
    autoClose,
    onShutdown: async ({ drainTimedOut }) => {
      try {
        printReviewOutcome(
          mode,
          outcome ?? (submitSeen ? await recoverOutcome(videoRoot, mode, sessionStart) : null),
          drainTimedOut,
        );
      } finally {
        settleEnded();
      }
    },
    onSocketOpen: (ws) => wsClients.add(ws),
    onSocketClose: (ws) => wsClients.delete(ws),
  });
  const { shutdown, triggerShutdown } = lifecycle;

  // Relative, so every media URL resolves against the origin the page was opened at: an absolute
  // loopback base would point a phone at its own machine.
  const assetBaseUrl = "/api/assets";

  // The browser has a bundle to load before it asks for the reel, so the ffmpeg pass each new take
  // needs is spent during that wait rather than added to it. Video stage only — a `<Video>` on the
  // board is a load error, so an animatic reel has no clip to run up.
  if (mode === "video-preview") {
    void warmReelPreroll(currentReel(), videoRoot, assetBaseUrl, animatic);
  }

  const serve = (listenPort: number) =>
    Bun.serve({
      hostname: access.host,
      port: listenPort,
      async fetch(req, server) {
        const url = new URL(req.url);
        const pathname = url.pathname;

        const admitted = checkRequestOrigin(
          req,
          server.port ?? port,
          access,
          server.requestIP(req)?.address ?? null,
        );
        if (!admitted.ok) return admitted.response;

        // Ahead of every route, the WebSocket upgrade included: the keepalive socket is what holds
        // the session open, and a browser sends the session cookie on its handshake like any other.
        const gated = await opts.gate?.guard(req, url, admitted.via);
        if (gated) return gated;

        if (pathname === "/ws") {
          if (server.upgrade(req)) return undefined as unknown as Response;
          return errorResponse("WebSocket upgrade failed", "WS_UPGRADE_FAILED", 400);
        }

        // The one route a page asks for after its socket drops: whether this server is still
        // here. A dropped socket says nothing on its own — a phone on the tunnel drops one every
        // time it changes network — so nothing but a server that does not answer at all may end a
        // review page and take the comment being typed with it.
        if (pathname === "/api/ping") {
          return new NativeResponse(null, { status: 204 });
        }

        const waitRoute = /^\/api\/review\/([^/]+)\/wait$/.exec(pathname);
        if (waitRoute && req.method === "GET") {
          if (waitRoute[1] !== opts.reviewId) {
            return errorResponse("No such review on this server", "REVIEW_NOT_FOUND", 404);
          }
          server.timeout(req, 0);
          await ended;
          return new NativeResponse(null, { status: 204 });
        }

        if (pathname === "/api/close" && req.method === "POST") {
          lifecycle.requestClose();
          return new NativeResponse(null, { status: 204 });
        }

        try {
          if (pathname === "/api/state") {
            if (mode === "direction-preview" && direction) {
              return await handleGetDirectionState(videoRoot, direction, reference, handoff);
            }
            if (mode === "reference-preview" && reference) {
              return await handleGetReferenceState(
                videoRoot,
                reference,
                assetBaseUrl,
                handoff,
                direction,
                animatic,
                video,
              );
            }
            // Both composition stages are one page and one handler; the reel it plays is the
            // stage the session was opened on.
            return await handleGetReelState(
              videoRoot,
              currentReel(),
              assetBaseUrl,
              handoff,
              direction,
              animatic,
              reference,
              mode === "animatic-preview" ? video : null,
            );
          }

          if (pathname === "/api/compositions/full" && req.method === "GET") {
            const variantOverrides = url.searchParams
              .getAll("override")
              .map((raw) => {
                const idx = raw.lastIndexOf(":");
                if (idx < 0) return null;
                const address = raw.slice(0, idx);
                const variantId = raw.slice(idx + 1);
                if (!variantId) return null;
                try {
                  // Validate the address (a shot/timeline/reference asset); buildFullComposition
                  // classifies it by kind. A timeline soundtrack ref (reference / timeline)
                  // is a valid override too, not just a shot-own asset.
                  parseAddress(address);
                  return { address, variantId };
                } catch {
                  return null;
                }
              })
              .filter((o): o is { address: string; variantId: string } => o !== null);
            return await handleGetFullComposition(
              currentReel(),
              videoRoot,
              assetBaseUrl,
              variantOverrides,
              animatic,
              // See fetchCompositionHtml: only a request carrying a page snapshot pins the
              // stand-ins.
              url.searchParams.has("pinned") ? url.searchParams.getAll("standIn") : undefined,
            );
          }

          const shotCompMatch = pathname.match(/^\/api\/compositions\/([^/]+)$/);
          if (shotCompMatch && req.method === "GET") {
            const shotId = decodeURIComponent(shotCompMatch[1]!);
            const variantParam = url.searchParams.get("variant");
            let variantOverride: { assetName: string; variantId: string } | undefined;
            if (variantParam) {
              const [assetName, variantId] = variantParam.split(":");
              if (assetName && variantId) {
                variantOverride = { assetName, variantId };
              }
            }
            return await handleGetShotComposition(
              currentReel(),
              videoRoot,
              shotId,
              assetBaseUrl,
              variantOverride,
            );
          }

          // Refused rather than half-done: the reviewer is told their review did not land, which
          // beats a write the ending session cannot see through. The page's own socket is gone by
          // the time this can hit — nothing but a stray keep-alive request gets here.
          if (pathname.endsWith("/submit") && lifecycle.isShuttingDown()) {
            return errorResponse(
              "Preview is shutting down — the review was not submitted",
              "PAGE_SHUTTING_DOWN",
              503,
            );
          }

          // A rejected submit (bad body, no definition loaded) reports no outcome, so the session
          // still exits as "not submitted" rather than claiming a review that never landed.
          // Each runs as tracked work: a submit is the one handler whose result the exit line
          // reports, and a window closed on its spinner must not outrun it.
          if (
            (pathname === "/api/video/submit" || pathname === "/api/animatic/submit") &&
            req.method === "POST"
          ) {
            submitSeen = true;
            const reelStage = pathname === "/api/animatic/submit" ? "animatic" : "video";
            // A submit may only land on the reel this session is serving. The shot ids coincide,
            // so a page and a server that disagree about the stage would accept the OTHER stage's
            // shots — a review signing off takes nobody saw.
            if (reelStage !== stage) {
              submitSeen = false;
              return errorResponse(
                `This page is reviewing the ${stage} reel; a ${reelStage} submit belongs to \`konte preview ${reelStage}\``,
                "INVALID_ADDRESS",
                400,
              );
            }
            return await lifecycle.track(() =>
              handleReelSubmit(
                videoRoot,
                () => reloadStageDefinition(videoRoot, videoPath, reelStage),
                handoff,
                direction,
                animatic,
                req,
                reportOutcome,
              ),
            );
          }

          if (pathname === "/api/reference/submit" && req.method === "POST") {
            submitSeen = true;
            // Bound before the closure: the watcher may reassign `reference` on a reload, and a
            // deferred read of it would defeat the guard above.
            const referenceDef = reference;
            if (!referenceDef) {
              return errorResponse("No reference definition loaded", "ADDRESS_NOT_FOUND", 400);
            }
            return await lifecycle.track(() =>
              handleReferenceSubmit(
                videoRoot,
                handoff,
                referenceDef,
                direction,
                animatic,
                req,
                reportOutcome,
              ),
            );
          }

          if (pathname === "/api/direction/submit" && req.method === "POST") {
            submitSeen = true;
            const directionDef = direction;
            if (!directionDef) {
              return errorResponse("No direction definition loaded", "ADDRESS_NOT_FOUND", 400);
            }
            return await lifecycle.track(() =>
              handleDirectionSubmit(videoRoot, handoff, directionDef, req, reportOutcome),
            );
          }

          if (pathname.startsWith("/api/thumbnail-assets/")) {
            const rawPath = pathname.slice("/api/thumbnail-assets/".length);
            return handleThumbnailAssetRequest(videoRoot, decodeURIComponent(rawPath));
          }

          if (pathname.startsWith(`${PREROLL_ASSET_BASE}/`)) {
            return handlePrerollAssetRequest(
              videoRoot,
              pathname.slice(`${PREROLL_ASSET_BASE}/`.length),
            );
          }

          if (pathname.startsWith("/api/assets/")) {
            return handleAssetRequest(videoRoot, pathname.slice("/api/assets/".length));
          }

          return serveSpa(pathname);
        } catch (err) {
          // Log to the preview process output so a failed request (e.g. a transient
          // "Assets without ready variants") is diagnosable after the fact — the
          // response alone reaches only the browser and leaves no runtime trace.
          if (err instanceof KonteError) {
            console.error(`[preview] ${req.method} ${pathname} → ${err.code}: ${err.message}`);
            return errorResponse(err.message, err.code, 400);
          }
          const message = errorMessage(err);
          console.error(`[preview] ${req.method} ${pathname} → ${message}`);
          if (err instanceof Error && err.stack) console.error(err.stack);
          return errorResponse(message, "INTERNAL_ERROR", 500);
        }
      },
      websocket: lifecycle.websocket,
    });

  const server = listenWithPortFallback(serve, port, opts.allowPortFallback ?? false);
  lifecycle.attach(server);

  function broadcastWs(msg: Record<string, unknown>) {
    const payload = JSON.stringify(msg);
    for (const ws of wsClients) {
      try {
        ws.send(payload);
      } catch {}
    }
  }

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  const DEBOUNCE_MS = 150;
  let stateDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  const STATE_DEBOUNCE_MS = 200;

  // The one non-source file the reload path re-reads: the handoff is JSON, so it has to be
  // let through the `.ts`/`.tsx` filter below by path rather than by extension.
  const handoffRel = handoffPath ? path.relative(videoRoot, handoffPath).replace(/\\/g, "/") : null;

  // A formatter hook or a checkout rewrites the file without changing the state in it.
  let stateSignature = await readStateSignature(videoRoot);

  const watcher = fs.watch(videoRoot, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    const normalized = filename.replace(/\\/g, "/");
    // A watcher committing a new variant (or a reroll/accept) rewrites the state
    // file; push a soft refresh so the open review picks it up without a full
    // page reload (which would drop the WS and trip the auto-close). The direction
    // review is media-less, so no state write can change what it shows — its own
    // feedback/accept writes would be the only thing the prompt ever announced.
    if (normalized === "konte.state.json") {
      if (mode === "direction-preview") return;
      if (stateDebounceTimer) clearTimeout(stateDebounceTimer);
      stateDebounceTimer = setTimeout(async () => {
        const signature = await readStateSignature(videoRoot);
        if (signature === null || signature === stateSignature) return;
        stateSignature = signature;
        broadcastWs({ type: "state-changed" });
      }, STATE_DEBOUNCE_MS);
      return;
    }
    if (normalized !== handoffRel && !normalized.endsWith(".ts") && !normalized.endsWith(".tsx")) {
      return;
    }
    if (
      normalized.startsWith("node_modules/") ||
      normalized.startsWith("dist/") ||
      normalized.startsWith(".konte/")
    ) {
      return;
    }

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      try {
        ({ reference, animatic, direction, video } = await loadPreviewDefinitions({
          videoRoot,
          videoPath,
          mode,
          reload: true,
        }));
        if (handoffPath) {
          try {
            handoff = await loadHandoff(handoffPath);
          } catch {
            // keep previous notes if the file is mid-edit / invalid
          }
        }
        broadcastWs({ type: "reload" });
      } catch (err) {
        const message = errorMessage(err);
        broadcastWs({ type: "error", payload: { error: message } });
        console.error("Reload failed:", message);
      }
    }, DEBOUNCE_MS);
  });

  const origShutdown = shutdown;
  const wrappedShutdown = origShutdown.then((result) => {
    watcher.close();
    if (debounceTimer) clearTimeout(debounceTimer);
    if (stateDebounceTimer) clearTimeout(stateDebounceTimer);
    return result;
  });

  return { server, shutdown: wrappedShutdown, triggerShutdown };
}

// Null while the file is absent or half-written in place; the write's next event settles it.
export async function readStateSignature(videoRoot: string): Promise<string | null> {
  try {
    const raw = await fs.promises.readFile(path.join(videoRoot, "konte.state.json"), "utf-8");
    return sha256Hex(JSON.stringify(JSON.parse(raw)));
  } catch {
    return null;
  }
}

/**
 * URL layout: `<stage>/<suffix>/<variantId>/<filename>` — the address split at its
 * `:` delimiter into path-safe segments (see addressToUrlPath), reconstructed here.
 * Each segment is decoded exactly once, after the split: decoding the whole path first would
 * re-decode a literal `%` in a filename (`100%.png` -> a URIError, or `%41.png` -> `A.png`).
 * Returns null on a malformed path.
 */
export function parseAssetUrlPath(
  rawPath: string,
): { address: string; variantId: string; filename: string } | null {
  let parts: string[];
  try {
    parts = rawPath.split("/").map((p) => decodeURIComponent(p));
  } catch {
    return null;
  }
  if (parts.length < 4) return null;
  return {
    address: addressFromCacheSegments(parts.slice(0, 2)),
    variantId: parts[2]!,
    filename: parts.slice(3).join("/"),
  };
}

function handleAssetRequest(videoRoot: string, rawPath: string): Response {
  const parsed = parseAssetUrlPath(rawPath);
  if (!parsed) {
    return errorResponse("Invalid asset path", "INVALID_REQUEST", 400);
  }
  const { address, variantId, filename } = parsed;

  let variant: { file?: string } | undefined;
  try {
    const stateFile = path.join(videoRoot, "konte.state.json");
    const raw = fs.readFileSync(stateFile, "utf-8");
    const parsed = JSON.parse(raw) as {
      assets: Record<string, { variants?: Record<string, { file?: string }> }>;
    };
    const assetState = parsed.assets[address];
    if (!assetState) {
      return errorResponse("Asset not found", "ASSET_NOT_FOUND", 404);
    }
    variant = assetState.variants?.[variantId];
  } catch {
    return errorResponse("Cannot load state", "INTERNAL_ERROR", 500);
  }

  if (!variant?.file) {
    return errorResponse("Variant file not found", "VARIANT_NOT_FOUND", 404);
  }

  const variantBasename = path.basename(variant.file);
  if (variantBasename !== filename) {
    return errorResponse("Filename mismatch", "FORBIDDEN", 403);
  }

  return serveContainedFile(path.resolve(videoRoot, variant.file), videoRoot);
}

// Confined to the preroll cache — these names come off the composition HTML, but the route reads a
// path from the request either way.
function handlePrerollAssetRequest(videoRoot: string, rawPath: string): Response {
  const dir = prerollCacheDir(videoRoot);
  let name: string;
  try {
    name = decodeURIComponent(rawPath);
  } catch {
    return errorResponse("Invalid preroll path", "INVALID_REQUEST", 400);
  }
  return serveContainedFile(path.resolve(dir, name), dir);
}

function handleThumbnailAssetRequest(videoRoot: string, rawPath: string): Response {
  // Confine reads to .konte/cache/thumbnails/ — the only place legitimate thumbnail URLs
  // point. A bare project-root check would still serve e.g. the workspace credentials.
  const thumbnailsDir = path.join(videoRoot, ".konte", "cache", "thumbnails");
  return serveContainedFile(path.resolve(videoRoot, rawPath), thumbnailsDir);
}

// Serve a file, refusing one that resolves (symlinks followed) outside `root`.
function serveContainedFile(filePath: string, root: string): Response {
  if (!isWithinRootReal(filePath, root)) {
    return errorResponse("Forbidden", "FORBIDDEN", 403);
  }
  if (!fs.existsSync(filePath)) {
    return errorResponse("File not found", "NOT_FOUND", 404);
  }
  return new NativeResponse(Bun.file(filePath));
}

const serveSpa = createAssetHandler(UI_ASSETS.preview, {
  "/hyperframes-runtime.js": { content: HYPERFRAME_RUNTIME, contentType: "text/javascript" },
});
