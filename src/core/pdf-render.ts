/// <reference path="../md.d.ts" />
// PDF pages drawn by pdf.js inside the managed Chromium, for what konte's own PDF reader cannot take
// off a page as its one image: text or vectors drawn over it, an image codec it does not decode, an
// encrypted file. One browser serves every render of a process and closes once idle.

import pdfjs from "pdfjs-dist/build/pdf.min.mjs" with { type: "text" };
import pdfjsWorker from "pdfjs-dist/build/pdf.worker.min.mjs" with { type: "text" };
import type { Browser, HTTPRequest, Page } from "puppeteer-core";
import { ensureChromium } from "./chromium.js";
import { PDFJS_CMAPS } from "./generated/pdfjs-cmaps.js";
import { KonteError, errorMessage } from "./errors.js";

const ORIGIN = "http://konte-pdf.invalid";
// The long side a drawn page is rendered at, in pixels.
const LONG_SIDE = 2400;
const JPEG_QUALITY = 0.92;
const IDLE_CLOSE_MS = 1000;

// The worker runs on the page's own thread: pdf.js takes `globalThis.pdfjsWorker` over a Worker.
const INDEX_HTML = `<!doctype html><meta charset="utf-8"><script type="module">
import * as worker from "/pdf.worker.mjs";
globalThis.pdfjsWorker = worker;
const lib = await import("/pdf.mjs");
const docs = new Map();
const open = (id) => {
  if (!docs.has(id)) {
    docs.set(id, lib.getDocument({ url: "/doc/" + id, disableRange: true, disableStream: true, useSystemFonts: true, cMapUrl: "/cmaps/", cMapPacked: true }).promise);
  }
  return docs.get(id);
};
globalThis.konteInfo = async (id) => {
  const doc = await open(id);
  const prefs = (await doc.getViewerPreferences()) ?? {};
  return { pages: doc.numPages, direction: prefs.Direction ?? null };
};
globalThis.konteRender = async (id, n, longSide, quality) => {
  const page = await (await open(id)).getPage(n);
  const base = page.getViewport({ scale: 1 });
  const viewport = page.getViewport({ scale: longSide / Math.max(base.width, base.height) });
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  page.cleanup();
  return canvas.toDataURL("image/jpeg", quality).split(",")[1];
};
globalThis.konteReady = true;
</script>`;

type Session = { browser: Browser; page: Page; docs: Map<number, Buffer> };

let session: Promise<Session> | null = null;
let queue: Promise<unknown> = Promise.resolve();
let idle: ReturnType<typeof setTimeout> | null = null;
const docIds = new WeakMap<Buffer, number>();
let nextDocId = 1;

async function open(): Promise<Session> {
  const { launch } = await import("puppeteer-core");
  const browser = await launch({
    executablePath: await ensureChromium(),
    headless: true,
    args: ["--no-sandbox", "--disable-gpu"],
  });
  try {
    const page = await browser.newPage();
    const docs = new Map<number, Buffer>();
    await page.setRequestInterception(true);
    page.on("request", (req: HTTPRequest) => {
      const url = new URL(req.url());
      const js = (body: string) =>
        req.respond({ status: 200, contentType: "text/javascript", body });
      if (url.origin !== ORIGIN) return void req.abort();
      if (url.pathname === "/") {
        return void req.respond({ status: 200, contentType: "text/html", body: INDEX_HTML });
      }
      if (url.pathname === "/pdf.mjs") return void js(pdfjs);
      if (url.pathname === "/pdf.worker.mjs") return void js(pdfjsWorker);
      const cmap = url.pathname.startsWith("/cmaps/")
        ? PDFJS_CMAPS[url.pathname.slice("/cmaps/".length)]
        : undefined;
      if (cmap) {
        return void req.respond({
          status: 200,
          contentType: "application/octet-stream",
          body: Buffer.from(cmap, "base64"),
        });
      }
      const doc = docs.get(Number(url.pathname.replace("/doc/", "")));
      if (doc) {
        return void req.respond({ status: 200, contentType: "application/pdf", body: doc });
      }
      void req.respond({ status: 404, body: "" });
    });
    await page.goto(`${ORIGIN}/`);
    await page.waitForFunction("globalThis.konteReady === true");
    return { browser, page, docs };
  } catch (err) {
    await browser.close().catch(() => {});
    throw err;
  }
}

// One call at a time on the one page.
function withPage<T>(run: (s: Session) => Promise<T>): Promise<T> {
  const next = queue.then(async () => {
    if (idle) clearTimeout(idle);
    session ??= open();
    try {
      return await run(await session);
    } catch (err) {
      throw new KonteError(
        "SOURCE_UNREADABLE",
        `pdf.js could not read the PDF: ${errorMessage(err)}`,
      );
    } finally {
      idle = setTimeout(() => {
        const closing = session;
        session = null;
        void closing?.then((s) => s.browser.close()).catch(() => {});
      }, IDLE_CLOSE_MS);
    }
  });
  queue = next.catch(() => {});
  return next;
}

function docId(s: Session, data: Buffer): number {
  let id = docIds.get(data);
  if (id === undefined) {
    id = nextDocId++;
    docIds.set(data, id);
  }
  s.docs.set(id, data);
  return id;
}

/** How many pages pdf.js counts in `data`, and the direction its viewer preferences state. */
export function pdfInfo(data: Buffer): Promise<{ pages: number; direction: "rtl" | "ltr" | null }> {
  return withPage(async (s) => {
    const id = docId(s, data);
    const info = (await s.page.evaluate((i: number) => (globalThis as any).konteInfo(i), id)) as {
      pages: number;
      direction: string | null;
    };
    const direction = info.direction === "R2L" ? "rtl" : info.direction === "L2R" ? "ltr" : null;
    return { pages: info.pages, direction };
  });
}

/** Page `n` (1-based) of `data`, drawn as pdf.js draws it: JPEG bytes, its long side `LONG_SIDE`. */
export function renderPdfPage(data: Buffer, n: number): Promise<Buffer> {
  return withPage(async (s) => {
    const id = docId(s, data);
    const base64 = (await s.page.evaluate(
      (i: number, page: number, longSide: number, quality: number) =>
        (globalThis as any).konteRender(i, page, longSide, quality),
      id,
      n,
      LONG_SIDE,
      JPEG_QUALITY,
    )) as string;
    return Buffer.from(base64, "base64");
  });
}
