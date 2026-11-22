import * as fs from "node:fs/promises";
import * as path from "node:path";
import pkg from "../../../../package.json" with { type: "json" };
import { errorMessage } from "../../../core/errors.js";
import type { VideoSelection } from "../../../core/roots.js";
import { type TypeDiagnostic, typeCheckWorkspace } from "../../../core/type-check.js";
import { checkForUpdate } from "../../../core/update-check.js";
import type { CheckResult, DoctorVideo } from "./types.js";

// With no video selected, doctor drops to the workspace-level checks and says so: a WARN naming the
// reduced scope, so the thinner output never reads as a clean bill of health for a video.
export function reducedScopeCheck(
  selection: VideoSelection | undefined,
  allVideos: boolean | undefined,
): CheckResult {
  if (allVideos) {
    return {
      name: "video scope",
      status: "WARN",
      message: `this workspace has no videos. Run "konte video new <name>" to create one.`,
    };
  }
  const reason =
    selection?.kind === "not-found"
      ? `the current video "${selection.name}" no longer exists`
      : "no video selected";
  return {
    name: "video scope",
    status: "WARN",
    message: `${reason}. ` + `Run "konte video use <name>" (or cd into a video).`,
  };
}

export type TypeCheckOutcome = { check: CheckResult; otherVideos: TypeDiagnostic[] };

export async function checkTypeCheck(
  workspaceRoot: string,
  videoRoot: string | null,
): Promise<TypeCheckOutcome> {
  try {
    await fs.access(path.join(workspaceRoot, "tsconfig.json"));
  } catch {
    return {
      check: { name: "type check", status: "PASS", message: "no tsconfig.json (skipped)" },
      otherVideos: [],
    };
  }
  try {
    const result = await typeCheckWorkspace(workspaceRoot, videoRoot);
    if (result.success) {
      return {
        check: { name: "type check", status: "PASS", message: "passed" },
        otherVideos: result.otherVideos,
      };
    }
    const details = result.diagnostics.map(formatDiagnostic);
    return {
      check: {
        name: "type check",
        status: "FAIL",
        message: `${result.errorCount} type error(s) found`,
        details: details.length > 0 ? details : undefined,
      },
      otherVideos: result.otherVideos,
    };
  } catch (err) {
    return {
      check: { name: "type check", status: "FAIL", message: errorMessage(err) },
      otherVideos: [],
    };
  }
}

// One video's share of a workspace type check run with no video in scope.
export function videoTypeCheckOf(
  workspaceRoot: string,
  target: DoctorVideo,
  typeCheck: TypeCheckOutcome,
): CheckResult {
  const own = typeCheck.otherVideos.filter((d) => {
    const rel = path.relative(target.root, path.resolve(workspaceRoot, d.file));
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  });
  if (own.length === 0) return { name: "type check", status: "PASS", message: "passed" };
  return {
    name: "type check",
    status: "FAIL",
    message: `${own.length} type error(s) found`,
    details: own.map(formatDiagnostic),
  };
}

function formatDiagnostic(d: TypeDiagnostic): string {
  return `${d.file}(${d.line},${d.column}): ${d.code} ${d.message}`;
}

// Codex's config cannot extend the inherited PATH, so setup writes the whole PATH it ran under into
// .codex/config.toml; this reports an entry that no longer exists on this machine.
export async function checkCodexPath(): Promise<CheckResult | null> {
  if (process.env.KONTE_AGENT !== "codex") return null;
  const name = "codex PATH";
  const entries = (process.env.PATH ?? "").split(path.delimiter).filter((entry) => entry !== "");
  const missing: string[] = [];
  for (const entry of entries) {
    const stat = await fs.stat(entry).catch(() => null);
    if (!stat?.isDirectory()) missing.push(entry);
  }
  if (missing.length === 0) return { name, status: "PASS", message: "every entry exists" };
  return {
    name,
    status: "WARN",
    message: `${missing.length} entr${missing.length === 1 ? "y" : "ies"} missing from this machine — .codex/config.toml holds the PATH of an earlier setup; run \`konte workspace setup\` and restart Codex`,
    details: missing,
  };
}

// The one network call doctor makes on konte's own behalf, cached a day beside the binary
// (update-check.ts). Advisory — never a FAIL.
export async function checkKonteRelease(): Promise<CheckResult> {
  const name = "konte release";
  const result = await checkForUpdate(pkg.version);
  switch (result.kind) {
    case "outdated":
      return {
        name,
        status: "WARN",
        message: `v${result.latest} is out (installed v${result.current}) — run the konte-upgrade skill`,
      };
    case "current":
      return { name, status: "PASS", message: `v${result.current} is the latest release` };
    case "unknown":
      return {
        name,
        status: "PASS",
        message: `v${result.current}; could not check for a newer release (${result.reason})`,
      };
    case "disabled":
      return {
        name,
        status: "PASS",
        message: `v${result.current}; release check disabled (KONTE_UPDATE_CHECK=0)`,
      };
  }
}
