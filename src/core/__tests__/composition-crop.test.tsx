import { describe, expect, it } from "vitest";
import { Composition } from "../dsl/composition/index.js";
import { renderToHtml } from "../jsx-html.js";

function shell(
  size: { width: number; height: number },
  crop?: { width: number; height: number },
): string {
  return renderToHtml(<Composition />, {
    shotId: "01",
    width: size.width,
    height: size.height,
    duration: 5,
    typography: { lang: "en" },
    ...(crop ? { crop } : {}),
  });
}

// The delivery crop is a browser-side window, not an ffmpeg pass: the picture is laid out at the
// working canvas scaled to cover the delivery — the layout that was reviewed, pixel for pixel — and
// the delivered frame is the viewport it is centred in.
describe("Composition delivery crop", () => {
  it("captures the composition itself when there is no crop", () => {
    const html = shell({ width: 1248, height: 704 });
    expect(html).toContain('data-width="1248"');
    expect(html).toContain('data-height="704"');
    expect(html).toContain("html, body { width: 1248px; height: 704px;");
    expect(html).toContain("#stage { position: absolute; top: 0px; left: 0px; width: 1248px;");
  });

  it("captures the crop window while laying the picture out at its own size", () => {
    const html = shell({ width: 1920, height: 1084 }, { width: 1920, height: 1080 });
    // What is encoded is the delivered frame.
    expect(html).toContain('data-width="1920"');
    expect(html).toContain('data-height="1080"');
    expect(html).toContain('content="width=1920, height=1080"');
    expect(html).toContain("html, body { width: 1920px; height: 1080px;");
    // What is composed is still the full cover frame, pulled up so the trim is even top and bottom.
    expect(html).toContain("#stage { position: absolute; top: -2px; left: 0px;");
    expect(html).toContain("width: 1920px; height: 1084px;");
  });

  it("centres the window on whichever axis overshoots", () => {
    const wide = shell({ width: 1954, height: 1080 }, { width: 1920, height: 1080 });
    expect(wide).toContain("#stage { position: absolute; top: 0px; left: -17px;");
  });
});
