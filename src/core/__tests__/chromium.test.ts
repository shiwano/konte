import { PUPPETEER_REVISIONS } from "puppeteer-core/internal/revisions.js";
import { expect, it } from "vitest";
import { CHROMIUM_BUILD_ID } from "../chromium.js";

// The managed shell is launched by HyperFrames' own puppeteer over CDP, so konte does not get to
// pick this build — it must be the one puppeteer pins. A `@hyperframes/producer` bump can carry a
// new puppeteer without touching konte's constant, and the mismatch would surface as render
// weirdness rather than a setup error. Fail here instead, at the bump.
it("pins the chrome-headless-shell build that puppeteer pins", () => {
  expect(CHROMIUM_BUILD_ID).toBe(PUPPETEER_REVISIONS["chrome-headless-shell"]);
});
