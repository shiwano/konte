import { getRenderContext } from "../../jsx-html.js";
import { TAILWIND_BROWSER_SRC } from "../../tailwind-version.js";
import { fontFamilyStack, googleFontsHref } from "../../typography.js";
import { resetPanelCursor } from "../panel-collect.js";

export function Composition({ children }: { children?: React.ReactNode }): React.ReactElement {
  const { shotId, width, height, duration, nested, still, typography, crop } = getRenderContext();
  // A shot's keyframes are paired with their recorded windows by position (see nextPanelIndex), so
  // the cursor restarts as each shot's composition does.
  resetPanelCursor();

  // Nested mode: emit just the children so the caller can wrap them in a
  // <template id="shot-<id>-template"> and hydrate them into an empty
  // [data-composition-id] host. The HyperFrames runtime mounts that template,
  // scoping selectors and getElementById per composition (so duplicate ids across
  // shots stay isolated) and sequencing each shot's timeline at its host's data-start.
  if (nested) {
    return <>{children}</>;
  }

  const fontsHref = googleFontsHref(typography.fonts);
  const fontStack = fontFamilyStack(typography.fonts);

  // The captured frame: the composition itself, or the smaller window it is centred inside.
  const frameWidth = crop?.width ?? width;
  const frameHeight = crop?.height ?? height;
  const offsetX = Math.round((frameWidth - width) / 2);
  const offsetY = Math.round((frameHeight - height) / 2);

  return (
    <html lang={typography.lang}>
      <head>
        <meta charSet="UTF-8" />
        <meta name="viewport" content={`width=${frameWidth}, height=${frameHeight}`} />
        <meta
          data-composition-id={`shot-${shotId}`}
          data-width={frameWidth}
          data-height={frameHeight}
          data-duration={duration}
          data-no-timeline={still ? "" : undefined}
        />
        <title>{`Shot ${shotId}`}</title>
        {fontsHref ? <link rel="stylesheet" href={fontsHref} /> : null}
        <script src="https://cdn.jsdelivr.net/npm/gsap@3.12.5/dist/gsap.min.js" />
        <script src={TAILWIND_BROWSER_SRC} />
        {/* Layered under Tailwind's utilities: an unlayered rule beats every layered one, so an
            author's `w-1/3` or `p-4` would otherwise lose to the reset or `.konte-clip`. */}
        <style>{`
@layer theme, base, components, utilities;
@layer base { * { margin: 0; padding: 0; box-sizing: border-box; } }
html, body { width: ${frameWidth}px; height: ${frameHeight}px; overflow: hidden; background: #000;${fontStack ? ` font-family: ${fontStack};` : ""} }
#stage { position: absolute; top: ${offsetY}px; left: ${offsetX}px; width: ${width}px; height: ${height}px; overflow: hidden; }
@layer components { .konte-clip { position: absolute; top: 0; left: 0; width: 100%; height: 100%; visibility: hidden; object-fit: cover; } }
`}</style>
      </head>
      <body>
        <div id="stage">{children}</div>
      </body>
    </html>
  );
}
