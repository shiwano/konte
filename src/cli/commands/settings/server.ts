import { loadKonteConfig, saveKonteConfig } from "../../../core/config.js";
import { KonteConfigSchema } from "../../../core/types/config.js";
import { UI_ASSETS } from "../../../core/generated/ui-assets.js";
import { createAssetHandler } from "../../page-host/assets.js";
import {
  checkRequestOrigin,
  errorResponse,
  jsonResponse,
  listenWithPortFallback,
  NativeResponse,
  parseJsonBody,
} from "../../page-host/http.js";
import { createPageLifecycle } from "../../page-host/lifecycle.js";
import type { PageServerHandle } from "../../page-host/run.js";
import { CredentialsPatchSchema } from "../../../core/types/credentials.js";
import { credentialEntries, saveCredentialsPatch } from "./state.js";
import { errorMessage } from "../../../core/errors.js";

interface SettingsServerOptions {
  workspaceRoot: string;
  port: number;
  /** Retry on an ephemeral port when `port` is taken (set when the port was not explicitly asked for). */
  allowPortFallback?: boolean;
  autoClose?: boolean;
}

const serveSpa = createAssetHandler(UI_ASSETS.settings);

export async function createSettingsServer(opts: SettingsServerOptions): Promise<PageServerHandle> {
  const { workspaceRoot, port } = opts;

  const lifecycle = createPageLifecycle({ autoClose: opts.autoClose ?? true });

  const serve = (listenPort: number) =>
    Bun.serve({
      hostname: "127.0.0.1",
      port: listenPort,
      async fetch(req, server) {
        const pathname = new URL(req.url).pathname;

        // No access policy and no gate: the settings page shows which credential keys are set, so
        // it is loopback-only by construction and can never be fronted by a tunnel.
        const admitted = checkRequestOrigin(
          req,
          server.port ?? port,
          undefined,
          server.requestIP(req)?.address ?? null,
        );
        if (!admitted.ok) return admitted.response;

        if (pathname === "/ws") {
          if (server.upgrade(req)) return undefined as unknown as Response;
          return errorResponse("WebSocket upgrade failed", "WS_UPGRADE_FAILED", 400);
        }

        if (pathname === "/api/close" && req.method === "POST") {
          lifecycle.requestClose();
          return new NativeResponse(null, { status: 204 });
        }

        try {
          if (req.method === "PUT" && lifecycle.isShuttingDown()) {
            return errorResponse(
              "Settings is shutting down — nothing was saved",
              "PAGE_SHUTTING_DOWN",
              503,
            );
          }

          if (pathname === "/api/config") {
            if (req.method === "GET") return jsonResponse(await loadKonteConfig(workspaceRoot));
            if (req.method === "PUT") {
              const body = await parseJsonBody<unknown>(req);
              const parsed = KonteConfigSchema.safeParse(body);
              if (!parsed.success) {
                return errorResponse(parsed.error.message, "VALIDATION_FAILED", 400);
              }
              // Tracked: a window closed on the save must not take the write with it.
              return await lifecycle.track(async () =>
                jsonResponse(await saveKonteConfig(workspaceRoot, parsed.data)),
              );
            }
          }

          if (pathname === "/api/credentials") {
            if (req.method === "GET") {
              return jsonResponse({ entries: await credentialEntries(workspaceRoot) });
            }
            if (req.method === "PUT") {
              const patch = CredentialsPatchSchema.safeParse(await parseJsonBody<unknown>(req));
              if (!patch.success) {
                return errorResponse(patch.error.message, "VALIDATION_FAILED", 400);
              }
              return await lifecycle.track(async () =>
                jsonResponse({ entries: await saveCredentialsPatch(workspaceRoot, patch.data) }),
              );
            }
          }

          if (pathname.startsWith("/api/")) {
            return errorResponse("Not found", "NOT_FOUND", 404);
          }

          return serveSpa(pathname);
        } catch (err) {
          // Never the error object: a credential write failure can carry the payload it failed on.
          const message = errorMessage(err);
          console.error(`[settings] ${req.method} ${pathname} → ${message}`);
          return errorResponse(message, "INTERNAL_ERROR", 500);
        }
      },
      websocket: lifecycle.websocket,
    });

  const server = listenWithPortFallback(serve, port, opts.allowPortFallback ?? false);
  lifecycle.attach(server);

  return {
    port: server.port ?? port,
    shutdown: lifecycle.shutdown,
    triggerShutdown: lifecycle.triggerShutdown,
  };
}
