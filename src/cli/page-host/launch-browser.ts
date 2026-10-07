import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dlopen, FFIType, ptr } from "bun:ffi";

/** `silent`: a failure to open says nothing. */
export function launchBrowser(url: string, opts: { silent?: boolean } = {}): void {
  const [command, args] = openerFor(url);
  let reported = opts.silent === true;
  const reportFailure = () => {
    if (reported) return;
    reported = true;
    console.log(`Could not open the browser. Open ${url} to continue (Ctrl+C to stop).`);
  };

  if (hasRestrictedToken()) {
    if (!opts.silent) {
      console.log(`A sandbox cannot open the browser. Open ${url} to continue (Ctrl+C to stop).`);
    }
    return;
  }

  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.once("error", reportFailure);
    child.once("exit", (code) => {
      if (code !== 0) reportFailure();
    });
    child.unref();
  } catch {
    reportFailure();
  }
}

function openerFor(url: string): [string, string[]] {
  if (process.platform === "darwin") return ["open", [url]];
  if (process.platform === "win32") return ["cmd", ["/c", "start", "", url]];
  if (isWSL()) {
    return ["powershell.exe", ["-NoProfile", "-Command", `Start-Process ${psQuote(url)}`]];
  }
  return ["xdg-open", [url]];
}

export function isWSL(): boolean {
  if (process.platform !== "linux") return false;
  try {
    return /microsoft/i.test(readFileSync("/proc/version", "utf8"));
  } catch {
    return false;
  }
}

/**
 * A write-restricted token (the Codex Windows sandbox) is inherited by the browser it starts, and
 * Chromium aborts when it cannot build its own sandbox under one.
 */
function hasRestrictedToken(): boolean {
  if (process.platform !== "win32") return false;
  try {
    return queryTokenRestricted();
  } catch {
    return false;
  }
}

function queryTokenRestricted(): boolean {
  const kernel32 = dlopen("kernel32.dll", {
    GetCurrentProcess: { args: [], returns: FFIType.u64 },
    CloseHandle: { args: [FFIType.u64], returns: FFIType.bool },
  });
  const advapi32 = dlopen("advapi32.dll", {
    OpenProcessToken: { args: [FFIType.u64, FFIType.u32, FFIType.ptr], returns: FFIType.bool },
    IsTokenRestricted: { args: [FFIType.u64], returns: FFIType.bool },
  });
  try {
    const TOKEN_QUERY = 0x0008;
    const out = new BigUint64Array(1);
    const self = kernel32.symbols.GetCurrentProcess();
    if (!advapi32.symbols.OpenProcessToken(self, TOKEN_QUERY, ptr(out))) return false;
    const token = out[0] ?? 0n;
    try {
      return advapi32.symbols.IsTokenRestricted(token);
    } finally {
      kernel32.symbols.CloseHandle(token);
    }
  } finally {
    advapi32.close();
    kernel32.close();
  }
}

// PowerShell single-quoted string literal: the only escape is a doubled quote.
function psQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
