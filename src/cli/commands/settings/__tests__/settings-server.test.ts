import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { PageServerHandle } from "../../../page-host/run.js";
import { REDEEM_TOKEN_PATH, SESSION_HEADER } from "../../../../pages/settings/types.js";
import { createSettingsServer } from "../server.js";

const TOKEN = "t".repeat(43);
let root: string;
let server: PageServerHandle;
let base: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "konte-settings-"));
  server = await createSettingsServer({
    workspaceRoot: root,
    token: TOKEN,
    port: 0,
    autoClose: false,
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterEach(async () => {
  server.triggerShutdown();
  await server.shutdown;
  rmSync(root, { recursive: true, force: true });
});

function redeem(token: string): Promise<Response> {
  return fetch(`${base}${REDEEM_TOKEN_PATH}`, {
    method: "POST",
    headers: { origin: base, "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
}

it("serves the page itself without a session", async () => {
  expect((await fetch(`${base}/?tab=config`)).status).toBe(200);
});

it("refuses the API to a request without the session", async () => {
  const get = await fetch(`${base}/api/credentials`);
  expect(get.status).toBe(401);
  expect(await get.json()).toMatchObject({ code: "SESSION_REQUIRED" });

  const put = await fetch(`${base}/api/config`, {
    method: "PUT",
    headers: { origin: base, "content-type": "application/json", [SESSION_HEADER]: "forged" },
    body: "{}",
  });
  expect(put.status).toBe(401);
});

it("trades the launch token for a session the API accepts", async () => {
  const res = await redeem(TOKEN);
  expect(res.status).toBe(200);
  const { session } = (await res.json()) as { session: string };
  expect(session).not.toBe(TOKEN);

  const get = await fetch(`${base}/api/credentials`, { headers: { [SESSION_HEADER]: session } });
  expect(get.status).toBe(200);
});

it("trades the launch token once", async () => {
  await redeem(TOKEN);

  const again = await redeem(TOKEN);
  expect(again.status).toBe(401);
  expect(await again.json()).toMatchObject({ code: "SESSION_REQUIRED" });
});

it("does not spend the launch token on a wrong one", async () => {
  expect((await redeem("x".repeat(43))).status).toBe(401);
  expect((await redeem(TOKEN)).status).toBe(200);
});
