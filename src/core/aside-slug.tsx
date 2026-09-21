import { Composition } from "./dsl/composition/index.js";
import { renderToHtml } from "./jsx-html.js";
import type { Typography } from "./types/index.js";

// The picture konte puts in an aside's span on the board. The animatic never boards an aside, but the
// span still has to be there, or the reel runs short and the pacing is judged against the wrong
// clock: the label, centred, and the span's length under it.
//
// The shot carries no `shotFn` — which is what keeps the aside out of review on this stage — so this
// is built at render time rather than from the definition.
export function asideSlugHtml(options: {
  shotId: string;
  label: string;
  duration: number;
  size: { width: number; height: number };
  typography: Typography;
  // The reel mounts each shot into a shared host, so its composition emits children only.
  nested?: boolean;
}): string {
  const { shotId, label, duration, size, typography, nested = false } = options;
  const jsx = (
    <Composition>
      <div
        style={{
          position: "absolute",
          inset: "0",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: `${Math.round(size.height * 0.02)}px`,
          padding: `${Math.round(size.width * 0.08)}px`,
          textAlign: "center",
          color: "#e6e6e6",
        }}
      >
        <div style={{ fontSize: `${Math.round(size.height * 0.06)}px`, lineHeight: 1.3 }}>
          {label}
        </div>
        <div style={{ fontSize: `${Math.round(size.height * 0.03)}px`, color: "#8a8a8a" }}>
          {`${duration}s`}
        </div>
      </div>
    </Composition>
  );
  return renderToHtml(jsx, {
    shotId,
    width: size.width,
    height: size.height,
    duration,
    nested,
    typography,
  });
}
