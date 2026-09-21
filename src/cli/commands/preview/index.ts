import * as path from "node:path";
import { loadKonteConfig } from "../../../core/config.js";
import { shortId } from "../../../core/short-id.js";
import { createPinGate } from "../../page-host/auth.js";
import { describeExposure, LOOPBACK_ONLY } from "../../page-host/http.js";
import { runPage } from "../../page-host/run.js";
import { startTunnel, type Tunnel } from "../../page-host/tunnel.js";
import { parseNumberOption } from "../../parse-option.js";
import { createPreviewServer, type PreviewServerOptions } from "./server.js";
import { requireVideoRoots } from "../../context.js";
import { stageEntryPath } from "../../../core/roots.js";

const DEFAULT_PREVIEW_PORT = 4649;

export async function launchPreview(opts: {
  port?: string;
  host?: string;
  autoClose: boolean;
  handoff?: string;
  tunnel?: boolean;
  mode: PreviewServerOptions["mode"];
}): Promise<void> {
  const roots = requireVideoRoots();
  const videoRoot = roots.video;
  const videoPath = stageEntryPath(videoRoot, "video");
  const requestedPort = parseNumberOption("--port", opts.port, {
    integer: true,
    min: 0,
    max: 65535,
  });

  // The handoff is selected inside the server: a handoff file is scoped to one stage and only the
  // latest matching one should surface. An explicit --handoff path is honored as-is.
  const explicitHandoffPath = opts.handoff ? path.resolve(videoRoot, opts.handoff) : undefined;

  const stage =
    opts.mode === "animatic-preview"
      ? "animatic"
      : opts.mode === "reference-preview"
        ? "reference"
        : opts.mode === "direction-preview"
          ? "direction"
          : undefined;

  // konte.config.json is a workspace file — the preview settings are shared by every video.
  const config = await loadKonteConfig(roots.workspace);

  // allowedHosts has no flag: a hostname a proxy fronts is a property of the setup, not of the
  // invocation. A tunnel's own hostname is not configured at all — it is appended below, once
  // cloudflared has said what it is.
  const access = {
    host: opts.host ?? config.preview?.host ?? LOOPBACK_ONLY.host,
    allowedHosts: [...(config.preview?.allowedHosts ?? [])],
  };

  // No setting turns this on: konte.config.json is committed, so a tunnel enabled there would
  // follow the repo and open a public URL on runs nobody asked one for.
  const wantsTunnel = opts.tunnel === true;

  let tunnel: Tunnel | null = null;
  let stopServer: (() => void) | null = null;
  // The PIN guards every route that is not loopback, tunnel or not: a LAN bind is reachable by
  // everyone on the same wifi.
  const gate = createPinGate({
    onLockout: () => {
      process.stderr.write(
        "Too many wrong PINs — closing the tunnel. The local review is still open.\n",
      );
      void tunnel?.close();
    },
    onAttack: () => {
      process.stderr.write(
        "PIN guesses kept coming after the route was closed — ending the session. " +
          "Start `konte preview` again to review; it comes up under a new host name and a new PIN.\n",
      );
      stopServer?.();
    },
  });

  const reviewId = `r-${shortId()}`;
  const serverOpts: PreviewServerOptions = {
    videoRoot,
    videoPath,
    port: requestedPort ?? DEFAULT_PREVIEW_PORT,
    allowPortFallback: requestedPort == null,
    mode: opts.mode,
    stage,
    autoClose: opts.autoClose,
    explicitHandoffPath,
    access,
    gate,
    reviewId,
  };

  await runPage({
    // Read after `start` has resolved, so the tunnel it opened is already named here.
    startupLine: (url, port) => {
      const line = `Preview server at ${url} — opening browser (Ctrl+C to stop)`;
      const exposure = describeExposure(access, port, { pin: gate.pin, tunnelUrl: tunnel?.url });
      return `${exposure ? `${line}\n${exposure}` : line}\n\nNext steps:\n  konte review wait ${reviewId} --port ${port}`;
    },
    start: async () => {
      const { server, shutdown, triggerShutdown } = await createPreviewServer(serverOpts);
      const listenPort = server.port ?? serverOpts.port;
      stopServer = triggerShutdown;
      if (wantsTunnel) {
        try {
          tunnel = await startTunnel(listenPort);
        } catch (err) {
          // The server is already listening; leaving it up would block on a review no one was
          // given a URL for.
          triggerShutdown();
          await shutdown;
          throw err;
        }
        // The server reads `access` per request, so appending here is what admits the name, and
        // nothing outside knows it yet.
        access.allowedHosts.push(tunnel.hostname);
      }
      return {
        port: listenPort,
        shutdown: shutdown.finally(async () => {
          await tunnel?.close();
        }),
        triggerShutdown,
      };
    },
  });
}
