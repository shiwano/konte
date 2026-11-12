import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../chromium.js", () => ({ ensureChromium: vi.fn().mockResolvedValue("/chrome") }));

type Request = {
  url: () => string;
  respond: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
};

// A browser whose one page answers `evaluate` with what each test queues.
const browsers: { close: ReturnType<typeof vi.fn> }[] = [];
let onRequest: ((req: Request) => void) | null = null;
let evaluate: ReturnType<typeof vi.fn>;
// What each launch is started with, and what a sandboxed launch fails with.
const launches: string[][] = [];
let sandboxRefusal: string | null = null;

vi.mock("puppeteer-core", () => ({
  launch: vi.fn(async ({ args }: { args: string[] }) => {
    launches.push(args);
    if (sandboxRefusal && !args.includes("--no-sandbox")) {
      throw new Error(`Failed to launch the browser process!\n${sandboxRefusal}`);
    }
    const browser = {
      close: vi.fn(async () => {}),
      newPage: async () => ({
        setRequestInterception: async () => {},
        on: (_: string, handler: (req: Request) => void) => {
          onRequest = handler;
        },
        goto: async () => {},
        waitForFunction: async () => {},
        evaluate: (...args: unknown[]) => evaluate(...args),
      }),
    };
    browsers.push(browser);
    return browser;
  }),
}));

async function load() {
  vi.resetModules();
  return import("../pdf-render.js");
}

function request(url: string): Request {
  return { url: () => url, respond: vi.fn(), abort: vi.fn() };
}

beforeEach(() => {
  vi.useFakeTimers();
  browsers.length = 0;
  launches.length = 0;
  sandboxRefusal = null;
  onRequest = null;
  evaluate = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("renderPdfPage", () => {
  it("serves the page, pdf.js, its CMaps and the document, and refuses anything else", async () => {
    const { renderPdfPage } = await load();
    evaluate.mockResolvedValue(Buffer.from("jpeg").toString("base64"));
    const data = Buffer.from("%PDF-1.7");
    expect((await renderPdfPage(data, 1)).toString()).toBe("jpeg");

    const served = (url: string) => {
      const req = request(url);
      onRequest!(req);
      return req;
    };
    expect(served("http://konte-pdf.invalid/").respond.mock.calls[0]![0]).toMatchObject({
      contentType: "text/html",
    });
    expect(served("http://konte-pdf.invalid/pdf.mjs").respond.mock.calls[0]![0]).toMatchObject({
      contentType: "text/javascript",
    });
    expect(
      served("http://konte-pdf.invalid/cmaps/UniJIS-UCS2-H.bcmap").respond.mock.calls[0]![0],
    ).toMatchObject({ contentType: "application/octet-stream" });
    const id = evaluate.mock.calls[0]![1];
    expect(served(`http://konte-pdf.invalid/doc/${id}`).respond.mock.calls[0]![0]).toMatchObject({
      contentType: "application/pdf",
      body: data,
    });
    expect(served("http://konte-pdf.invalid/doc/999").respond.mock.calls[0]![0]).toMatchObject({
      status: 404,
    });
    expect(served("https://example.com/x").abort).toHaveBeenCalled();
  });

  it("draws one page at a time, the same document under one id", async () => {
    const { renderPdfPage } = await load();
    let release!: () => void;
    evaluate.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve("YQ=="))),
    );
    evaluate.mockResolvedValue("Yg==");
    const data = Buffer.from("%PDF-1.7");
    const first = renderPdfPage(data, 1);
    const second = renderPdfPage(data, 2);
    await vi.waitFor(() => expect(evaluate).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(evaluate).toHaveBeenCalledTimes(1);
    release();
    expect((await first).toString()).toBe("a");
    expect((await second).toString()).toBe("b");
    expect(evaluate.mock.calls.map((c) => [c[1], c[2]])).toEqual([
      [1, 1],
      [1, 2],
    ]);
  });

  it("closes the browser once idle and opens another for the next page", async () => {
    const { renderPdfPage } = await load();
    evaluate.mockResolvedValue("YQ==");
    await renderPdfPage(Buffer.from("%PDF"), 1);
    expect(browsers).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(browsers[0]!.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(browsers[0]!.close).toHaveBeenCalled();

    await renderPdfPage(Buffer.from("%PDF"), 1);
    expect(browsers).toHaveLength(2);
  });

  it("turns a pdf.js failure into SOURCE_UNREADABLE and keeps serving", async () => {
    const { renderPdfPage } = await load();
    evaluate.mockRejectedValueOnce(new Error("Invalid PDF structure"));
    evaluate.mockResolvedValue("YQ==");
    await expect(renderPdfPage(Buffer.from("x"), 1)).rejects.toMatchObject({
      code: "SOURCE_UNREADABLE",
    });
    expect((await renderPdfPage(Buffer.from("%PDF"), 1)).toString()).toBe("a");
  });
});

describe("sandbox", () => {
  it("starts Chromium sandboxed", async () => {
    const { renderPdfPage } = await load();
    evaluate.mockResolvedValue("YQ==");
    await renderPdfPage(Buffer.from("%PDF"), 1);
    expect(launches).toEqual([["--disable-gpu"]]);
  });

  it("falls back to --no-sandbox once Chromium refuses a sandbox, and stays there", async () => {
    const { renderPdfPage } = await load();
    sandboxRefusal = "[FATAL:zygote_host_impl_linux.cc] No usable sandbox!";
    evaluate.mockResolvedValue("YQ==");
    await renderPdfPage(Buffer.from("%PDF"), 1);
    await vi.advanceTimersByTimeAsync(1000);
    await renderPdfPage(Buffer.from("%PDF"), 1);
    expect(launches).toEqual([
      ["--disable-gpu"],
      ["--no-sandbox", "--disable-gpu"],
      ["--no-sandbox", "--disable-gpu"],
    ]);
  });

  it.each([
    "Running as root without --no-sandbox is not supported.",
    "Failed to move to new namespace: PID namespaces supported, Network namespace supported, but failed: errno = Operation not permitted",
  ])("falls back on %s", async (refusal) => {
    const { renderPdfPage } = await load();
    sandboxRefusal = refusal;
    evaluate.mockResolvedValue("YQ==");
    await renderPdfPage(Buffer.from("%PDF"), 1);
    expect(launches.at(-1)).toContain("--no-sandbox");
  });

  it("does not retry without a sandbox on any other launch failure", async () => {
    const { renderPdfPage } = await load();
    sandboxRefusal = "spawn /chrome ENOENT";
    await expect(renderPdfPage(Buffer.from("%PDF"), 1)).rejects.toMatchObject({
      code: "SOURCE_UNREADABLE",
    });
    expect(launches).toEqual([["--disable-gpu"]]);
  });
});

describe("pdfInfo", () => {
  it("reads the page count and the direction the viewer preferences state", async () => {
    const { pdfInfo } = await load();
    evaluate.mockResolvedValueOnce({ pages: 3, direction: "R2L" });
    evaluate.mockResolvedValueOnce({ pages: 1, direction: null });
    expect(await pdfInfo(Buffer.from("%PDF"))).toEqual({ pages: 3, direction: "rtl" });
    expect(await pdfInfo(Buffer.from("%PDF"))).toEqual({ pages: 1, direction: null });
  });
});
