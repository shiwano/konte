import { describe, expect, it } from "vitest";
import {
  type AccessPolicy,
  checkRequestOrigin as admitRequest,
  describeExposure,
  listenWithPortFallback,
} from "../http.js";

const PORT = 4649;

function req(method: string, headers: Record<string, string>) {
  return { method, headers: new Headers(headers) };
}

// The refusal alone, which is what most of these assert on. The route an admitted request came in
// by has its own describe below.
function checkRequestOrigin(...args: Parameters<typeof admitRequest>): Response | null {
  const result = admitRequest(...args);
  return result.ok ? null : result.response;
}

describe("checkRequestOrigin", () => {
  it("allows a same-origin POST from the served page", () => {
    expect(
      checkRequestOrigin(
        req("POST", { host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}` }),
        PORT,
      ),
    ).toBeNull();
  });

  it("allows a localhost origin (the same server under its other loopback name)", () => {
    expect(
      checkRequestOrigin(
        req("POST", { host: `localhost:${PORT}`, origin: `http://localhost:${PORT}` }),
        PORT,
      ),
    ).toBeNull();
  });

  it("allows a GET with no Origin (browsers omit it on same-origin GETs)", () => {
    expect(checkRequestOrigin(req("GET", { host: `127.0.0.1:${PORT}` }), PORT)).toBeNull();
  });

  it("rejects a cross-origin POST (CSRF: accept/submit/shutdown from any open page)", async () => {
    const res = checkRequestOrigin(
      req("POST", { host: `127.0.0.1:${PORT}`, origin: "https://evil.example" }),
      PORT,
    );
    expect(res?.status).toBe(403);
    expect(await res?.json()).toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects a POST with no Origin at all", () => {
    expect(checkRequestOrigin(req("POST", { host: `127.0.0.1:${PORT}` }), PORT)?.status).toBe(403);
  });

  it("rejects a rebound DNS name resolving to loopback", () => {
    expect(
      checkRequestOrigin(
        req("GET", { host: "attacker.example:4649", origin: "http://attacker.example:4649" }),
        PORT,
      )?.status,
    ).toBe(403);
  });

  it("allows the bare loopback host on :80, where browsers omit the default port", () => {
    expect(
      checkRequestOrigin(req("POST", { host: "127.0.0.1", origin: "http://127.0.0.1" }), 80),
    ).toBeNull();
    expect(
      checkRequestOrigin(req("POST", { host: "127.0.0.1:80", origin: "http://127.0.0.1:80" }), 80),
    ).toBeNull();
  });

  it("rejects an origin on a different port", () => {
    expect(
      checkRequestOrigin(
        req("POST", { host: `127.0.0.1:${PORT}`, origin: "http://127.0.0.1:9999" }),
        PORT,
      )?.status,
    ).toBe(403);
  });
});

const LAN: AccessPolicy = { host: "0.0.0.0", allowedHosts: [] };
const TUNNEL: AccessPolicy = { host: "127.0.0.1", allowedHosts: ["*.trycloudflare.com"] };

describe("checkRequestOrigin — a LAN bind", () => {
  it("admits a private address it listens on", () => {
    expect(
      checkRequestOrigin(
        req("POST", { host: `192.168.1.5:${PORT}`, origin: `http://192.168.1.5:${PORT}` }),
        PORT,
        LAN,
      ),
    ).toBeNull();
  });

  it("still admits loopback", () => {
    expect(
      checkRequestOrigin(
        req("POST", { host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}` }),
        PORT,
        LAN,
      ),
    ).toBeNull();
  });

  it("rejects a routable address (a LAN bind is not a public one)", () => {
    expect(
      checkRequestOrigin(
        req("GET", { host: `93.184.216.34:${PORT}`, origin: `http://93.184.216.34:${PORT}` }),
        PORT,
        LAN,
      )?.status,
    ).toBe(403);
  });

  it("rejects an Origin that is a different private address than the Host", () => {
    expect(
      checkRequestOrigin(
        req("POST", { host: `192.168.1.5:${PORT}`, origin: `http://192.168.1.99:${PORT}` }),
        PORT,
        LAN,
      )?.status,
    ).toBe(403);
  });

  it("admits an IPv4-mapped address, which is how a `::` bind sees a v4 client", () => {
    const dual: AccessPolicy = { host: "::", allowedHosts: [] };
    expect(
      checkRequestOrigin(
        req("POST", {
          host: `[::ffff:192.168.1.5]:${PORT}`,
          origin: `http://[::ffff:192.168.1.5]:${PORT}`,
        }),
        PORT,
        dual,
      ),
    ).toBeNull();
    expect(
      checkRequestOrigin(req("GET", { host: `[::ffff:c0a8:105]:${PORT}` }), PORT, dual),
    ).toBeNull();
  });

  it("rejects a private address when nothing widened the default policy", () => {
    expect(
      checkRequestOrigin(
        req("GET", { host: `192.168.1.5:${PORT}`, origin: `http://192.168.1.5:${PORT}` }),
        PORT,
      )?.status,
    ).toBe(403);
  });
});

describe("checkRequestOrigin — a tunnel host", () => {
  it("admits the fronted name on 443, where the proxy sends no port and an https Origin", () => {
    expect(
      checkRequestOrigin(
        req("POST", {
          host: "wide-fox-42.trycloudflare.com",
          origin: "https://wide-fox-42.trycloudflare.com",
        }),
        PORT,
        TUNNEL,
      ),
    ).toBeNull();
  });

  it("admits loopback alongside it, so cloudflared's own hop still works", () => {
    expect(
      checkRequestOrigin(
        req("POST", { host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}` }),
        PORT,
        TUNNEL,
      ),
    ).toBeNull();
  });

  it("matches one label, not a deeper subdomain", () => {
    expect(
      checkRequestOrigin(req("GET", { host: "a.b.trycloudflare.com" }), PORT, TUNNEL)?.status,
    ).toBe(403);
  });

  it("rejects a name outside the pattern", () => {
    expect(checkRequestOrigin(req("GET", { host: "evil.example" }), PORT, TUNNEL)?.status).toBe(
      403,
    );
  });

  it("rejects a sibling tunnel name as the Origin", () => {
    expect(
      checkRequestOrigin(
        req("POST", {
          host: "wide-fox-42.trycloudflare.com",
          origin: "https://evil-badger-99.trycloudflare.com",
        }),
        PORT,
        TUNNEL,
      )?.status,
    ).toBe(403);
  });

  it("rejects an Origin naming the admitted host on another port", () => {
    expect(
      checkRequestOrigin(
        req("POST", {
          host: "wide-fox-42.trycloudflare.com",
          origin: "https://wide-fox-42.trycloudflare.com:8443",
        }),
        PORT,
        TUNNEL,
      )?.status,
    ).toBe(403);
  });

  it("rejects a cross-origin POST arriving under the admitted host", () => {
    expect(
      checkRequestOrigin(
        req("POST", { host: "wide-fox-42.trycloudflare.com", origin: "https://evil.example" }),
        PORT,
        TUNNEL,
      )?.status,
    ).toBe(403);
  });

  it("admits any name under the bare * escape hatch", () => {
    const open: AccessPolicy = { host: "127.0.0.1", allowedHosts: ["*"] };
    expect(
      checkRequestOrigin(
        req("POST", { host: "anything.example", origin: "https://anything.example" }),
        PORT,
        open,
      ),
    ).toBeNull();
  });
});

describe("checkRequestOrigin — a Host is admitted as the name it canonicalizes to", () => {
  it("rejects an octal spelling of a public address", () => {
    expect(
      checkRequestOrigin(
        req("POST", { host: `010.8.8.8:${PORT}`, origin: `http://8.8.8.8:${PORT}` }),
        PORT,
        LAN,
      )?.status,
    ).toBe(403);
  });

  it("admits a fully expanded IPv4-mapped address, which is the same address", () => {
    expect(
      checkRequestOrigin(
        req("POST", {
          host: `[0:0:0:0:0:ffff:c0a8:105]:${PORT}`,
          origin: `http://[::ffff:c0a8:105]:${PORT}`,
        }),
        PORT,
        { host: "::", allowedHosts: [] },
      ),
    ).toBeNull();
  });

  it("rejects a bracketed authority carrying trailing junk", () => {
    for (const host of ["[::1]junk", "[::1]junk:80"]) {
      expect(checkRequestOrigin(req("POST", { host, origin: "http://[::1]" }), 80)?.status).toBe(
        403,
      );
    }
  });

  it("rejects a Host that is not a bare authority", () => {
    for (const host of ["user@127.0.0.1:4649", "127.0.0.1:4649/evil", "127.0.0.1:notaport", ""]) {
      expect(checkRequestOrigin(req("GET", { host }), PORT)?.status).toBe(403);
    }
  });
});

describe("checkRequestOrigin — the route an admitted request came in by", () => {
  const LAN: AccessPolicy = { host: "0.0.0.0", allowedHosts: [] };

  it("calls the machine's own names loopback, which is what the PIN gate lets past", () => {
    for (const name of ["127.0.0.1", "localhost", "[::1]"]) {
      expect(
        admitRequest(req("GET", { host: `${name}:${PORT}` }), PORT, undefined, "127.0.0.1"),
      ).toEqual({ ok: true, via: "loopback" });
    }
  });

  it("reads a peer through the forms a `::` bind reports it in", () => {
    for (const peer of ["127.0.0.1", "127.0.0.53", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1"]) {
      expect(
        admitRequest(req("GET", { host: `127.0.0.1:${PORT}` }), PORT, undefined, peer),
      ).toEqual({ ok: true, via: "loopback" });
    }
  });

  it("calls a private address network — a LAN bind is reachable by everyone on the wifi", () => {
    expect(
      admitRequest(req("GET", { host: `192.168.1.5:${PORT}` }), PORT, LAN, "192.168.1.9"),
    ).toEqual({ ok: true, via: "network" });
  });

  it("calls an allowedHosts name host, whatever address it binds", () => {
    expect(
      admitRequest(req("GET", { host: "wide-fox-42.trycloudflare.com" }), PORT, TUNNEL),
    ).toEqual({ ok: true, via: "host" });
  });

  it("prefers the named route over loopback, so a proxy fronting 127.0.0.1 is still gated", () => {
    expect(
      admitRequest(req("GET", { host: `127.0.0.1:${PORT}` }), PORT, {
        host: "127.0.0.1",
        allowedHosts: ["127.0.0.1"],
      }),
    ).toEqual({ ok: true, via: "host" });
  });

  it("does not take a LAN client's word that it is loopback: `Host` is written by the caller", () => {
    expect(
      admitRequest(req("GET", { host: `127.0.0.1:${PORT}` }), PORT, LAN, "192.168.1.9"),
    ).toEqual({ ok: true, via: "network" });
  });

  it("does not wave a tunnel through on its peer: cloudflared connects from loopback", () => {
    expect(
      admitRequest(
        req("GET", { host: "wide-fox-42.trycloudflare.com" }),
        PORT,
        TUNNEL,
        "127.0.0.1",
      ),
    ).toEqual({ ok: true, via: "host" });
  });

  it("takes a forwarding header as the client not being here, whatever the peer says", () => {
    // A local proxy connects from loopback and can rewrite the name to a loopback one, so both
    // signals go local at once. These headers are the third.
    for (const header of [
      "forwarded",
      "x-forwarded-for",
      "x-forwarded-host",
      "x-forwarded-proto",
      "x-real-ip",
    ]) {
      expect(
        admitRequest(
          req("GET", { host: `127.0.0.1:${PORT}`, [header]: "203.0.113.7" }),
          PORT,
          undefined,
          "127.0.0.1",
        ),
      ).toEqual({ ok: true, via: "network" });
    }
  });

  it("treats a peer it cannot read as off the machine", () => {
    expect(admitRequest(req("GET", { host: `127.0.0.1:${PORT}` }), PORT, undefined, null)).toEqual({
      ok: true,
      via: "network",
    });
  });
});

describe("describeExposure", () => {
  it("says nothing about a loopback-only policy", () => {
    expect(describeExposure({ host: "127.0.0.1", allowedHosts: [] }, PORT)).toBeNull();
  });

  it("tells the reader which URL to pass on, not just that the bind widened", () => {
    const text = describeExposure({ host: "192.168.1.5", allowedHosts: [] }, PORT) ?? "";
    expect(text).toContain(`http://192.168.1.5:${PORT}`);
    expect(text).toContain("Give the human this URL");
  });

  it("names no URL for a bind whose address the policy would refuse anyway", () => {
    const text = describeExposure({ host: "93.184.216.34", allowedHosts: [] }, PORT) ?? "";
    expect(text).not.toContain("93.184.216.34:");
    expect(text).toContain("no private address");
  });

  it("sends a tunnel's reader to the fronted URL, and says there is no auth", () => {
    const text = describeExposure(TUNNEL, PORT) ?? "";
    expect(text).toContain("*.trycloudflare.com");
    expect(text).toContain("Give the human the URL your tunnel or proxy fronts");
    expect(text).toContain("no authentication");
  });

  it("prints the PIN in place of the no-auth warning once a gate stands in front", () => {
    const text = describeExposure(TUNNEL, PORT, { pin: "0427" }) ?? "";
    expect(text).toContain("PIN 0427");
    expect(text).not.toContain("no authentication");
  });

  it("names a tunnel by the URL that reaches it, not by the host name in the policy", () => {
    const url = "https://wide-fox-42.trycloudflare.com";
    const policy: AccessPolicy = {
      host: "127.0.0.1",
      allowedHosts: ["wide-fox-42.trycloudflare.com"],
    };
    const text = describeExposure(policy, PORT, { pin: "0427", tunnelUrl: url }) ?? "";
    expect(text).toContain(url);
    expect(text).not.toContain("Accepting requests under");
  });

  it("still lists a proxy's own name alongside the tunnel", () => {
    const policy: AccessPolicy = {
      host: "127.0.0.1",
      allowedHosts: ["review.example.com", "wide-fox-42.trycloudflare.com"],
    };
    const text =
      describeExposure(policy, PORT, {
        pin: "0427",
        tunnelUrl: "https://wide-fox-42.trycloudflare.com",
      }) ?? "";
    expect(text).toContain("review.example.com");
  });

  it("calls out the bare * rather than listing it", () => {
    expect(describeExposure({ host: "127.0.0.1", allowedHosts: ["*"] }, PORT)).toContain(
      "ANY host",
    );
  });
});

describe("listenWithPortFallback", () => {
  const inUse = () => Object.assign(new Error("Failed to start server"), { code: "EADDRINUSE" });

  it("returns the server on the requested port when it is free", () => {
    const ports: number[] = [];
    const server = listenWithPortFallback(
      (p) => {
        ports.push(p);
        return `server:${p}`;
      },
      4649,
      true,
    );
    expect(server).toBe("server:4649");
    expect(ports).toEqual([4649]);
  });

  it("retries on an ephemeral port when the default is taken", () => {
    const ports: number[] = [];
    const server = listenWithPortFallback(
      (p) => {
        ports.push(p);
        if (p !== 0) throw inUse();
        return `server:${p}`;
      },
      4649,
      true,
    );
    expect(server).toBe("server:0");
    expect(ports).toEqual([4649, 0]);
  });

  it("fails with PORT_IN_USE for an explicitly requested port", () => {
    expect(() =>
      listenWithPortFallback(
        () => {
          throw inUse();
        },
        5000,
        false,
      ),
    ).toThrow(expect.objectContaining({ code: "PORT_IN_USE" }));
  });

  it("rethrows a non-EADDRINUSE failure", () => {
    expect(() =>
      listenWithPortFallback(
        () => {
          throw new Error("boom");
        },
        4649,
        true,
      ),
    ).toThrow("boom");
  });
});
