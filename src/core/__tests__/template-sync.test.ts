import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import pkg from "../../../package.json" with { type: "json" };
import { prepareAgentSettings, writeAgentSettings } from "../agent-settings.js";
import {
  loadManagedTemplateContents,
  loadWorkspaceTemplate,
  MANAGED_TEMPLATES,
  TEMPLATE_HASH,
} from "../generated/template-assets.js";
import { syncWorkspace } from "../template-sync.js";

const MANAGED_TEMPLATE_CONTENTS = await loadManagedTemplateContents();

const LOCK_FILE = ".konte/template.lock.json";
const VERSION_FILE = "konte.version";
const SKILL_KEY = ".claude/skills/prompt-guide/SKILL.md";
const MOD_KEY = ".konte/mod.ts";
const AGENT_KEY = ".claude/agents/konte-direction-critic.md";

async function writeFileAt(dir: string, key: string, content: string): Promise<void> {
  const full = path.join(dir, key);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, "utf-8");
}

async function readFileAt(dir: string, key: string): Promise<string> {
  return fs.readFile(path.join(dir, key), "utf-8");
}

async function writeLock(dir: string, lock: { hash: string; root?: string }): Promise<void> {
  await writeFileAt(
    dir,
    LOCK_FILE,
    JSON.stringify({ version: "test", root: dir, updatedAt: "x", ...lock }),
  );
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "konte-template-sync-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true });
});

describe("syncWorkspace", () => {
  async function writeAllManaged(dir: string): Promise<void> {
    for (const key of MANAGED_TEMPLATES) {
      await writeFileAt(dir, key, MANAGED_TEMPLATE_CONTENTS[key]!);
    }
    await writeAgentSettings(dir, await prepareAgentSettings(dir));
  }

  it("returns null when the lock hash already matches (cheap fast-path)", async () => {
    await writeAllManaged(tmpDir);
    await writeFileAt(tmpDir, SKILL_KEY, "MY HAND-EDITED PROMPT GUIDE");
    await writeLock(tmpDir, { hash: TEMPLATE_HASH });
    expect(await syncWorkspace(tmpDir)).toBeNull();
    expect(await readFileAt(tmpDir, SKILL_KEY)).toBe("MY HAND-EDITED PROMPT GUIDE");
  });

  it("writes the version marker even when the fast path skips the templates", async () => {
    await writeAllManaged(tmpDir);
    await writeLock(tmpDir, { hash: TEMPLATE_HASH });
    await writeFileAt(tmpDir, VERSION_FILE, "0.0.0-old\n");

    expect(await syncWorkspace(tmpDir)).toBeNull();
    expect(await readFileAt(tmpDir, VERSION_FILE)).toBe(`${pkg.version}\n`);
  });

  it("creates missing managed files and writes a lock with the current hash", async () => {
    const result = await syncWorkspace(tmpDir);
    expect(result?.created).toContain(MOD_KEY);
    expect(result?.created).toContain(AGENT_KEY);
    expect(await readFileAt(tmpDir, AGENT_KEY)).toBe(MANAGED_TEMPLATE_CONTENTS[AGENT_KEY]);

    const lock = JSON.parse(await readFileAt(tmpDir, LOCK_FILE));
    expect(lock.hash).toBe(TEMPLATE_HASH);
  });

  it("replaces a user-edited skill with the current one", async () => {
    await writeFileAt(tmpDir, SKILL_KEY, "MY HAND-EDITED PROMPT GUIDE");
    await writeLock(tmpDir, { hash: "stale" });

    const result = await syncWorkspace(tmpDir);
    expect(result?.updated).toContain(SKILL_KEY);
    expect(await readFileAt(tmpDir, SKILL_KEY)).toBe(MANAGED_TEMPLATE_CONTENTS[SKILL_KEY]);
  });

  it("overwrites an edited mod.ts with no lock", async () => {
    await writeFileAt(tmpDir, MOD_KEY, "// user hacked the type stub");
    const result = await syncWorkspace(tmpDir);
    expect(result?.updated).toContain(MOD_KEY);
    expect(await readFileAt(tmpDir, MOD_KEY)).toBe(MANAGED_TEMPLATE_CONTENTS[MOD_KEY]!);
  });

  it("restores a missing mod.ts even when the lock hash matches (fast path)", async () => {
    await writeAllManaged(tmpDir);
    await fs.rm(path.join(tmpDir, MOD_KEY));
    await writeLock(tmpDir, { hash: TEMPLATE_HASH });
    const result = await syncWorkspace(tmpDir);
    expect(result?.created).toEqual([MOD_KEY]);
    expect(await readFileAt(tmpDir, MOD_KEY)).toBe(MANAGED_TEMPLATE_CONTENTS[MOD_KEY]!);
  });

  it("leaves HOUSE_RULES.md to the workspace", async () => {
    expect(MANAGED_TEMPLATES.has("HOUSE_RULES.md")).toBe(false);
    await writeFileAt(tmpDir, "HOUSE_RULES.md", "my rules");
    await syncWorkspace(tmpDir, { force: true });
    expect(await readFileAt(tmpDir, "HOUSE_RULES.md")).toBe("my rules");
  });

  it("skips a managed file it cannot write and leaves the lock for the next run", async () => {
    await writeFileAt(tmpDir, AGENT_KEY, "old agent");
    await fs.chmod(path.join(tmpDir, AGENT_KEY), 0o444);
    await writeLock(tmpDir, { hash: "stale" });

    const result = await syncWorkspace(tmpDir);
    expect(result?.unwritable).toEqual([AGENT_KEY]);
    expect(result?.updated).not.toContain(AGENT_KEY);
    expect(result?.created).toContain(MOD_KEY);
    expect(await readFileAt(tmpDir, AGENT_KEY)).toBe("old agent");
    expect(JSON.parse(await readFileAt(tmpDir, LOCK_FILE)).hash).toBe("stale");

    await fs.chmod(path.join(tmpDir, AGENT_KEY), 0o644);
    expect((await syncWorkspace(tmpDir))?.updated).toEqual([AGENT_KEY]);
    expect(JSON.parse(await readFileAt(tmpDir, LOCK_FILE)).hash).toBe(TEMPLATE_HASH);
  });

  it("leaves user-added files (not in the template set) untouched", async () => {
    const customKey = ".claude/skills/custom/SKILL.md";
    await writeFileAt(tmpDir, customKey, "my custom skill");
    await syncWorkspace(tmpDir);
    expect(await readFileAt(tmpDir, customKey)).toBe("my custom skill");
  });
});

