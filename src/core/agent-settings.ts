import * as fs from "node:fs/promises";
import * as path from "node:path";
import { writeFileAtomic } from "./atomic-write.js";
import { KonteError } from "./errors.js";
import { loadWorkspaceTemplate } from "./generated/template-assets.js";

export const AGENT_SETTINGS_FILES = new Set([
  ".mcp.json",
  ".claude/settings.json",
  ".codex/config.toml",
  ".codex/rules/konte.rules",
  ".claude/skills/konte-lsp/.claude-plugin/plugin.json",
]);

type Settings = Record<string, unknown>;
const toml = Bun.TOML as typeof Bun.TOML & { stringify(value: Settings): string };

function isTable(value: unknown): value is Settings {
  return (
    value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)
  );
}

function table(parent: Settings, key: string): Settings {
  const value = parent[key];
  if (!isTable(value)) throw new Error("Expected a settings table");
  return value;
}

function withDefaults(defaults: Settings, current: Settings): Settings {
  const merged = { ...defaults, ...current };
  for (const [key, value] of Object.entries(defaults)) {
    if (isTable(value) && isTable(current[key])) {
      merged[key] = withDefaults(value, current[key]);
    }
  }
  return merged;
}

function isPathKeyFor(name: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" ? name.toUpperCase() === "PATH" : name === "PATH";
}

function leadPathWithBin(env: Settings, binDir: string, platform: NodeJS.Platform): void {
  const paths = platform === "win32" ? path.win32 : path;
  const isPathKey = (name: string) => isPathKeyFor(name, platform);
  const configuredKey = Object.keys(env).find(isPathKey);
  const inheritedKey = Object.keys(process.env).find(isPathKey);
  const current = configuredKey
    ? env[configuredKey]
    : inheritedKey
      ? process.env[inheritedKey]
      : "";
  if (typeof current !== "string") throw new Error("Expected PATH string");
  const normalize = (entry: string) =>
    platform === "win32" ? paths.normalize(entry).toLowerCase() : paths.normalize(entry);
  const entries = current
    ? current.split(paths.delimiter).filter((entry) => normalize(entry) !== normalize(binDir))
    : [];
  for (const name of Object.keys(env).filter(isPathKey)) delete env[name];
  env.PATH = [binDir, ...entries].join(paths.delimiter);
}

// Claude Code ignores `env.PATH`; a SessionStart hook appending to $CLAUDE_ENV_FILE is the one
// way to lead the Bash tool's PATH. Git Bash gets $CLAUDE_PROJECT_DIR as a Windows path, whose
// drive colon would split the PATH, so cygpath converts it.
function pathHookCommand(platform: NodeJS.Platform): string {
  const projectDir =
    platform === "win32" ? '$(cygpath -u \\"$CLAUDE_PROJECT_DIR\\")' : "$CLAUDE_PROJECT_DIR";
  return `echo "export PATH=\\"${projectDir}/.konte/bin:\\$PATH\\"" >> "$CLAUDE_ENV_FILE"`;
}

function isPathHook(entry: unknown): boolean {
  if (!isTable(entry) || !Array.isArray(entry.hooks)) return false;
  return entry.hooks.some(
    (hook) =>
      isTable(hook) &&
      typeof hook.command === "string" &&
      hook.command.includes("$CLAUDE_ENV_FILE") &&
      hook.command.includes("/.konte/bin"),
  );
}

function leadHookPathWithBin(settings: Settings, platform: NodeJS.Platform): void {
  const env = table(settings, "env");
  for (const name of Object.keys(env).filter((name) => isPathKeyFor(name, platform))) {
    delete env[name];
  }
  const hooks = table(settings, "hooks");
  const current = Array.isArray(hooks.SessionStart) ? hooks.SessionStart : [];
  hooks.SessionStart = [
    ...current.filter((entry) => !isPathHook(entry)),
    { hooks: [{ type: "command", command: pathHookCommand(platform) }] },
  ];
}

