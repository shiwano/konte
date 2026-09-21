import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  linkWorkspaceBinary,
  prepareAgentSettings,
  writeAgentSettings,
} from "../agent-settings.js";

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'konte settings "日本語" '));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

function codex(files: Record<string, string>): any {
  return Bun.TOML.parse(files[".codex/config.toml"]!);
}

function claude(files: Record<string, string>): any {
  return JSON.parse(files[".claude/settings.json"]!);
}

function pathHooks(files: Record<string, string>): string[] {
  return claude(files).hooks.SessionStart.flatMap((entry: any) =>
    entry.hooks.map((hook: any) => hook.command),
  );
}

describe("environment-specific agent settings", () => {
  it("uses absolute MCP/LSP paths and PATH-based CLI permissions", async () => {
    const files = await prepareAgentSettings(root);
    const binary = path.join(root, ".konte/bin/konte");
    const config = codex(files);
    expect(claude(files).permissions.allow).toEqual(["Bash(konte:*)"]);
    expect(files[".claude/settings.json"]).not.toContain(`Bash(${binary}`);
    expect(config.default_permissions).toBe(":workspace");
    expect(config.approval_policy).toBe("on-request");
    expect(config.approvals_reviewer).toBe("auto_review");
    expect(config.mcp_servers.konte).toEqual({
      command: binary,
      args: ["--cwd", root, "mcp", "serve"],
      cwd: root,
    });
    expect(JSON.parse(files[".mcp.json"]!).mcpServers.konte.command).toBe(binary);
    expect(
      JSON.parse(files[".claude/skills/konte-lsp/.claude-plugin/plugin.json"]!).lspServers
        .typescript.command,
    ).toBe(binary);
    expect(files[".codex/rules/konte.rules"]).toContain('pattern = [["konte", "konte.exe"]]');
    expect(files[".codex/rules/konte.rules"]!.match(/prefix_rule\(/g)).toHaveLength(1);
    expect(files[".codex/rules/konte.rules"]).not.toContain(root);
  });

  it("escapes native Windows paths and explicitly names the exe", async () => {
    vi.stubEnv("PATH", "C:\\Windows\\System32;C:\\Program Files\\Git\\cmd");
    const windowsRoot = 'C:\\Films\\日本語 "cut"';
    const files = await prepareAgentSettings(windowsRoot, "win32");
    expect(codex(files).mcp_servers.konte.command).toBe(`${windowsRoot}\\.konte\\bin\\konte.exe`);
    expect(codex(files).mcp_servers.konte.cwd).toBe(windowsRoot);
    const expectedPath = `${windowsRoot}\\.konte\\bin;C:\\Windows\\System32;C:\\Program Files\\Git\\cmd`;
    expect(codex(files).shell_environment_policy.set.PATH).toBe(expectedPath);
    expect(pathHooks(files)).toEqual([
      'echo "export PATH=\\"$(cygpath -u \\"$CLAUDE_PROJECT_DIR\\")/.konte/bin:\\$PATH\\"" >> "$CLAUDE_ENV_FILE"',
    ]);
    expect(claude(files).env.PATH).toBeUndefined();
  });

  it.each(["linux", "win32"] as const)(
    "preserves the project PATH and environment across repeated %s setup",
    async (platform) => {
      const paths = platform === "win32" ? path.win32 : path.posix;
      const binDir = paths.join(root, ".konte", "bin");
      const existingBin = platform === "win32" ? binDir.toUpperCase() : binDir;
      const existingPath = ["custom-tools", existingBin, "other-tools"].join(paths.delimiter);
      const configuredKey = platform === "win32" ? "Path" : "PATH";
      vi.stubEnv("PATH", "inherited-tools");
      await fs.mkdir(path.join(root, ".codex"));
      await fs.writeFile(
        path.join(root, ".codex/config.toml"),
        `[shell_environment_policy]\ninherit = "all"\n[shell_environment_policy.set]\n${configuredKey} = ${JSON.stringify(existingPath)}\nCUSTOM = "keep"\n`,
      );
      await fs.mkdir(path.join(root, ".claude"));
      const ownHook = { hooks: [{ type: "command", command: "say-hello" }] };
      await fs.writeFile(
        path.join(root, ".claude/settings.json"),
        JSON.stringify({
          env: { [configuredKey]: existingPath, CUSTOM: "keep" },
          hooks: { SessionStart: [ownHook] },
        }),
      );

      const files = await prepareAgentSettings(root, platform);
      const expectedPath = [binDir, "custom-tools", "other-tools"].join(paths.delimiter);
      expect(codex(files).shell_environment_policy).toEqual({
        inherit: "all",
        set: { PATH: expectedPath, CUSTOM: "keep" },
      });
      expect(claude(files).env).toEqual({
        CUSTOM: "keep",
        CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP: "1",
      });
      expect(claude(files).hooks.SessionStart[0]).toEqual(ownHook);
      expect(pathHooks(files)).toHaveLength(2);
      expect(process.env.PATH).toBe("inherited-tools");
      await writeAgentSettings(root, files);
      expect(await prepareAgentSettings(root, platform)).toEqual(files);
    },
  );

  it("prepends the workspace bin to the inherited POSIX PATH", async () => {
    vi.stubEnv("PATH", "/usr/local/bin:/usr/bin");
    const files = await prepareAgentSettings(root, "linux");
    expect(codex(files).shell_environment_policy.set.PATH).toBe(
      `${root}/.konte/bin:/usr/local/bin:/usr/bin`,
    );
    expect(pathHooks(files)).toEqual([
      'echo "export PATH=\\"$CLAUDE_PROJECT_DIR/.konte/bin:\\$PATH\\"" >> "$CLAUDE_ENV_FILE"',
    ]);
  });

  it("preserves user values, other servers and unresolved secrets across regeneration", async () => {
    await writeAgentSettings(root, await prepareAgentSettings(root));
    await fs.writeFile(
      path.join(root, ".codex/config.toml"),
      `model = "custom"\ndeveloper_instructions = "personal"\n[mcp_servers.other]\ncommand = "other"\n[mcp_servers.other.env]\nTOKEN = "\${PRIVATE_TOKEN}"\n[mcp_servers.konte]\ncommand = "old"\nstartup_timeout_sec = 42\n`,
    );
    await fs.writeFile(
      path.join(root, ".claude/settings.json"),
      JSON.stringify({
        env: { CUSTOM: "keep" },
        permissions: { allow: ["Bash(git status)", "Bash(/old/.konte/bin/konte:*)"], deny: [] },
      }),
    );
    const files = await prepareAgentSettings(root);
    const config = codex(files);
    expect(config.model).toBe("custom");
    expect(config.developer_instructions).toBe("personal");
    expect(config.mcp_servers.other.env.TOKEN).toBe("${PRIVATE_TOKEN}");
    expect(config.mcp_servers.konte.startup_timeout_sec).toBe(42);
    expect(config.mcp_servers.konte.command).toBe(path.join(root, ".konte/bin/konte"));
    const settings = JSON.parse(files[".claude/settings.json"]!);
    expect(settings.env.CUSTOM).toBe("keep");
    expect(settings.permissions.deny).toEqual([]);
    expect(settings.permissions.allow).toEqual(["Bash(git status)", "Bash(konte:*)"]);
    await writeAgentSettings(root, files);
    expect(await prepareAgentSettings(root)).toEqual(files);
  });

  it("refuses malformed settings without echoing their contents or writing other files", async () => {
    await fs.writeFile(path.join(root, ".mcp.json"), '{ "secret": "DO-NOT-PRINT",');
    await expect(prepareAgentSettings(root)).rejects.toMatchObject({
      code: "INVALID_AGENT_SETTINGS",
      message: expect.not.stringContaining("DO-NOT-PRINT"),
    });
    await expect(fs.access(path.join(root, ".codex/config.toml"))).rejects.toThrow();
  });
});

describe("linkWorkspaceBinary", () => {
  let installed: string;
  let binary: string;
  beforeEach(async () => {
    installed = path.join(root, "Cellar", "konte");
    binary = path.join(root, ".konte", "bin", "konte");
    await fs.mkdir(path.dirname(installed), { recursive: true });
    await fs.writeFile(installed, "binary", { mode: 0o755 });
    vi.stubEnv("PATH", "");
  });

  it("links the running binary into .konte/bin", async () => {
    await linkWorkspaceBinary(root, installed, "linux");
    expect(await fs.readlink(binary)).toBe(await fs.realpath(installed));
  });

  it("targets the PATH entry that resolves to the running binary", async () => {
    const pathDir = path.join(root, "homebrew", "bin");
    await fs.mkdir(pathDir, { recursive: true });
    await fs.symlink(installed, path.join(pathDir, "konte"));
    vi.stubEnv("PATH", [path.dirname(binary), pathDir].join(path.delimiter));
    await linkWorkspaceBinary(root, installed, "linux");
    expect(await fs.readlink(binary)).toBe(path.join(pathDir, "konte"));
  });

  it("replaces an existing link", async () => {
    await fs.mkdir(path.dirname(binary), { recursive: true });
    await fs.symlink(path.join(root, "gone"), binary);
    await linkWorkspaceBinary(root, installed, "linux");
    expect(await fs.readlink(binary)).toBe(await fs.realpath(installed));
  });

  it("skips a PATH alias of the workspace bin", async () => {
    await fs.mkdir(path.dirname(binary), { recursive: true });
    await fs.symlink(installed, binary);
    const alias = path.join(root, "alias");
    await fs.symlink(root, alias);
    vi.stubEnv("PATH", path.join(alias, ".konte", "bin"));
    await linkWorkspaceBinary(root, installed, "linux");
    expect(await fs.readlink(binary)).toBe(await fs.realpath(installed));
  });

  it("keeps a binary installed by the setup script", async () => {
    await fs.mkdir(path.dirname(binary), { recursive: true });
    await fs.writeFile(binary, "pinned");
    await linkWorkspaceBinary(root, installed, "linux");
    expect(await fs.readFile(binary, "utf8")).toBe("pinned");
  });

  it("does nothing on Windows", async () => {
    await linkWorkspaceBinary(root, installed, "win32");
    expect(await fs.lstat(binary).catch(() => null)).toBeNull();
  });
});
