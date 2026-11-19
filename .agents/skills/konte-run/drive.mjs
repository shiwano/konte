#!/usr/bin/env bun
// Self-contained headless-Chrome driver for the konte preview UI (a React SPA).
// Launches its own Chrome with the DevTools protocol, navigates, optionally clicks through
// a sequence of elements, optionally evaluates a probe expression, and writes a screenshot.
// Use it to SEE and DRIVE the review UI from a headless container.
//
// Usage:
//   bun .agents/skills/konte-run/drive.mjs --url http://127.0.0.1:4651 --out /tmp/shot.png
//   bun .../drive.mjs --url ... --out /tmp/after.png --click "View accepted" --probe \
//     "document.querySelector('.vp-new-take-banner') ? 'banner' : 'gone'"
//   bun .../drive.mjs --url ... --out /tmp/note.png \
//     --click "@.dir-rail button||@.dir-peek--open .comment-add-btn" --probe "!!document.querySelector('textarea')"
//
// Flags: --url (required) --out (required) --wait <ms before the clicks, default 8000>
//        --click "<step>[||<step>…]" (1000ms after each, 4000ms after the last)
//        --probe "<js expression>"
// A step is a <button>'s visible text, or `@<css selector>`. Each click is real mouse input
// (CDP Input.dispatchMouseEvent): under el.click() React does not re-render before a document
// listener runs, so an outside-click handler sees a DOM no real click leaves.
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
    const steps = String(args.click).split("||");
    for (const [i, step] of steps.entries()) {
      const res = await send("Runtime.evaluate", {
        returnByValue: true,
        expression: `(() => {
          const step = ${JSON.stringify(step)};
          const el = step.startsWith("@")
            ? document.querySelector(step.slice(1))
            : [...document.querySelectorAll("button")]
                .find((b) => (b.textContent || "").toLowerCase().includes(step.toLowerCase()));
          if (!el) return null;
          el.scrollIntoView({ block: "center" });
          const r = el.getBoundingClientRect();
          return [r.x + r.width / 2, r.y + r.height / 2];
        })()`,
      });
      const point = res.result?.value;
      if (!point) {
        console.log(`click(${step}): NO_MATCH`);
        break;
      }
      const [x, y] = point;
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      for (const type of ["mousePressed", "mouseReleased"]) {
        await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
      }
      console.log(`click(${step}): CLICKED`);
      await sleep(i === steps.length - 1 ? 4000 : 1000);
    }
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
