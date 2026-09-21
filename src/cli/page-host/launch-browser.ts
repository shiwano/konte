import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

export function launchBrowser(url: string): void {
  const [command, args] = openerFor(url);
  let reported = false;
  const reportFailure = () => {
    if (reported) return;
    reported = true;
    console.log(`Could not open the browser. Open ${url} to continue (Ctrl+C to stop).`);
  };

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

// PowerShell single-quoted string literal: the only escape is a doubled quote.
function psQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