async function readOptional(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function prepareAgentSettings(
  workspaceRoot: string,
  platform: NodeJS.Platform = process.platform,
): Promise<Record<string, string>> {
  const template = await loadWorkspaceTemplate();
  const paths = platform === "win32" ? path.win32 : path;
  const binary = paths.join(
    workspaceRoot,
    ".konte",
    "bin",
    platform === "win32" ? "konte.exe" : "konte",
  );
  const binDir = paths.dirname(binary);
  const rendered: Record<string, string> = {};
  for (const key of AGENT_SETTINGS_FILES) {
    if (key.endsWith(".rules")) {
      rendered[key] = template[key]!;
      continue;
    }
    try {
      const parse = key.endsWith(".toml") ? Bun.TOML.parse : JSON.parse;
      const defaults = parse(template[key]!);
      const raw = await readOptional(path.join(workspaceRoot, key));
      const current = raw === null ? {} : parse(raw);
      if (!isTable(defaults) || !isTable(current)) throw new Error("Expected settings object");
      const settings = withDefaults(defaults, current);
      if (key === ".claude/settings.json") {
        const permissions = table(settings, "permissions");
        if (!Array.isArray(permissions.allow)) throw new Error("Expected permission list");
        const allow = permissions.allow.filter(
          (rule) =>
            typeof rule !== "string" ||
            !/^Bash\((?:konte|.*[/\\]\.konte[/\\]bin[/\\]konte(?:\.exe)?):\*\)$/.test(rule),
        );
        permissions.allow = [...allow, "Bash(konte:*)"];
        leadHookPathWithBin(settings, platform);
      } else if (key.endsWith("plugin.json")) {
        const server = table(table(settings, "lspServers"), "typescript");
        server.command = binary;
        server.args = ["--cwd", workspaceRoot, "lsp"];
      } else {
        const servers = table(settings, key === ".mcp.json" ? "mcpServers" : "mcp_servers");
        const server = table(servers, "konte");
        delete server.url;
        server.command = binary;
        server.args = ["--cwd", workspaceRoot, "mcp", "serve"];
        if (key === ".mcp.json") server.type = "stdio";
        else {
          server.cwd = workspaceRoot;
          leadPathWithBin(
            table(table(settings, "shell_environment_policy"), "set"),
            binDir,
            platform,
          );
        }
      }
      rendered[key] = key.endsWith(".toml")
        ? toml.stringify(settings)
        : `${JSON.stringify(settings, null, 2)}\n`;
    } catch {
      throw new KonteError(
        "INVALID_AGENT_SETTINGS",
        `Cannot read or merge ${key}; repair it and run konte workspace setup again`,
      );
    }
  }
  return rendered;
}

// A konte installed outside the workspace (brew, a copied build) is linked into .konte/bin, the
// one path agent settings launch. The link targets the PATH entry rather than its resolved file,
// which a package manager replaces on upgrade.
export async function linkWorkspaceBinary(
  workspaceRoot: string,
  executable: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform === "win32") return;
  const binDir = path.join(workspaceRoot, ".konte", "bin");
  const binary = path.join(binDir, "konte");
  const current = await fs.lstat(binary).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return null;
    throw err;
  });
  if (current && !current.isSymbolicLink()) return;
  const resolved = await fs.realpath(executable);
  await fs.mkdir(binDir, { recursive: true });
  const realBinDir = await fs.realpath(binDir);
  const entries = [];
  for (const entry of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!entry) continue;
    const real = await fs.realpath(entry).catch(() => path.resolve(entry));
    if (real !== realBinDir) entries.push(entry);
  }
  const found = Bun.which("konte", { PATH: entries.join(path.delimiter) });
  const target =
    found && (await fs.realpath(found).catch(() => null)) === resolved
      ? path.resolve(found)
      : resolved;
  const staged = path.join(binDir, `.konte-${process.pid}.tmp`);
  await fs.rm(staged, { force: true });
  await fs.symlink(target, staged);
  await fs.rename(staged, binary);
}

export async function writeAgentSettings(
  workspaceRoot: string,
  settings: Record<string, string>,
): Promise<void> {
  for (const [key, content] of Object.entries(settings)) {
    await writeFileAtomic(path.join(workspaceRoot, key), content, { mode: 0o600 });
  }
}
