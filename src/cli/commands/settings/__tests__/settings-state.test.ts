import * as fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadKonteConfig, saveKonteConfig } from "../../../../core/config.js";
import {
  applyCredentials,
  credentialsPath,
  loadCredentials,
  saveCredentials,
} from "../../../../core/credentials.js";
import type { CredentialEntry } from "../../../../pages/settings/types.js";
import { makeWorkspace, type Workspace } from "../../../../core/__tests__/helpers/workspace.js";
import { CredentialsPatchSchema } from "../../../../core/types/credentials.js";
import { applyCredentialsPatch, credentialEntries, saveCredentialsPatch } from "../state.js";

let ws: Workspace;

beforeEach(async () => {
  ws = await makeWorkspace({ config: { comfyui: { url: "http://comfy:8188" } } });
});

afterEach(async () => {
  await ws.cleanup();
});

function entry(list: CredentialEntry[], key: string): CredentialEntry {
  const found = list.find((e) => e.key === key);
  if (!found) throw new Error(`no entry for ${key}`);
  return found;
}

describe("config", () => {
  it("round-trips what the Config tab saves", async () => {
    await saveKonteConfig(ws.root, {
      comfyui: { url: "http://comfy:9000" },
      preview: { host: "127.0.0.1" },
    });

    await expect(loadKonteConfig(ws.root)).resolves.toEqual({
      comfyui: { url: "http://comfy:9000" },
      preview: { host: "127.0.0.1" },
    });
  });

  it("refuses a config the schema rejects, leaving the file as it was", async () => {
    await expect(saveKonteConfig(ws.root, { comfyui: { url: 42 } } as never)).rejects.toThrow();

    await expect(loadKonteConfig(ws.root)).resolves.toMatchObject({
      comfyui: { url: "http://comfy:8188" },
    });
  });
});

describe("credentialEntries", () => {
  it("reports every known key, set or not, and never a value", async () => {
    await saveCredentials(ws.root, { FAL_KEY: "super-secret" });

    const list = await credentialEntries(ws.root);
    expect(entry(list, "FAL_KEY").isSet).toBe(true);
    expect(entry(list, "CIVITAI_TOKEN").isSet).toBe(false);
    expect(JSON.stringify(list)).not.toContain("super-secret");
  });

  it("lists a key konte does not ship, so a custom adapter's ${VAR} is manageable", async () => {
    await saveCredentials(ws.root, { MY_TOKEN: "t" });

    const found = entry(await credentialEntries(ws.root), "MY_TOKEN");
    expect(found.known).toBe(false);
    expect(found.isSet).toBe(true);
  });

  it("says when a real environment variable is shadowing the stored one", async () => {
    process.env.CIVITAI_TOKEN = "from-shell";
    try {
      expect(entry(await credentialEntries(ws.root), "CIVITAI_TOKEN").fromEnvironment).toBe(true);
    } finally {
      delete process.env.CIVITAI_TOKEN;
    }
  });

  // The CLI puts the file's credentials into process.env before any command runs, so a stored key
  // is in the environment either way — reading process.env alone calls every one of them an
  // override.
  it("does not call a stored key an environment override after the CLI loaded it", async () => {
    // A konte-only name, so a contributor who exports FAL_KEY does not fail this.
    await saveCredentials(ws.root, { KONTE_TEST_CRED: "from-file" });
    await applyCredentials(ws.root);

    try {
      const found = entry(await credentialEntries(ws.root), "KONTE_TEST_CRED");
      expect(found.isSet).toBe(true);
      expect(found.fromEnvironment).toBe(false);
    } finally {
      delete process.env.KONTE_TEST_CRED;
    }
  });
});

describe("CredentialsPatchSchema", () => {
  it("accepts a patch that only sets, only unsets, or does neither", () => {
    expect(CredentialsPatchSchema.safeParse({ set: { FAL_KEY: "k" } }).success).toBe(true);
    expect(CredentialsPatchSchema.safeParse({ unset: ["FAL_KEY"] }).success).toBe(true);
    expect(CredentialsPatchSchema.safeParse({}).success).toBe(true);
  });

  // Without the schema `unset: "FAL_KEY"` iterates the string's characters, deleting nothing and
  // reporting success.
  it("rejects an unset that is a bare string rather than a list", () => {
    expect(CredentialsPatchSchema.safeParse({ unset: "FAL_KEY" }).success).toBe(false);
  });

  it("rejects a body that is not an object, and a non-string value", () => {
    expect(CredentialsPatchSchema.safeParse([]).success).toBe(false);
    expect(CredentialsPatchSchema.safeParse(null).success).toBe(false);
    expect(CredentialsPatchSchema.safeParse({ set: { FAL_KEY: 1 } }).success).toBe(false);
  });

  it("rejects a key that is not an environment variable name, on either side", () => {
    expect(CredentialsPatchSchema.safeParse({ set: { "not a key": "v" } }).success).toBe(false);
    expect(CredentialsPatchSchema.safeParse({ unset: ["not a key"] }).success).toBe(false);
  });

  // Stripped rather than rejected, a misspelled field would save nothing and report success.
  it("rejects a misspelled field instead of silently dropping it", () => {
    expect(CredentialsPatchSchema.safeParse({ sets: { FAL_KEY: "k" } }).success).toBe(false);
    expect(CredentialsPatchSchema.safeParse({ unsets: ["FAL_KEY"] }).success).toBe(false);
  });
});

describe("applyCredentialsPatch", () => {
  it("leaves the keys it does not name alone", () => {
    expect(
      applyCredentialsPatch(
        { FAL_KEY: "keep-me", HF_TOKEN: "drop-me" },
        { set: { CIVITAI_TOKEN: "new" }, unset: ["HF_TOKEN"] },
      ),
    ).toEqual({ FAL_KEY: "keep-me", CIVITAI_TOKEN: "new" });
  });

  it("treats an empty value as a removal, not as a stored empty key", () => {
    expect(applyCredentialsPatch({ FAL_KEY: "k" }, { set: { FAL_KEY: "" } })).toEqual({});
  });

  it("changes nothing on an empty patch, so a save with no edits is a no-op", () => {
    expect(applyCredentialsPatch({ FAL_KEY: "k" }, {})).toEqual({ FAL_KEY: "k" });
  });
});

describe("saveCredentialsPatch", () => {
  it("writes the patched set and reports it back", async () => {
    await saveCredentials(ws.root, { FAL_KEY: "old" });

    const entries = await saveCredentialsPatch(ws.root, { set: { FAL_KEY: "new" } });

    expect(entry(entries, "FAL_KEY").isSet).toBe(true);
    await expect(loadCredentials(ws.root)).resolves.toEqual({ FAL_KEY: "new" });
  });

  it("rejects a key that is not an environment variable name, writing nothing", async () => {
    await expect(saveCredentialsPatch(ws.root, { set: { "not a key": "v" } })).rejects.toThrow();
    await expect(fs.access(credentialsPath(ws.root))).rejects.toThrow();
  });

  it("keeps both keys when two patches are saved at once", async () => {
    await Promise.all([
      saveCredentialsPatch(ws.root, { set: { FAL_KEY: "a" } }),
      saveCredentialsPatch(ws.root, { set: { CIVITAI_TOKEN: "b" } }),
    ]);

    await expect(loadCredentials(ws.root)).resolves.toEqual({
      FAL_KEY: "a",
      CIVITAI_TOKEN: "b",
    });
  });
});
