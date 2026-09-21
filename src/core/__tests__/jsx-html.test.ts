import { describe, expect, it } from "vitest";
import { getRenderContext, renderToHtml } from "../jsx-html.js";

function h(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  type: string | symbol | ((props: any) => unknown),
  props: Record<string, unknown> | null,
  ...children: unknown[]
): unknown {
  const mergedProps = {
    ...(props ?? {}),
    children: children.length === 1 ? children[0] : children,
  };
  return { type, props: mergedProps };
}

describe("renderToHtml", () => {
  const ctx = {
    shotId: "01",
    width: 1920,
    height: 1080,
    duration: 5,
    typography: { lang: "en" as const },
  };

  it("renders a simple element", () => {
    const el = h("div", { className: "test" }, "Hello") as React.ReactElement;
    expect(renderToHtml(el, ctx)).toBe('<div class="test">Hello</div>');
  });

  it("renders void elements as self-closing", () => {
    const el = h("br", null) as React.ReactElement;
    expect(renderToHtml(el, ctx)).toBe("<br />");
  });

  it("renders img as void element with attributes", () => {
    const el = h("img", { src: "test.png", alt: "test" }) as React.ReactElement;
    expect(renderToHtml(el, ctx)).toBe('<img src="test.png" alt="test" />');
  });

  it("maps className to class", () => {
    const el = h("div", { className: "foo bar" }) as React.ReactElement;
    expect(renderToHtml(el, ctx)).toBe('<div class="foo bar"></div>');
  });

  it("maps playsInline to playsinline", () => {
    const el = h("video", { playsInline: true }) as React.ReactElement;
    expect(renderToHtml(el, ctx)).toBe("<video playsinline></video>");
  });

  it("maps camelCase SVG presentation attributes to their hyphenated names", () => {
    const el = h(
      "svg",
      { viewBox: "0 0 24 24" },
      h("circle", { cx: 12, cy: 12, r: 7, fill: "#fff", strokeWidth: 2, strokeLinejoin: "round" }),
    ) as React.ReactElement;
    expect(renderToHtml(el, ctx)).toBe(
      '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="7" fill="#fff" stroke-width="2" stroke-linejoin="round"></circle></svg>',
    );
  });

  it("handles boolean attributes - true renders attribute name only", () => {
    const el = h("video", { muted: true }) as React.ReactElement;
    expect(renderToHtml(el, ctx)).toBe("<video muted></video>");
  });

  it("handles boolean attributes - false omits the attribute", () => {
    const el = h("video", { muted: false }) as React.ReactElement;
    expect(renderToHtml(el, ctx)).toBe("<video></video>");
  });

  it("passes through data-* attributes", () => {
    const el = h("div", { "data-start": "0", "data-track-index": "1" }) as React.ReactElement;
    expect(renderToHtml(el, ctx)).toBe('<div data-start="0" data-track-index="1"></div>');
  });

  it("escapes text content", () => {
    const el = h("p", null, '<script>alert("xss")</script>') as React.ReactElement;
    expect(renderToHtml(el, ctx)).toBe(
      "<p>&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;</p>",
    );
  });

  it("does NOT escape content inside style (raw text element)", () => {
    const el = h("style", null, ".foo > .bar { color: red; }") as React.ReactElement;
    expect(renderToHtml(el, ctx)).toBe("<style>.foo > .bar { color: red; }</style>");
  });

  it("does NOT escape content inside script (raw text element)", () => {
    const el = h("script", null, "var x = 1 < 2 && 3 > 0;") as React.ReactElement;
    expect(renderToHtml(el, ctx)).toBe("<script>var x = 1 < 2 && 3 > 0;</script>");
  });

  it("renders nested elements", () => {
    const el = h("div", null, h("span", null, "inner")) as React.ReactElement;
    expect(renderToHtml(el, ctx)).toBe("<div><span>inner</span></div>");
  });

  it("renders multiple children", () => {
    const el = h("ul", null, h("li", null, "a"), h("li", null, "b")) as React.ReactElement;
    expect(renderToHtml(el, ctx)).toBe("<ul><li>a</li><li>b</li></ul>");
  });

  it("handles function components", () => {
    function MyComponent(props: { name: string; children?: unknown }) {
      return h("div", { className: "wrapper" }, h("span", null, props.name));
    }
    const el = h(MyComponent, { name: "test" }) as React.ReactElement;
    expect(renderToHtml(el, ctx)).toBe('<div class="wrapper"><span>test</span></div>');
  });

  it("supports dangerouslySetInnerHTML", () => {
    const el = h("div", {
      dangerouslySetInnerHTML: { __html: "<b>raw</b>" },
    }) as React.ReactElement;
    expect(renderToHtml(el, ctx)).toBe("<div><b>raw</b></div>");
  });

  it("prepends doctype when root element is html", () => {
    const el = h("html", null, h("body", null, "hello")) as React.ReactElement;
    expect(renderToHtml(el, ctx)).toBe("<!doctype html>\n<html><body>hello</body></html>");
  });

  it("does not add doctype for non-html root elements", () => {
    const el = h("div", null, "hello") as React.ReactElement;
    expect(renderToHtml(el, ctx)).toBe("<div>hello</div>");
  });

  it("renders numeric attributes", () => {
    const el = h("meta", { "data-width": 1920 }) as React.ReactElement;
    expect(renderToHtml(el, ctx)).toBe('<meta data-width="1920" />');
  });

  it("omits null and undefined attributes", () => {
    const el = h("div", { id: null, title: undefined, className: "x" }) as React.ReactElement;
    expect(renderToHtml(el, ctx)).toBe('<div class="x"></div>');
  });

  it("handles empty children gracefully", () => {
    const el = h("div", null, null, undefined, false, "text") as React.ReactElement;
    expect(renderToHtml(el, ctx)).toBe("<div>text</div>");
  });

  it("escapes attribute values", () => {
    const el = h("div", { title: 'a "quote" & <tag>' }) as React.ReactElement;
    expect(renderToHtml(el, ctx)).toBe('<div title="a &quot;quote&quot; &amp; &lt;tag&gt;"></div>');
  });

  it("serializes a style object to a CSS string (camelCase -> kebab-case)", () => {
    const el = h("div", {
      style: { paddingBottom: "12%", backgroundColor: "red" },
    }) as React.ReactElement;
    expect(renderToHtml(el, ctx)).toBe(
      '<div style="padding-bottom:12%;background-color:red"></div>',
    );
  });

  it("appends px to non-zero numeric style values, but not to unitless ones", () => {
    const el = h("div", {
      style: { width: 200, opacity: 0.5, zIndex: 10, marginTop: 0 },
    }) as React.ReactElement;
    expect(renderToHtml(el, ctx)).toBe(
      '<div style="width:200px;opacity:0.5;z-index:10;margin-top:0"></div>',
    );
  });

  it("drops null/undefined/false style declarations and omits an empty style attribute", () => {
    const el = h("div", {
      style: { color: null, top: undefined, display: false },
    }) as React.ReactElement;
    expect(renderToHtml(el, ctx)).toBe("<div></div>");
  });

  it("preserves CSS custom properties verbatim", () => {
    const el = h("div", { style: { "--my-var": "4px" } }) as React.ReactElement;
    expect(renderToHtml(el, ctx)).toBe('<div style="--my-var:4px"></div>');
  });

  it("distinct style objects produce distinct HTML (not [object Object])", () => {
    const a = renderToHtml(h("div", { style: { bottom: "12%" } }) as React.ReactElement, ctx);
    const b = renderToHtml(
      h("div", { style: { paddingBottom: "12%" } }) as React.ReactElement,
      ctx,
    );
    expect(a).not.toContain("[object Object]");
    expect(a).not.toBe(b);
  });

  it("passes a string style through unchanged", () => {
    const el = h("div", { style: "color:red" }) as React.ReactElement;
    expect(renderToHtml(el, ctx)).toBe('<div style="color:red"></div>');
  });

  it("drops function-valued props (event handlers) instead of serializing their source", () => {
    const el = h("div", {
      onClick: () => "noop",
      className: "x",
    }) as React.ReactElement;
    expect(renderToHtml(el, ctx)).toBe('<div class="x"></div>');
  });

  it("renders Fragment children without wrapper tag", () => {
    const fragment = Symbol.for("react.fragment");
    const el = h(fragment, null, h("span", null, "a"), h("span", null, "b")) as React.ReactElement;
    expect(renderToHtml(el, ctx)).toBe("<span>a</span><span>b</span>");
  });

  it("renders Fragment with single child", () => {
    const fragment = Symbol.for("react.fragment");
    const el = h(fragment, null, h("div", null, "only")) as React.ReactElement;
    expect(renderToHtml(el, ctx)).toBe("<div>only</div>");
  });
});

describe("getRenderContext", () => {
  it("throws when called outside renderToHtml", () => {
    expect(() => getRenderContext()).toThrow("called outside of renderToHtml");
  });

  it("is available during renderToHtml", () => {
    let captured: { shotId: string; width: number; height: number; duration: number } | null = null;
    function ContextReader() {
      captured = getRenderContext();
      return h("div", null, "ok");
    }

    const el = h(ContextReader, null) as React.ReactElement;
    renderToHtml(el, {
      shotId: "03",
      width: 1280,
      height: 720,
      duration: 5,
      typography: { lang: "en" as const },
    });

    expect(captured).toEqual({
      shotId: "03",
      width: 1280,
      height: 720,
      duration: 5,
      typography: { lang: "en" as const },
    });
  });
});
