import { loadKonteConfig } from "../core/config.js";

// Wait/retry cadence for the ComfyUI waiters. Every field defaults to a production value; only
// tests override them (to microseconds), so a test isn't paying real reconnect/poll wall-clock.
export type ComfyUITiming = {
  // WS reconnect backoff schedule. Its length also caps the number of connect attempts (one
  // attempt per entry; the last entry's delay is unused, since there's no wait after the final try).
  reconnectDelaysMs: number[];
  // HTTP polling fallback and manager-queue poll interval.
  pollIntervalMs: number;
  // Cap on the polling exponential backoff after consecutive transient failures.
  maxBackoffMs: number;
  // HTTP /history safety-net interval run alongside an in-flight WebSocket wait.
  safetyNetIntervalMs: number;
  // How long a WebSocket handshake may sit unanswered — a peer that neither upgrades nor refuses
  // (a proxy swallowing the upgrade, a silently dropped connection) fires no event on its own.
  handshakeTimeoutMs: number;
};

export const DEFAULT_COMFYUI_TIMING: ComfyUITiming = {
  reconnectDelaysMs: [1000, 2000, 4000],
  pollIntervalMs: 2000,
  maxBackoffMs: 30_000,
  safetyNetIntervalMs: 5000,
  handshakeTimeoutMs: 30_000,
};

export function resolveComfyUITiming(partial?: Partial<ComfyUITiming>): ComfyUITiming {
  return { ...DEFAULT_COMFYUI_TIMING, ...partial };
}

export type ComfyUIConfig = {
  baseUrl: string;
  clientId?: string;
  // Sent on every request to this server, held UNRESOLVED (`Bearer ${COMFYUI_TOKEN}`).
  headers: Record<string, string>;
  autoInstallModels: boolean;
  autoInstallNodes: boolean;
  // When true (default), konte reboots ComfyUI after installing custom nodes so they load.
  // A reboot is server-wide and destructive; set false for shared servers to fall back to a
  // manual flow (konte installs, then asks you to restart ComfyUI and re-run).
  autoRebootAfterNodeInstall: boolean;
  // How long a generation job may poll a ComfyUI that answers nothing at all before it is failed
  // as unreachable. 0 disables the ceiling (poll forever, the cloud backends' contract). In ms
  // here, like every other duration the waiters take; the config states it in minutes, which is
  // the only granularity anyone sets a patience window at.
  unreachableTimeoutMs: number;
  // Overrides the waiters' cadence; omitted in production (defaults apply), set only by tests.
  timing?: Partial<ComfyUITiming>;
};

/**
 * Default ceiling on polling a ComfyUI that has gone silent, for a server on THIS machine.
 *
 * The cloud backends never give up: their jobs run on someone else's infrastructure and stay
 * re-observable by id across any outage, so "I cannot reach the API" says nothing about the job.
 * A local ComfyUI is the opposite — the prompt lives inside a process on this machine and its
 * queue is in memory, so if it has answered nothing for this long it is gone and took the prompt
 * with it. Polling on is then waiting for something that can never land, which is how a
 * `konte job wait` sat silent for seven hours over a ComfyUI that never came back.
 *
 * Set generously: it must clear a long GPU stall, a laptop suspend, or a `docker restart`, and
 * any survivor still reports its real outcome.
 */
export const DEFAULT_COMFYUI_UNREACHABLE_TIMEOUT_MINUTES = 15;

/**
 * A REMOTE ComfyUI gets no ceiling by default.
 *
 * Over a network, silence has a second explanation the local case does not: the path broke, not
 * the server. A partition, a VPN drop or a proxy restart proves nothing about a prompt that may
 * still be executing, and failing it would abandon output that is about to exist. The local
 * inference — "unreachable therefore restarted" — is only sound when there is no network in
 * between. Set `comfyui.unreachableTimeoutMinutes` explicitly to opt a remote server in.
 */
const DEFAULT_REMOTE_COMFYUI_UNREACHABLE_TIMEOUT_MINUTES = 0;

// Whether the ComfyUI at this URL runs on the machine konte is running on. Only a loopback host
// answers yes; a LAN address is someone else's box across a network that can fail on its own.
function isLocalComfyUrl(baseUrl: string): boolean {
  let host: string;
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  // IPv6 hostnames keep their brackets off in `hostname`; ::1 is the only loopback there.
  return host === "localhost" || host === "::1" || host === "127.0.0.1" || host.startsWith("127.");
}

export async function resolveComfyUIConfig(workspaceRoot: string): Promise<ComfyUIConfig> {
  const config = await loadKonteConfig(workspaceRoot);
  const baseUrl = normalizeUrl(config.comfyui?.url ?? "");
  return {
    baseUrl,
    headers: config.comfyui?.headers ?? {},
    autoInstallModels: config.comfyui?.autoInstallModels ?? true,
    autoInstallNodes: config.comfyui?.autoInstallNodes ?? true,
    autoRebootAfterNodeInstall: config.comfyui?.autoRebootAfterNodeInstall ?? true,
    unreachableTimeoutMs:
      (config.comfyui?.unreachableTimeoutMinutes ??
        (isLocalComfyUrl(baseUrl)
          ? DEFAULT_COMFYUI_UNREACHABLE_TIMEOUT_MINUTES
          : DEFAULT_REMOTE_COMFYUI_UNREACHABLE_TIMEOUT_MINUTES)) * 60_000,
  };
}

function normalizeUrl(url: string): string {
  return url.replace(/\/+$/, "");
}
