import { COMPOSITION_SCRIPTS } from "../../composition-scripts.js";
import { getRenderContext } from "../../jsx-html.js";
import { fontFamilyStack, googleFontsHref } from "../../typography.js";
import type { Typography } from "../../types/definition.js";
import { resetPanelCursor } from "../panel-collect.js";

export function Composition({ children }: { children?: React.ReactNode }): React.ReactElement {
  // A shot's keyframes are paired with their recorded windows by position (see nextPanelIndex), so
  // the cursor restarts as each shot's composition does.
  resetPanelCursor();

  // Nested mode: emit just the children so the caller can wrap them in a
  // <template id="shot-<id>-template"> and hydrate them into an empty
  // [data-composition-id] host. The HyperFrames runtime mounts that template,
  // scoping selectors and getElementById per composition (so duplicate ids across
  // shots stay isolated) and sequencing each shot's timeline at its host's data-start.
  if (getRenderContext().nested) {
    return <>{children}</>;
  }

  return <CompositionDocument>{children}</CompositionDocument>;
}

/**
 * The document around a composition's stage. `stageHtml` is a stage rendered beforehand in nested
 * mode, standing in for `children`.
 */
export function CompositionDocument({
  children,
  stageHtml,
}: {
  children?: React.ReactNode;
  stageHtml?: string;
}): React.ReactElement {
  const { shotId, width, height, duration, still, typography, crop } = getRenderContext();
  // The captured frame: the composition itself, or the smaller window it is centred inside.
  const frameWidth = crop?.width ?? width;
  const frameHeight = crop?.height ?? height;
  const offsetX = Math.round((frameWidth - width) / 2);
  const offsetY = Math.round((frameHeight - height) / 2);

  return (
    <html lang={typography.lang}>
      <CompositionHead
        compositionId={`shot-${shotId}`}
        title={`Shot ${shotId}`}
        frame={{ width: frameWidth, height: frameHeight }}
        stage={{ x: offsetX, y: offsetY, width, height }}
        duration={duration}
        still={still}
        typography={typography}
      />
      <body>
        {stageHtml === undefined ? (
          <div id="stage">{children}</div>
        ) : (
          <div id="stage" dangerouslySetInnerHTML={{ __html: stageHtml }} />
        )}
      </body>
    </html>
  );
}

/** The `<head>` of every document konte renders: a shot's, a jsx still's, and the preview reel's. */
export function CompositionHead({
  compositionId,
  title,
  frame,
  stage,
  duration,
  still,
  typography,
}: {
  compositionId: string;
  title: string;
  frame: { width: number; height: number };
  stage: { x: number; y: number; width: number; height: number };
  duration: number;
  still?: boolean;
  typography: Typography;
}): React.ReactElement {
  const fontsHref = googleFontsHref(typography.fonts);
  const fontStack = fontFamilyStack(typography.fonts);
  return (
    <head>
      <meta charSet="UTF-8" />
      <meta name="viewport" content={`width=${frame.width}, height=${frame.height}`} />
      <meta
        data-composition-id={compositionId}
        data-width={frame.width}
        data-height={frame.height}
        data-duration={duration}
        data-no-timeline={still ? "" : undefined}
      />
      <title>{title}</title>
      {fontsHref ? <link rel="stylesheet" href={fontsHref} /> : null}
      {COMPOSITION_SCRIPTS.map((source, i) => (
        <script key={i} dangerouslySetInnerHTML={{ __html: source }} />
      ))}
      {/* Layered under Tailwind's utilities: an unlayered rule beats every layered one, so an
          author's `w-1/3` or `p-4` would otherwise lose to the reset or `.konte-clip`. */}
      <style>{`
@layer theme, base, components, utilities;
@layer base { * { margin: 0; padding: 0; box-sizing: border-box; } }
html, body { width: ${frame.width}px; height: ${frame.height}px; overflow: hidden; background: #000;${fontStack ? ` font-family: ${fontStack};` : ""} }
#stage { position: absolute; top: ${stage.y}px; left: ${stage.x}px; width: ${stage.width}px; height: ${stage.height}px; overflow: hidden; }
@layer components { .konte-clip { position: absolute; top: 0; left: 0; width: 100%; height: 100%; visibility: hidden; object-fit: cover; } .konte-subtitle { inset: 0; width: auto; height: auto; display: flex; align-items: flex-end; justify-content: center; text-align: center; color: #fff; font-weight: 600; filter: drop-shadow(0 4px 4px rgb(0 0 0 / 0.15)); bottom: 5%; font-size: 1.875vmax; } @media (orientation: portrait) { .konte-subtitle { bottom: calc(100% / 6); font-size: 3.25vmax; } } }
`}</style>
    </head>
  );
}
