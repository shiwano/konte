import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import pkg from "../../../package.json" with { type: "json" };
import { prepareAgentSettings, writeAgentSettings } from "../agent-settings.js";
import {
  BUNDLED_ADAPTERS,
  loadManagedTemplateContents,
  loadWorkspaceTemplate,
  MANAGED_TEMPLATES,
  TEMPLATE_HASH,
} from "../generated/template-assets.js";
import { assertKonteCurrent, assertWorkspaceSynced, syncWorkspace } from "../template-sync.js";

const MANAGED_TEMPLATE_CONTENTS = await loadManagedTemplateContents();

const LOCK_FILE = ".konte/template.lock.json";
const VERSION_FILE = "konte.version";
const SKILL_KEY = ".claude/skills/prompt-guide/SKILL.md";
const MOD_KEY = ".konte/mod.ts";
const AGENT_KEY = ".claude/agents/konte-direction-critic.md";
const ADAPTER_KEY = "adapters/comfy/image_z_image_base.ts";
const ADAPTER_CONTENT = (await loadWorkspaceTemplate())[ADAPTER_KEY]!;

async function writeFileAt(dir: string, key: string, content: string): Promise<void> {
  const full = path.join(dir, key);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, "utf-8");
}

async function readFileAt(dir: string, key: string): Promise<string> {
  return fs.readFile(path.join(dir, key), "utf-8");
}

