import { describe, expect, it, vi } from "vitest";
import { createPinGate, PIN_SUBMIT_PATH } from "../auth.js";

const ORIGIN = "https://wide-fox-42.trycloudflare.com";

function get(path: string, headers: Record<string, string> = {}): [Request, URL] {
  const url = new URL(`${ORIGIN}${path}`);
  return [new Request(url, { headers }), url];
}

// The gate page's form declares no enctype, so this is the shape it posts.
function submit(pin: string, opts: { next?: string; cookie?: string; origin?: string } = {}) {
  const url = new URL(`${ORIGIN}${PIN_SUBMIT_PATH}`);
  const body = new URLSearchParams({ pin });
  if (opts.next !== undefined) body.set("next", opts.next);
  const headers: Record<string, string> = { origin: opts.origin ?? ORIGIN };
  if (opts.cookie) headers.cookie = opts.cookie;
  return [new Request(url, { method: "POST", body, headers }), url] as const;
}

const URLENCODED = { "content-type": "application/x-www-form-urlencoded" };

function post(url: URL, headers: Record<string, string>, body: BodyInit): Request {
  return new Request(url, { method: "POST", body, headers: { origin: ORIGIN, ...headers } });
}

// A body that arrives with no declared length, the way a chunked request does.
function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(text));
      c.close();
    },
  });
}

function brokenStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.error(new Error("connection dropped"));
    },
  });
}

function cookieOf(res: Response): string {
  const raw = res.headers.get("set-cookie") ?? "";
  return raw.split(";")[0] ?? "";
}