describe("syncWorkspace agent settings", () => {
  async function synced(dir: string): Promise<void> {
    for (const [key, content] of Object.entries(await loadWorkspaceTemplate())) {
      await writeFileAt(dir, key, content);
    }
    await syncWorkspace(dir, { force: true });
  }

  it("leaves a workspace it just synced on the fast path", async () => {
    await synced(tmpDir);
    const lock = JSON.parse(await readFileAt(tmpDir, LOCK_FILE));
    expect(lock).toMatchObject({ hash: TEMPLATE_HASH, root: tmpDir });
    expect(await syncWorkspace(tmpDir)).toBeNull();
  });

  it("renders the agent settings for a workspace that moved, naming them to relaunch", async () => {
    await synced(tmpDir);
    const moved = `${tmpDir}-moved`;
    await fs.rename(tmpDir, moved);
    try {
      const result = await syncWorkspace(moved);
      expect(result?.relaunch).toContain(".mcp.json");
      const mcp = JSON.parse(await readFileAt(moved, ".mcp.json"));
      expect(mcp.mcpServers.konte.args).toEqual(["--cwd", moved, "mcp", "serve"]);
      expect(await syncWorkspace(moved)).toBeNull();
    } finally {
      await fs.rename(moved, tmpDir);
    }
  });

  it("restores a missing agent setting even when the lock matches", async () => {
    await synced(tmpDir);
    await fs.rm(path.join(tmpDir, ".mcp.json"));
    expect((await syncWorkspace(tmpDir))?.relaunch).toEqual([".mcp.json"]);
  });

  it("names nothing to relaunch when the settings it renders are already on disk", async () => {
    await synced(tmpDir);
    await writeLock(tmpDir, { hash: "stale" });
    expect((await syncWorkspace(tmpDir))?.relaunch).toEqual([]);
  });

  it("appends the template's missing .gitignore lines", async () => {
    await synced(tmpDir);
    await writeFileAt(tmpDir, ".gitignore", "my-cache/");
    await writeLock(tmpDir, { hash: "stale" });
    await syncWorkspace(tmpDir);
    const ignore = await readFileAt(tmpDir, ".gitignore");
    expect(ignore.startsWith("my-cache/\n")).toBe(true);
    expect(ignore).toContain(".mcp.json\n");
  });

  it("writes the version marker at the workspace root", async () => {
    await synced(tmpDir);
    expect(await readFileAt(tmpDir, VERSION_FILE)).toBe(`${pkg.version}\n`);
  });
});
