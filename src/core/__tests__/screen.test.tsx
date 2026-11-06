import { describe, expect, it } from "vitest";
import { Composition, Panel, Screen, Video, type ScreenProps } from "../dsl/composition/index.js";
import { renderToHtml, type RenderContext } from "../jsx-html.js";

const CONTEXT: RenderContext = {
  shotId: "01",
  width: 1000,
  height: 500,
  duration: 3,
  typography: { lang: "en" },
};

const TILTED: ScreenProps["corners"] = [
  [0.2, 0.2],
  [0.7, 0.3],
  [0.65, 0.8],
  [0.25, 0.7],
];

function render(element: React.ReactElement): string {
  return renderToHtml(<Composition>{element}</Composition>, CONTEXT);
}

function boxOf(html: string): { width: number; height: number; matrix: number[] } {
  const style = html.match(/data-konte-screen="" style="([^"]*)"/)![1]!;
  return {
    width: Number(style.match(/width:\s*([\d.]+)px/)![1]),
    height: Number(style.match(/height:\s*([\d.]+)px/)![1]),
    matrix: style
      .match(/matrix3d\(([^)]*)\)/)![1]!
      .split(",")
      .map(Number),
  };
}

function project(m: number[], x: number, y: number): [number, number] {
  const w = m[3]! * x + m[7]! * y + m[15]!;
  return [(m[0]! * x + m[4]! * y + m[12]!) / w, (m[1]! * x + m[5]! * y + m[13]!) / w];
}

describe("<Screen>", () => {
  it("lands the box's corners on the canvas-fraction corners", () => {
    const { width, height, matrix } = boxOf(
      render(<Screen corners={TILTED} width={390} height={844} />),
    );
    expect([width, height]).toEqual([390, 844]);
    const landed = [
      project(matrix, 0, 0),
      project(matrix, width, 0),
      project(matrix, width, height),
      project(matrix, 0, height),
    ];
    TILTED.forEach(([x, y], i) => {
      expect(landed[i]![0]).toBeCloseTo(x * CONTEXT.width, 3);
      expect(landed[i]![1]).toBeCloseTo(y * CONTEXT.height, 3);
    });
  });

  it("sizes the box from the edges it lands on when no size is given", () => {
    const corners: ScreenProps["corners"] = [
      [0.1, 0.1],
      [0.5, 0.1],
      [0.5, 0.5],
      [0.1, 0.5],
    ];
    expect(boxOf(render(<Screen corners={corners} />))).toMatchObject({ width: 400, height: 200 });
  });

  it("lays its children inside the warped box", () => {
    const html = render(
      <Screen corners={TILTED}>
        <Video src={{ src: "/files/clip.mp4" }} />
      </Screen>,
    );
    expect(html).toMatch(/data-konte-screen=""[^>]*><video[^>]*class="konte-clip"/);
  });

  it("refuses corners out of order", () => {
    const [tl, tr, br, bl] = TILTED;
    expect(() => render(<Screen corners={[tl, bl, br, tr]} />)).toThrow(
      /top-left, top-right, bottom-right, bottom-left/,
    );
  });

  it("refuses a keyframe inside it", () => {
    expect(() =>
      render(
        <Screen corners={TILTED}>
          <Panel src={{ src: "/files/first.png" }} />
        </Screen>,
      ),
    ).toThrow(/<Panel> inside a <Screen>/);
  });
});