describe("createPinGate", () => {
  it("lets loopback through untouched — the CLI opens the browser there, and so does the agent", async () => {
    const gate = createPinGate();
    expect(await gate.guard(...get("/"), "loopback")).toBeNull();
    expect(await gate.guard(...get("/api/state"), "loopback")).toBeNull();
  });

  it("gates the LAN as well as the tunnel: the same exposure by a shorter road", async () => {
    const gate = createPinGate();
    expect(await gate.guard(...get("/"), "network")).not.toBeNull();
    expect(await gate.guard(...get("/"), "host")).not.toBeNull();
  });

  it("answers a page request with the gate, and a fetch with a status its JS can branch on", async () => {
    const gate = createPinGate();
    const pageRes = (await gate.guard(...get("/"), "host")) as Response;
    expect(pageRes.status).toBe(200);
    expect(pageRes.headers.get("content-type")).toContain("text/html");

    for (const path of ["/api/state", "/ws"]) {
      const res = (await gate.guard(...get(path), "host")) as Response;
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ code: "PIN_REQUIRED" });
    }
  });

  it("admits the right PIN and then the cookie it handed back", async () => {
    const gate = createPinGate();
    const res = (await gate.guard(...submit(gate.pin), "host")) as Response;
    expect(res.status).toBe(303);

    const cookie = cookieOf(res);
    expect(cookie).not.toBe("");
    expect(await gate.guard(...get("/api/state", { cookie }), "host")).toBeNull();
    expect(await gate.guard(...get("/ws", { cookie }), "host")).toBeNull();
  });

  it("refuses a wrong PIN and says how many tries are left", async () => {
    const gate = createPinGate();
    const wrong = gate.pin === "0000" ? "1111" : "0000";
    const res = (await gate.guard(...submit(wrong), "host")) as Response;
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("4 attempts left");
  });

  it("closes the route after five wrong PINs, and says so to whoever owns the tunnel", async () => {
    const onLockout = vi.fn();
    const gate = createPinGate({ onLockout });
    const wrong = gate.pin === "0000" ? "1111" : "0000";
    for (let i = 0; i < 4; i++) await gate.guard(...submit(wrong), "host");
    expect(onLockout).not.toHaveBeenCalled();

    const res = (await gate.guard(...submit(wrong), "host")) as Response;
    expect(res.status).toBe(403);
    expect(onLockout).toHaveBeenCalledOnce();

    // Locked means locked: the right PIN no longer opens it either.
    expect(((await gate.guard(...submit(gate.pin), "host")) as Response).status).toBe(403);
  });

  it("warns four times and then shuts the route once, however the guesses arrive", async () => {
    const onLockout = vi.fn();
    const gate = createPinGate({ onLockout });
    const wrong = gate.pin === "0000" ? "1111" : "0000";

    const responses = (await Promise.all(
      Array.from({ length: 50 }, () => gate.guard(...submit(wrong), "host")),
    )) as Response[];

    expect(responses.filter((r) => r.status === 401)).toHaveLength(4);
    expect(responses.filter((r) => r.status === 403)).toHaveLength(46);
    expect(onLockout).toHaveBeenCalledOnce();
  });

  // The cap counts comparisons, and `guard` tests `locked` before awaiting the request body: a
  // batch fired at once is all past that test before any of it resumes. This is what says the
  // second check inside the submit handler is doing its job.
  it("does not admit a right PIN riding in a batch that crosses the cap", async () => {
    const gate = createPinGate();
    const wrong = gate.pin === "0000" ? "1111" : "0000";

    const responses = (await Promise.all([
      ...Array.from({ length: 10 }, () => gate.guard(...submit(wrong), "host")),
      gate.guard(...submit(gate.pin), "host"),
    ])) as Response[];

    expect(responses.some((r) => r.headers.has("set-cookie"))).toBe(false);
  });

  it("ends the session once guesses keep coming after the route closed", async () => {
    const onAttack = vi.fn();
    const gate = createPinGate({ onAttack });
    const wrong = gate.pin === "0000" ? "1111" : "0000";

    for (let i = 0; i < 49; i++) await gate.guard(...submit(wrong), "host");
    expect(onAttack).not.toHaveBeenCalled();

    await gate.guard(...submit(wrong), "host");
    expect(onAttack).toHaveBeenCalledOnce();

    // Once, not once per knock thereafter.
    await gate.guard(...submit(wrong), "host");
    expect(onAttack).toHaveBeenCalledOnce();
  });

  it("does not hand back budget for a right PIN: the cap is the session's, not a streak's", async () => {
    const onLockout = vi.fn();
    const gate = createPinGate({ onLockout });
    const wrong = gate.pin === "0000" ? "1111" : "0000";

    for (let i = 0; i < 4; i++) await gate.guard(...submit(wrong), "host");
    await gate.guard(...submit(gate.pin), "host");
    expect(onLockout).not.toHaveBeenCalled();

    await gate.guard(...submit(wrong), "host");
    expect(onLockout).toHaveBeenCalledOnce();
  });

  it("counts a submission it turned away, by every road that turns one away", async () => {
    const url = new URL(`${ORIGIN}${PIN_SUBMIT_PATH}`);
    // One of each refusal: wrong shape, over the cap, and a body that cannot be read at all.
    const roads = [
      () => post(url, { "content-type": "multipart/form-data; boundary=x" }, "pin=0000"),
      () => post(url, URLENCODED, "x".repeat(5000)),
      () => post(url, URLENCODED, brokenStream()),
    ];

    for (const road of roads) {
      const onLockout = vi.fn();
      const gate = createPinGate({ onLockout });
      for (let i = 0; i < 4; i++) await gate.guard(road(), url, "host");
      expect(onLockout).not.toHaveBeenCalled();
      await gate.guard(road(), url, "host");
      expect(onLockout).toHaveBeenCalledOnce();
    }
  });

  it("caps the body on bytes taken, not on the length the sender claims", async () => {
    const url = new URL(`${ORIGIN}${PIN_SUBMIT_PATH}`);
    const gate = createPinGate();

    // A chunked body declares no length, so a cap that read the header would pass this straight
    // through to the parser.
    const chunked = post(url, URLENCODED, streamOf("x".repeat(5000)));
    expect(chunked.headers.get("content-length")).toBeNull();
    expect(((await gate.guard(chunked, url, "host")) as Response).status).toBe(413);

    // A body under the cap is still read, so the cap is not simply refusing everything.
    const fits = post(url, URLENCODED, `next=/&pin=${gate.pin}&pad=${"x".repeat(3000)}`);
    expect(((await gate.guard(fits, url, "host")) as Response).status).toBe(303);
  });

  it("declines a shape this form never posts, before reading it", async () => {
    const url = new URL(`${ORIGIN}${PIN_SUBMIT_PATH}`);
    const wrongType = post(url, { "content-type": "multipart/form-data; boundary=x" }, "pin=0000");

    const gate = createPinGate();
    expect(((await gate.guard(wrongType, url, "host")) as Response).status).toBe(415);
    expect(wrongType.bodyUsed).toBe(false);
  });

  it("counts only guesses toward that, not a locked-out reader reloading the page", async () => {
    const onAttack = vi.fn();
    const gate = createPinGate({ onAttack });
    const wrong = gate.pin === "0000" ? "1111" : "0000";
    for (let i = 0; i < 5; i++) await gate.guard(...submit(wrong), "host");

    for (let i = 0; i < 100; i++) await gate.guard(...get("/"), "host");
    expect(onAttack).not.toHaveBeenCalled();
  });

  it("marks the cookie Secure on https and not on plain http, which would discard it", async () => {
    const https = createPinGate();
    const httpsRes = (await https.guard(...submit(https.pin), "host")) as Response;
    expect(httpsRes.headers.get("set-cookie")).toContain("Secure");

    const http = createPinGate();
    const httpRes = (await http.guard(
      ...submit(http.pin, { origin: "http://192.168.1.5:4649" }),
      "network",
    )) as Response;
    expect(httpRes.headers.get("set-cookie")).not.toContain("Secure");
  });

  it("always sets HttpOnly and SameSite=Lax — Strict drops the cookie on a link from a chat app", async () => {
    const gate = createPinGate();
    const res = (await gate.guard(...submit(gate.pin), "host")) as Response;
    const raw = res.headers.get("set-cookie") ?? "";
    expect(raw).toContain("HttpOnly");
    expect(raw).toContain("SameSite=Lax");
  });

  it("returns to where the reader was headed", async () => {
    const gate = createPinGate();
    const res = (await gate.guard(...submit(gate.pin, { next: "/?shot=01" }), "host")) as Response;
    expect(res.headers.get("location")).toBe("/?shot=01");
  });

  it("refuses to bounce off-site: a protocol-relative next is not a path", async () => {
    // `/\evil.example` is the one that reads as a path and is not: a URL parser takes the
    // backslash for a slash, and the browser leaves for evil.example.
    for (const next of ["//evil.example", "/\\evil.example", "https://evil.example", "evil"]) {
      const gate = createPinGate();
      const res = (await gate.guard(...submit(gate.pin, { next }), "host")) as Response;
      expect(res.headers.get("location")).toBe("/");
    }
  });

  // What a generic HTML linter would not check: that the markup and the handler still agree. A
  // placeholder renamed on one side leaves `{{...}}` on screen, and a slot dropped from the page
  // leaves the handler filling nothing.
  it("leaves no placeholder unfilled, on either page and in either state", async () => {
    const gate = createPinGate();
    const wrong = gate.pin === "0000" ? "1111" : "0000";
    const bodies = [
      await ((await gate.guard(...get("/"), "host")) as Response).text(),
      await ((await gate.guard(...submit(wrong), "host")) as Response).text(),
    ];
    for (let i = 0; i < 4; i++) await gate.guard(...submit(wrong), "host");
    bodies.push(await ((await gate.guard(...get("/"), "host")) as Response).text());

    for (const body of bodies) expect(body).not.toMatch(/\{\{\w+\}\}/);
  });

  it("renders a form the handler's own route and field names can read", async () => {
    const gate = createPinGate();
    const res = (await gate.guard(...get("/?shot=01"), "host")) as Response;

    const form: Record<string, string> = {};
    const inputs: Record<string, string> = {};
    let labelFor = "";
    await new HTMLRewriter()
      .on("form", {
        element(el) {
          form.method = el.getAttribute("method") ?? "";
          form.action = el.getAttribute("action") ?? "";
        },
      })
      .on("input", {
        element(el) {
          inputs[el.getAttribute("name") ?? ""] = el.getAttribute("value") ?? "";
        },
      })
      .on("label", {
        element(el) {
          labelFor = el.getAttribute("for") ?? "";
        },
      })
      .transform(new Response(await res.text()))
      .text();

    expect(form).toEqual({ method: "post", action: PIN_SUBMIT_PATH });
    expect(Object.keys(inputs).sort()).toEqual(["next", "pin"]);
    expect(inputs.next).toBe("/?shot=01");
    // An unlabelled box asks a screen reader's user for four digits it cannot name.
    expect(labelFor).toBe("pin");
  });

  // `next` comes back through the form, where nothing normalizes it — unlike the GET path, which
  // the URL parser has already percent-encoded. safeNext only asks that it be a local path, and
  // `/"><script>` is one.
  it("escapes `next` before putting it back in an attribute", async () => {
    const gate = createPinGate();
    const wrong = gate.pin === "0000" ? "1111" : "0000";
    const hostile = '/"><script>alert(1)</script>';
    const res = (await gate.guard(...submit(wrong, { next: hostile }), "host")) as Response;
    const body = await res.text();

    expect(body).not.toContain("<script>");
    expect(body).toContain("&quot;&gt;&lt;script&gt;");
  });

  it("issues a four-digit PIN, fresh per session", () => {
    const pins = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const { pin } = createPinGate();
      expect(pin).toMatch(/^\d{4}$/);
      pins.add(pin);
    }
    // 50 draws from 10,000 collide vanishingly rarely; a constant PIN would collapse to one.
    expect(pins.size).toBeGreaterThan(40);
  });
});
