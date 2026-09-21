import { describe, expect, it } from "vitest";
import { parseTunnelHostname } from "../tunnel.js";

// The banner cloudflared boxes the assigned URL in.
const BANNER = `2026-09-02T02:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...
2026-09-02T02:00:01Z INF +----------------------------------------------------------+
2026-09-02T02:00:01Z INF |  Your quick Tunnel has been created! Visit it at:         |
2026-09-02T02:00:01Z INF |  https://wide-fox-42.trycloudflare.com                    |
2026-09-02T02:00:01Z INF +----------------------------------------------------------+
2026-09-02T02:00:01Z INF Registered tunnel connection connIndex=0`;

describe("parseTunnelHostname", () => {
  it("reads the assigned host name out of the banner", () => {
    expect(parseTunnelHostname(BANNER)).toBe("wide-fox-42.trycloudflare.com");
  });

  it("says nothing while cloudflared is still connecting", () => {
    expect(
      parseTunnelHostname("2026-09-02T02:00:00Z INF Requesting new quick Tunnel..."),
    ).toBeNull();
  });

  it("is not fooled by the announcement line that only names the service", () => {
    expect(
      parseTunnelHostname("INF Requesting new quick Tunnel on trycloudflare.com..."),
    ).toBeNull();
  });

  it("lowercases what it found — the name goes on to be compared against a Host header", () => {
    expect(parseTunnelHostname("https://Wide-Fox-42.TryCloudflare.com")).toBe(
      "wide-fox-42.trycloudflare.com",
    );
  });

  it("takes the first host name, not a later line's", () => {
    expect(parseTunnelHostname(`${BANNER}\nhttps://other-name-9.trycloudflare.com`)).toBe(
      "wide-fox-42.trycloudflare.com",
    );
  });
});