async function writeLock(
  dir: string,
  lock: { hash: string; root?: string; files?: string[] },
): Promise<void> {
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

  it("restores a missing mod.ts even when the lock hash matches", async () => {
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
    await syncWorkspace(tmpDir);
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

  it("replaces an edited bundled adapter with the current one", async () => {
    await writeFileAt(tmpDir, ADAPTER_KEY, "// tuned by hand");
    const result = await syncWorkspace(tmpDir);
    expect(result?.updated).toContain(ADAPTER_KEY);
    expect(await readFileAt(tmpDir, ADAPTER_KEY)).toBe(ADAPTER_CONTENT);
  });

  it("leaves out a bundled adapter the workspace removed", async () => {
    await writeFileAt(tmpDir, VERSION_FILE, `${pkg.version}\n`);
    const result = await syncWorkspace(tmpDir);
    expect(result?.created.filter((key) => key in BUNDLED_ADAPTERS)).toEqual(
      Object.keys(BUNDLED_ADAPTERS).filter((key) => BUNDLED_ADAPTERS[key] === null),
    );
  });

  it("adds a bundled adapter shipped after the konte that last synced the workspace", async () => {
    await writeFileAt(tmpDir, VERSION_FILE, "0.0.0\n");
    const result = await syncWorkspace(tmpDir);
    expect(result?.created).toEqual(expect.arrayContaining(Object.keys(BUNDLED_ADAPTERS)));
    expect(await readFileAt(tmpDir, ADAPTER_KEY)).toBe(ADAPTER_CONTENT);
    expect(await readFileAt(tmpDir, VERSION_FILE)).toBe(`${pkg.version}\n`);
  });

  it("adds no bundled adapter to a workspace with no version marker", async () => {
    const result = await syncWorkspace(tmpDir);
    expect(result?.created.some((key) => key in BUNDLED_ADAPTERS)).toBe(false);
  });

  it("keeps the version marker until every file is written", async () => {
    await writeFileAt(tmpDir, VERSION_FILE, "0.0.0\n");
    await writeFileAt(tmpDir, AGENT_KEY, "old agent");
    await fs.chmod(path.join(tmpDir, AGENT_KEY), 0o444);

    await syncWorkspace(tmpDir);
    expect(await readFileAt(tmpDir, VERSION_FILE)).toBe("0.0.0\n");

    await fs.chmod(path.join(tmpDir, AGENT_KEY), 0o644);
    await syncWorkspace(tmpDir);
    expect(await readFileAt(tmpDir, VERSION_FILE)).toBe(`${pkg.version}\n`);
  });

  it("leaves user-added files (not in the template set) untouched", async () => {
    const customKey = ".claude/skills/custom/SKILL.md";
    await writeFileAt(tmpDir, customKey, "my custom skill");
    await syncWorkspace(tmpDir);
    expect(await readFileAt(tmpDir, customKey)).toBe("my custom skill");
  });
});

describe("syncWorkspace retired adapters and guides", () => {
  const OLD_ADAPTER = "adapters/comfy/old_model.ts";
  const OLD_WORKFLOW = "adapters/comfy/old_model.json";
  const OLD_GUIDE = ".konte/guides/old-model.md";
  const RETIRED = [OLD_ADAPTER, OLD_WORKFLOW, OLD_GUIDE];

  async function retiredWorkspace(lockFiles: string[] | undefined): Promise<void> {
    await writeFileAt(
      tmpDir,
      OLD_ADAPTER,
      'export const oldModel = defineComfyAsset({ workflow: "old_model.json", guide: "konte/guides/old-model.md" });\n',
    );
    await writeFileAt(tmpDir, OLD_WORKFLOW, "{}");
    await writeFileAt(tmpDir, OLD_GUIDE, "# old model");
    await writeLock(tmpDir, { hash: "stale", ...(lockFiles ? { files: lockFiles } : {}) });
  }

  async function exists(key: string): Promise<boolean> {
    return fs.access(path.join(tmpDir, key)).then(
      () => true,
      () => false,
    );
  }

  async function lockFiles(): Promise<string[]> {
    return JSON.parse(await readFileAt(tmpDir, LOCK_FILE)).files;
  }

  it("deletes a retired adapter, its workflow and its guide that nothing names", async () => {
    await retiredWorkspace(RETIRED);
    const result = await syncWorkspace(tmpDir);
    expect(result?.removed.sort()).toEqual([...RETIRED].sort());
    expect(result?.retained).toEqual([]);
    for (const key of RETIRED) expect(await exists(key)).toBe(false);
    expect(await lockFiles()).not.toContain(OLD_ADAPTER);
  });

  it("keeps a retired adapter a video imports, with the workflow and guide it names", async () => {
    await retiredWorkspace(RETIRED);
    await writeFileAt(
      tmpDir,
      "videos/a/video.tsx",
      'import { oldModel } from "konte/workspace/adapters/comfy/old_model.js";\n',
    );
    const result = await syncWorkspace(tmpDir);
    expect(result?.removed).toEqual([]);
    expect(result?.retained.sort()).toEqual([...RETIRED].sort());
    for (const key of RETIRED) expect(await exists(key)).toBe(true);
    expect(await lockFiles()).toEqual(expect.arrayContaining(RETIRED));
  });

  it("keeps a retired adapter workspace code outside videos imports", async () => {
    await retiredWorkspace(RETIRED);
    await writeFileAt(
      tmpDir,
      "lib/models.ts",
      'export { oldModel } from "konte/workspace/adapters/comfy/old_model.js";\n',
    );
    await writeFileAt(
      tmpDir,
      "node_modules/pkg/index.ts",
      'import "konte/workspace/adapters/comfy/old_model.js";\n',
    );
    expect((await syncWorkspace(tmpDir))?.retained.sort()).toEqual([...RETIRED].sort());
  });

  it("keeps a retired adapter imported by its .ts path", async () => {
    await retiredWorkspace(RETIRED);
    await writeFileAt(
      tmpDir,
      "videos/a/video.tsx",
      'import { oldModel } from "konte/workspace/adapters/comfy/old_model.ts";\n',
    );
    expect((await syncWorkspace(tmpDir))?.retained.sort()).toEqual([...RETIRED].sort());
  });

  it("keeps a retired adapter imported without an extension", async () => {
    await retiredWorkspace(RETIRED);
    await writeFileAt(
      tmpDir,
      "videos/a/video.tsx",
      'import { oldModel } from "konte/workspace/adapters/comfy/old_model";\n',
    );
    expect((await syncWorkspace(tmpDir))?.retained.sort()).toEqual([...RETIRED].sort());
  });

  it("deletes nothing a lock entry reaches outside adapters and guides", async () => {
    await writeFileAt(tmpDir, "keep.txt", "mine");
    await writeLock(tmpDir, { hash: "stale", files: ["adapters/../keep.txt"] });
    expect((await syncWorkspace(tmpDir))?.removed).toEqual([]);
    expect(await exists("keep.txt")).toBe(true);
  });

  it("deletes a retired adapter only node_modules names", async () => {
    await retiredWorkspace(RETIRED);
    await writeFileAt(
      tmpDir,
      "node_modules/pkg/index.ts",
      'import "konte/workspace/adapters/comfy/old_model.js";\n',
    );
    expect((await syncWorkspace(tmpDir))?.removed.sort()).toEqual([...RETIRED].sort());
  });

  it("keeps a retired workflow konte.config.json routes", async () => {
    await retiredWorkspace([OLD_WORKFLOW]);
    await writeFileAt(
      tmpDir,
      "konte.config.json",
      JSON.stringify({ comfy: { adapters: { old_model: ["comfyui"] } } }),
    );
    const result = await syncWorkspace(tmpDir);
    expect(result?.retained).toEqual([OLD_WORKFLOW]);
    expect(await exists(OLD_WORKFLOW)).toBe(true);
  });

  it("leaves an adapter and guide the lock does not record", async () => {
    await retiredWorkspace([]);
    const result = await syncWorkspace(tmpDir);
    expect(result?.removed).toEqual([]);
    for (const key of RETIRED) expect(await exists(key)).toBe(true);
  });

  it("deletes nothing under a lock with no file record, then records what it placed", async () => {
    await retiredWorkspace(undefined);
    const result = await syncWorkspace(tmpDir);
    expect(result?.removed).toEqual([]);
    for (const key of RETIRED) expect(await exists(key)).toBe(true);
    const files = await lockFiles();
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((key) => /^(adapters|\.konte\/guides)\//.test(key))).toBe(true);
    expect(files).not.toContain(OLD_ADAPTER);
  });
});

describe("syncWorkspace agent settings", () => {
  async function synced(dir: string): Promise<void> {
    for (const [key, content] of Object.entries(await loadWorkspaceTemplate())) {
      await writeFileAt(dir, key, content);
    }
    await syncWorkspace(dir);
  }

  it("renders the agent settings for a workspace that moved", async () => {
    await synced(tmpDir);
    const moved = `${tmpDir}-moved`;
    await fs.rename(tmpDir, moved);
    try {
      await syncWorkspace(moved);
      const codex = Bun.TOML.parse(await readFileAt(moved, ".codex/config.toml")) as any;
      expect(codex.shell_environment_policy.set.PATH.split(path.delimiter)[0]).toBe(
        path.join(moved, ".konte/bin"),
      );
    } finally {
      await fs.rename(moved, tmpDir);
    }
  });

  it("restores a missing agent setting even when the lock matches", async () => {
    await synced(tmpDir);
    await fs.rm(path.join(tmpDir, ".codex/config.toml"));
    await syncWorkspace(tmpDir);
    await fs.access(path.join(tmpDir, ".codex/config.toml"));
  });

  it("appends the template's missing .gitignore lines", async () => {
    await synced(tmpDir);
    await writeFileAt(tmpDir, ".gitignore", "my-cache/");
    await writeLock(tmpDir, { hash: "stale" });
    await syncWorkspace(tmpDir);
    const ignore = await readFileAt(tmpDir, ".gitignore");
    expect(ignore.startsWith("my-cache/\n")).toBe(true);
    expect(ignore).toContain(".codex/config.toml\n");
  });

  it("writes the version marker at the workspace root", async () => {
    await synced(tmpDir);
    expect(await readFileAt(tmpDir, VERSION_FILE)).toBe(`${pkg.version}\n`);
  });
});

describe("assertWorkspaceSynced", () => {
  async function synced(dir: string): Promise<void> {
    for (const [key, content] of Object.entries(await loadWorkspaceTemplate())) {
      await writeFileAt(dir, key, content);
    }
    await syncWorkspace(dir);
  }

  it("passes a workspace this konte synced and writes nothing", async () => {
    await synced(tmpDir);
    await writeFileAt(tmpDir, SKILL_KEY, "MY HAND-EDITED PROMPT GUIDE");
    await assertWorkspaceSynced(tmpDir);
    expect(await readFileAt(tmpDir, SKILL_KEY)).toBe("MY HAND-EDITED PROMPT GUIDE");
  });

  it("refuses a lock naming another template hash", async () => {
    await synced(tmpDir);
    await writeLock(tmpDir, { hash: "stale" });
    await expect(assertWorkspaceSynced(tmpDir)).rejects.toMatchObject({
      code: "WORKSPACE_SETUP_REQUIRED",
    });
  });

  it("refuses a workspace with no lock", async () => {
    await expect(assertWorkspaceSynced(tmpDir)).rejects.toMatchObject({
      code: "WORKSPACE_SETUP_REQUIRED",
    });
  });

  it("refuses a missing managed file or agent setting", async () => {
    await synced(tmpDir);
    await fs.rm(path.join(tmpDir, MOD_KEY));
    await expect(assertWorkspaceSynced(tmpDir)).rejects.toMatchObject({
      code: "WORKSPACE_SETUP_REQUIRED",
    });
    await syncWorkspace(tmpDir);
    await fs.rm(path.join(tmpDir, ".codex/config.toml"));
    await expect(assertWorkspaceSynced(tmpDir)).rejects.toMatchObject({
      code: "WORKSPACE_SETUP_REQUIRED",
    });
  });

  it("refuses a workspace that moved", async () => {
    await synced(tmpDir);
    const moved = `${tmpDir}-moved`;
    await fs.rename(tmpDir, moved);
    try {
      await expect(assertWorkspaceSynced(moved)).rejects.toMatchObject({
        code: "WORKSPACE_SETUP_REQUIRED",
      });
    } finally {
      await fs.rename(moved, tmpDir);
    }
  });

  it("refuses a workspace a newer konte set up, whatever the lock says", async () => {
    await synced(tmpDir);
    const [major, minor, patch] = pkg.version.split(".").map(Number);
    await writeFileAt(tmpDir, VERSION_FILE, `${major}.${minor}.${patch! + 1}\n`);
    await expect(assertWorkspaceSynced(tmpDir)).rejects.toMatchObject({ code: "KONTE_OUTDATED" });
    await expect(assertKonteCurrent(tmpDir)).rejects.toMatchObject({ code: "KONTE_OUTDATED" });
  });

  it("passes a konte.version naming this konte or an older one", async () => {
    await writeFileAt(tmpDir, VERSION_FILE, `${pkg.version}\n`);
    await assertKonteCurrent(tmpDir);
    await writeFileAt(tmpDir, VERSION_FILE, "0.0.1\n");
    await assertKonteCurrent(tmpDir);
  });

  it("refuses an older konte.version as a setup, not an upgrade", async () => {
    await synced(tmpDir);
    await writeFileAt(tmpDir, VERSION_FILE, "0.0.1\n");
    await writeLock(tmpDir, { hash: "stale" });
    await expect(assertWorkspaceSynced(tmpDir)).rejects.toMatchObject({
      code: "WORKSPACE_SETUP_REQUIRED",
    });
  });
});
