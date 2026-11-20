import { describe, expect, it } from "vitest";
import { Composition, Video } from "../dsl/composition/index.js";
import { renderToHtml, type RenderContext } from "../jsx-html.js";
import { harvestCompositionVideos, withVideoElementIds } from "../composition-capture.js";
import { DEFAULT_BACKDROP, hueRotationToGreen } from "../dsl/composition/chroma-key.js";

const CONTEXT: RenderContext = {
  shotId: "01",
  width: 1000,
  height: 500,
  duration: 3,
  typography: { lang: "en" },
};

const clip = { src: "assets/files/green.mp4" };

function render(element: React.ReactElement): string {
  return renderToHtml(<Composition>{element}</Composition>, CONTEXT);
}

function tag(html: string, name: string): string {
  return html.match(new RegExp(`<${name}\\b[^>]*>`))![0];
}

describe("<Video chromaKey>", () => {
  it("lands id, className and style on the keyed layer and hides the source clip", () => {
    const html = render(
      <Video
        src={clip}
        chromaKey
        id="holmes"
        className="scale-110"
        style={{ filter: "brightness(0.9)" }}
        start={1}
        hasAudio
      />,
    );
    const video = tag(html, "video");
    const canvas = tag(html, "canvas");
    expect(video).toContain('id="holmes-source"');
    expect(video).toContain('class="konte-clip"');
    expect(video).toContain("opacity:0");
    expect(video).toContain('data-start="1"');
    expect(video).toContain('data-has-audio="true"');
    expect(canvas).toContain('id="holmes"');
    expect(canvas).toContain('class="konte-keyed scale-110"');
    expect(canvas).toContain("filter:brightness(0.9)");
    expect(html).toMatch(/<div class="konte-clip" data-start="1" data-duration="2"><canvas /);
    expect(html).toContain('("holmes-source", "holmes",');
  });

  it("gives an unnamed keyed clip a stable id of its own", () => {
    const first = render(<Video src={clip} chromaKey />);
    const second = render(<Video src={clip} chromaKey />);
    const id = tag(first, "canvas").match(/id="([^"]+)"/)![1]!;
    expect(id).toMatch(/^konte-key-[0-9a-f]{12}$/);
    expect(tag(first, "video")).toContain(`id="${id}-source"`);
    expect(first).toBe(second);
  });

  it("gives two unnamed clips of one take apart ids of their own", () => {
    const html = render(
      <>
        <Video src={clip} chromaKey />
        <Video src={clip} chromaKey mediaStart={1} />
      </>,
    );
    const ids = [...html.matchAll(/<canvas id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("keeps the source clip on the timeline the capture harvests", () => {
    const videos = harvestCompositionVideos(
      withVideoElementIds(render(<Video src={clip} chromaKey id="k" start={0.5} duration={2} />)),
    );
    expect(videos).toEqual([
      expect.objectContaining({ id: "k-source", src: clip.src, start: 0.5, end: 2.5 }),
    ]);
  });

  it("leaves a clip without chromaKey as one <video>", () => {
    const html = render(<Video src={clip} id="plain" className="opacity-50" />);
    expect(html).not.toContain("<canvas");
    expect(tag(html, "video")).toContain('id="plain"');
    expect(tag(html, "video")).toContain('class="konte-clip opacity-50"');
  });

  it("refuses a backdrop colour that is not hex, naming the shot", () => {
    expect(() => render(<Video src={clip} chromaKey={"#zz00ff" as `#${string}`} />)).toThrow(
      /Shot "01" <Video> chromaKey="#zz00ff"/,
    );
  });

  it("refuses a grey backdrop, which has no hue to key", () => {
    expect(() => render(<Video src={clip} chromaKey="#808080" />)).toThrow(/too close to grey/);
  });

  it("hands the page the rotation for the backdrop it names", () => {
    const html = render(<Video src={clip} chromaKey="#ff00ff" id="m" />);
    const rot = hueRotationToGreen("#ff00ff", "x");
    expect(html).toContain(JSON.stringify(rot));
  });
});

describe("hueRotationToGreen", () => {
  const apply = (m: number[], [r, g, b]: number[]) =>
    [0, 3, 6].map((i) => m[i]! * r! + m[i + 1]! * g! + m[i + 2]! * b!);

  it("leaves the default green backdrop unturned", () => {
    const m = hueRotationToGreen(DEFAULT_BACKDROP, "x");
    [1, 0, 0, 0, 1, 0, 0, 0, 1].forEach((v, i) => expect(m[i]).toBeCloseTo(v, 10));
  });

  it.each(["#ff00ff", "#0040ff", "#ff2010"] as const)("turns %s onto green, keeping grey", (c) => {
    const m = hueRotationToGreen(c, "x");
    const hex = c.slice(1);
    const rgb = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const [r, g, b] = apply(m, rgb);
    expect(g! - Math.max(r!, b!)).toBeGreaterThan(0.4);
    expect(Math.abs(r! - b!)).toBeLessThan(1e-9);
    apply(m, [0.5, 0.5, 0.5]).forEach((v) => expect(v).toBeCloseTo(0.5, 10));
  });

  it("is a rotation: its transpose turns it back", () => {
    const m = hueRotationToGreen("#ff00ff", "x");
    const t = [m[0]!, m[3]!, m[6]!, m[1]!, m[4]!, m[7]!, m[2]!, m[5]!, m[8]!];
    apply(t, apply(m, [0.9, 0.3, 0.1])).forEach((v, i) =>
      expect(v).toBeCloseTo([0.9, 0.3, 0.1][i]!, 10),
    );
  });
});
