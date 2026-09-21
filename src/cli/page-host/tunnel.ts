import { spawn, type ChildProcess } from "node:child_process";
import { cloudflaredBin } from "../../core/cloudflared-binary.js";
import { KonteError } from "../../core/errors.js";

// A network that blocks outbound QUIC never gets a hostname at all.
const HOSTNAME_TIMEOUT_MS = 30_000;
const CLOSE_TIMEOUT_MS = 3_000;

const QUICK_TUNNEL_RE = /https:\/\/([a-z0-9-]+\.trycloudflare\.com)\b/i;

/** The assigned host name out of cloudflared's log, or null while it has yet to say. */
export function parseTunnelHostname(log: string): string | null {
  const match = QUICK_TUNNEL_RE.exec(log);
  return match ? match[1]!.toLowerCase() : null;
}

export interface Tunnel {
  /** The single host name the tunnel answers under — admitted verbatim, never as a glob. */
  hostname: string;
  url: string;
  close: () => Promise<void>;
}

/**
 * Open a Cloudflare quick tunnel to `port` and resolve once it has a host name. The caller admits
 * that exact name: `*.trycloudflare.com` would admit every other quick tunnel too, and a quick
 * tunnel's hostname is one anyone can take.
 */
export async function startTunnel(port: number): Promise<Tunnel> {
  const bin = await cloudflaredBin();
  const child = spawn(
    bin,
    [
      "tunnel",
      "--no-autoupdate",
      "--url",
      `http://127.0.0.1:${port}`,
      // Pinned, not left to the default: the hostname is read out of the log, and a quieter
      // default in a later release would hide it.
      "--loglevel",
      "info",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  // Registered against the spawn, not the hostname: the wait below runs up to HOSTNAME_TIMEOUT_MS,
  // and the caller has no shutdown path until `startTunnel` returns. An interactive Ctrl+C reaches
  // the child through the process group; this covers the exits that do not.
  let closing = false;
  const killOnExit = () => {
    if (!closing) child.kill("SIGTERM");
  };
  process.once("exit", killOnExit);

  let hostname: string;
  try {
    hostname = await readHostname(child);
  } catch (err) {
    closing = true;
    process.off("exit", killOnExit);
    throw err;
  }

  child.on("exit", (code) => {
    // Nothing else notices: the local server keeps serving and the public URL just stops
    // answering.
    if (!closing) {
      process.stderr.write(`Tunnel closed unexpectedly (cloudflared exited with ${code ?? "?"})\n`);
    }
  });

  return {
    hostname,
    url: `https://${hostname}`,
    close: async () => {
      closing = true;
      process.off("exit", killOnExit);
      await stop(child);
    },
  };
}

function readHostname(child: ChildProcess): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let log = "";

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const fail = (message: string) =>
      finish(() => {
        void stop(child);
        reject(new KonteError("TUNNEL_FAILED", message));
      });

    const timer = setTimeout(
      () =>
        fail(
          `cloudflared did not report a tunnel host name within ${HOSTNAME_TIMEOUT_MS / 1000}s. ` +
            `A quick tunnel needs outbound QUIC (UDP/7844).`,
        ),
      HOSTNAME_TIMEOUT_MS,
    );

    // Both pipes are read for the whole life of the process, not just until the hostname lands: an
    // unread pipe fills and blocks cloudflared itself.
    const scan = (chunk: Buffer) => {
      if (settled) return;
      // Bounded: the hostname line arrives early, and a stuck tunnel must not grow this forever.
      log = `${log}${chunk.toString()}`.slice(-8192);
      const hostname = parseTunnelHostname(log);
      if (hostname) finish(() => resolve(hostname));
    };
    child.stdout?.on("data", scan);
    child.stderr?.on("data", scan);
    child.stdout?.resume();
    child.stderr?.resume();

    child.on("error", (err) => fail(`Failed to start cloudflared: ${err.message}`));
    child.on("exit", (code) =>
      fail(`cloudflared exited with ${code ?? "?"} before opening a tunnel:\n${log.trim()}`),
    );
  });
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, CLOSE_TIMEOUT_MS);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}
