#!/usr/bin/env bun
// Self-contained headless-Chrome driver for the konte preview UI (a React SPA).
// Launches its own Chrome with the DevTools protocol, navigates, optionally clicks a
// button by its visible text, optionally evaluates a probe expression, and writes a
// screenshot. Use it to SEE and DRIVE the review UI from a headless container.
//
// Usage:
//   bun .claude/skills/konte-run/drive.mjs --url http://127.0.0.1:4651 --out /tmp/shot.png
//   bun .../drive.mjs --url ... --out /tmp/after.png --click "View accepted" --probe \
//     "document.querySelector('.vp-new-take-banner') ? 'banner' : 'gone'"
//
// Flags: --url (required) --out (required) --wait <ms, default 8000 before action,
//        +4000 after a click> --click "<button text>" --probe "<js expression>"
import { spawn } from "node:child_process";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith("--")) acc.push([a.slice(2), arr[i + 1]]);
    return acc;
  }, []),
);
const url = args.url;
const out = args.out;
const waitMs = Number(args.wait ?? 8000);
if (!url || !out) {
  console.error("need --url and --out");
  process.exit(2);
}

const port = 9222 + (process.pid % 1000);
const chrome = spawn(
  "google-chrome",
  [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--hide-scrollbars",
    "--window-size=1400,900",
    `--remote-debugging-port=${port}`,
    "about:blank",
  ],
  { stdio: "ignore", env: { ...process.env, DISPLAY: "" } },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForCdp() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return;
    } catch {}
    await sleep(250);
  }
  throw new Error("Chrome CDP did not come up");
}

async function main() {
  await waitForCdp();
  const tab = await (
    await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: "PUT" })
  ).json();
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m.result);
      pending.delete(m.id);
    }
  });
  await new Promise((r) => ws.addEventListener("open", () => r()));
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const myId = ++id;
      pending.set(myId, resolve);
      ws.send(JSON.stringify({ id: myId, method, params }));
    });

  await send("Page.enable");
  await send("Runtime.enable");
  await send("Page.navigate", { url });
  await sleep(waitMs); // SPA fetches /api/state + renders + composition

  if (args.click) {
    const res = await send("Runtime.evaluate", {
      returnByValue: true,
      expression: `(() => {
        const b = [...document.querySelectorAll('button')]
          .find(el => (el.textContent||'').toLowerCase().includes(${JSON.stringify(String(args.click).toLowerCase())}));
        if (!b) return 'NO_BUTTON';
        b.click();
        return 'CLICKED';
      })()`,
    });
    console.log(`click(${args.click}): ${res.result?.value}`);
    await sleep(4000);
  }

  if (args.probe) {
    const res = await send("Runtime.evaluate", {
      returnByValue: true,
      expression: `(() => { try { return String(${args.probe}); } catch (e) { return 'ERR:'+e.message; } })()`,
    });
    console.log(`probe: ${res.result?.value}`);
  }

  const shot = await send("Page.captureScreenshot", { format: "png" });
  await Bun.write(out, Buffer.from(shot.data, "base64"));
  console.log(`screenshot: ${out}`);
  ws.close();
}

main()
  .then(() => {
    chrome.kill("SIGKILL");
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    chrome.kill("SIGKILL");
    process.exit(1);
  });
