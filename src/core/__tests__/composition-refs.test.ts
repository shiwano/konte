import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveCompositionRef, substituteAssetPlaceholders } from "../composition-refs.js";
import { StateManager } from "../state/index.js";

let tmpDir: string;
let manager: StateManager;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "konte-refs-"));
  manager = await StateManager.init(tmpDir);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// `substituteAssetPlaceholders` hands the resolver whatever sits between `__konte:` and `__`, and a
// user's own text can shape that — a subtitle or an alt attribute may contain a placeholder-shaped
// literal that is not an asset path. `parseAssetPath` throws on those, so the resolver must absorb it
// rather than fail the whole render.
describe("resolveCompositionRef", () => {
  it("returns null for a placeholder-shaped literal that is not an asset path", () => {
    for (const bogus of ["video:seed", "reference:foo.bar", "animatic:", "video:shot.01"]) {
      expect(resolveCompositionRef(manager, bogus)).toBeNull();
    }
  });

  it("returns null for a well-formed path with nothing in state", () => {
    expect(resolveCompositionRef(manager, "video:shot.01.motion")).toBeNull();
  });

  it("honors an address override, auditioning an unaccepted variant over the accepted one", () => {
    const address = "reference:bgm";
    const accepted = manager.reserveVariantId(address);
    manager.getAssetState(address).variants![accepted]!.file = "assets/bgm/old.mp3";
    manager.setAccepted(address, accepted);
    const fresh = manager.reserveVariantId(address);
    manager.getAssetState(address).variants![fresh]!.file = "assets/bgm/new.mp3";

    // Without an override, a soundtrack ref resolves to the accepted (old) take.
    expect(resolveCompositionRef(manager, "reference:bgm")).toMatchObject({
      variantId: accepted,
      isAccepted: true,
    });

    // With the override, it resolves to the picked variant even though it is unaccepted.
    expect(
      resolveCompositionRef(manager, "reference:bgm", {
        overrideByAddress: new Map([[address, fresh]]),
      }),
    ).toMatchObject({ variantId: fresh, isAccepted: false });
  });

  it("ignores an override pointing at a missing or fileless variant, keeping normal resolution", () => {
    const address = "reference:bgm";
    const accepted = manager.reserveVariantId(address);
    manager.getAssetState(address).variants![accepted]!.file = "assets/bgm/old.mp3";
    manager.setAccepted(address, accepted);

    expect(
      resolveCompositionRef(manager, "reference:bgm", {
        overrideByAddress: new Map([[address, "v-does-not-exist"]]),
      }),
    ).toMatchObject({ variantId: accepted, isAccepted: true });
  });
});

describe("substituteAssetPlaceholders", () => {
  it("leaves a placeholder the resolver cannot map, and never throws on one", () => {
    const html = `<img src="__konte:video:seed__" alt="__konte:reference:foo.bar__">`;
    expect(() =>
      substituteAssetPlaceholders(html, (p) => resolveCompositionRef(manager, p)?.file ?? null),
    ).not.toThrow();
    expect(substituteAssetPlaceholders(html, () => null)).toBe(html);
  });

  it("ignores the render-time seed token, which is not an asset reference", () => {
    const html = `<div data-seed="__konte:seed__"></div>`;
    expect(substituteAssetPlaceholders(html, () => "SHOULD-NOT-APPLY")).toBe(html);
  });

  // A reserved-name address (`animatic.shot("02").stem` in a build's <Audio>) reaches the HTML as a
  // placeholder like any other cross-stage ref. Its `#` must be part of the matched alphabet, or the
  // src stays a literal `__konte:…__` and the take is silent wherever the HTML plays.
  it("substitutes a reserved-name address", () => {
    const html = `<audio src="__konte:animatic:shot.02#stem__"></audio>`;
    expect(substituteAssetPlaceholders(html, (p) => `URL(${p})`)).toBe(
      `<audio src="URL(animatic:shot.02#stem)"></audio>`,
    );
  });

  it("leaves a #delivery address in place — an export artifact, never a composition ref", () => {
    const html = `<video src="__konte:video:shot.02.motion#delivery__"></video>`;
    expect(
      substituteAssetPlaceholders(html, (p) => resolveCompositionRef(manager, p)?.file ?? null),
    ).toBe(html);
  });
});
