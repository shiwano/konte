import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { generateDtsBundle } from "dts-bundle-generator";

const entryPoint = path.resolve(import.meta.dirname, "../src/core/dsl/template-entry.ts");
const outFile = path.resolve(
  import.meta.dirname,
  "../src/cli/templates/workspace/dot.konte/mod.ts",
);

// The DSL's dependencies need Node types. Loading Bun's ambient types slows declaration
// bundling; revisit this config if the DSL starts depending on Bun-specific types or inference.
const tsconfigPath = path.resolve(import.meta.dirname, "tsconfig.template-mod.json");

const [result] = generateDtsBundle(
  [
    {
      filePath: entryPoint,
      output: {
        noBanner: true,
      },
    },
  ],
  {
    preferredConfigPath: tsconfigPath,
  },
);

if (!result) {
  throw new Error(`Failed to generate d.ts bundle for ${entryPoint}`);
}

// `Location` collides with the DOM global, so dts-bundle-generator renames the DSL type to
// `Location$1` and lumps its re-export into the shared `export { … }` line alongside the value
// re-exports (Audio/Image, DOM globals too). That fails under `verbatimModuleSyntax`, which demands
// `export type` for a type-only re-export. Pull `Location` out into its own `export type` line.
//
// `Cutin` is both the direction's type and the component that draws it. dts-bundle-generator keeps
// the type under the bare name and renames the component to `Cutin$1`, then re-exports that under
// `Cutin` too — a second export of one name. Re-export the component as a value alone, which a type
// of the same name does not collide with.
const dtsBody = result
  .replace(/import \{ z \} from ['"]zod['"];?\n?/, "")
  .replace(/\nexport \{\};\n?/, "\n")
  .replace(/,?\s*Location\$1 as Location(?=\s*[,}])/, "")
  .replace(/,?\s*Cutin\$1 as Cutin(?=\s*[,}])/, "")
  .concat("\nexport type { Location$1 as Location };\n")
  .concat("export declare const Cutin: typeof Cutin$1;\n");

const ZOD_STUBS = `declare namespace z {
  interface ZodTypeDef {}
  interface ZodType<Output = any, _Def extends ZodTypeDef = ZodTypeDef, Input = Output> {
    _output: Output;
    _input: Input;
  }
  type ZodTypeAny = ZodType<any, ZodTypeDef, any>;
  type infer<T extends ZodType<any, any, any>> = T["_output"];
  type ZodString = ZodType<string>;
  type ZodNumber = ZodType<number>;
  type ZodBoolean = ZodType<boolean>;
  type ZodLiteral<T> = ZodType<T>;
  type ZodUnknown = ZodType<unknown>;
  type ZodNever = ZodType<never>;
  interface ZodOptional<T extends ZodTypeAny> extends ZodType<
    T["_output"] | undefined, ZodTypeDef, T["_input"] | undefined
  > {}
  interface ZodNullable<T extends ZodTypeAny> extends ZodType<
    T["_output"] | null, ZodTypeDef, T["_input"] | null
  > {}
  interface ZodTuple<
    T extends readonly ZodTypeAny[] = ZodTypeAny[],
    _R extends ZodTypeAny | null = null,
  > extends ZodType<
    { -readonly [K in keyof T]: T[K] extends ZodTypeAny ? T[K]["_output"] : never },
    ZodTypeDef,
    { -readonly [K in keyof T]: T[K] extends ZodTypeAny ? T[K]["_input"] : never }
  > {}
  interface ZodEnum<T extends [string, ...string[]]> extends ZodType<T[number]> {}
  interface ZodRecord<K extends ZodType<string>, V extends ZodTypeAny> extends ZodType<
    Record<K["_output"], V["_output"]>
  > {}
  interface ZodArray<T extends ZodTypeAny, _C extends "many" | "atleastone" = "many"> extends ZodType<
    T["_output"][]
  > {}
  interface ZodObject<
    _S extends Record<string, ZodTypeAny> = Record<string, ZodTypeAny>,
    _M extends string = "strip",
    _C extends ZodTypeAny = ZodTypeAny,
    Output = any,
    Input = Output,
  > extends ZodType<Output, ZodTypeDef, Input> {}
  interface ZodDiscriminatedUnion<
    _K extends string = string,
    M extends readonly ZodObject[] = ZodObject[],
  > extends ZodType<M[number]["_output"], ZodTypeDef, M[number]["_input"]> {}
  interface ZodUnion<
    M extends readonly ZodTypeAny[] = ZodTypeAny[],
  > extends ZodType<M[number]["_output"], ZodTypeDef, M[number]["_input"]> {}
}`;

const REACT_NAMESPACE = `declare namespace React {
  type ReactElement = { type: string | Function; props: Record<string, unknown> };
  type ReactNode = ReactElement | string | number | boolean | null | undefined | ReactNode[];
  type ComponentPropsWithoutRef<T extends keyof JSX.IntrinsicElements> = JSX.IntrinsicElements[T];
}`;

const JSX_NAMESPACE = `declare global {
  namespace JSX {
    type Element = {
      type: string | Function;
      props: Record<string, unknown>;
    };

    interface ElementChildrenAttribute {
      children: {};
    }

    interface HtmlAttributes {
      id?: string;
      className?: string;
      style?: string | Record<string, string | number>;
      title?: string;
      lang?: string;
      hidden?: boolean;
      children?: any;
      dangerouslySetInnerHTML?: { __html: string };
      [key: \`data-\${string}\`]: string | number | boolean;
    }

    interface MediaAttributes extends HtmlAttributes {
      src?: string;
      muted?: boolean;
      playsInline?: boolean;
      autoPlay?: boolean;
      loop?: boolean;
      controls?: boolean;
      preload?: string;
    }

    interface MetaAttributes extends HtmlAttributes {
      charSet?: string;
      name?: string;
      content?: string;
      httpEquiv?: string;
    }

    interface LinkAttributes extends HtmlAttributes {
      rel?: string;
      href?: string;
      type?: string;
      media?: string;
    }

    interface ScriptAttributes extends HtmlAttributes {
      src?: string;
      type?: string;
      async?: boolean;
      defer?: boolean;
    }

    type SvgLength = number | string;

    interface SvgAttributes extends HtmlAttributes {
      transform?: string;
      transformOrigin?: string;
      opacity?: number | string;
      fill?: string;
      fillOpacity?: number | string;
      fillRule?: "nonzero" | "evenodd";
      stroke?: string;
      strokeWidth?: SvgLength;
      strokeOpacity?: number | string;
      strokeLinecap?: "butt" | "round" | "square";
      strokeLinejoin?: "miter" | "round" | "bevel" | "arcs" | "miter-clip";
      strokeMiterlimit?: number | string;
      strokeDasharray?: SvgLength;
      strokeDashoffset?: SvgLength;
      paintOrder?: string;
      vectorEffect?: string;
      shapeRendering?: string;
      clipPath?: string;
      clipRule?: "nonzero" | "evenodd";
      mask?: string;
      filter?: string;
      markerStart?: string;
      markerMid?: string;
      markerEnd?: string;
    }

    interface SvgTextAttributes extends SvgAttributes {
      x?: SvgLength;
      y?: SvgLength;
      dx?: SvgLength;
      dy?: SvgLength;
      textAnchor?: "start" | "middle" | "end";
      dominantBaseline?: string;
      fontFamily?: string;
      fontSize?: SvgLength;
      fontWeight?: number | string;
      fontStyle?: string;
      letterSpacing?: SvgLength;
    }

    interface IntrinsicElements {
      div: HtmlAttributes;
      span: HtmlAttributes;
      p: HtmlAttributes;
      h1: HtmlAttributes;
      h2: HtmlAttributes;
      h3: HtmlAttributes;
      h4: HtmlAttributes;
      h5: HtmlAttributes;
      h6: HtmlAttributes;
      a: HtmlAttributes & { href?: string; target?: string; rel?: string };
      img: HtmlAttributes & { src?: string; alt?: string; width?: number; height?: number };
      video: MediaAttributes & { width?: number; height?: number; poster?: string };
      audio: MediaAttributes;
      source: HtmlAttributes & { src?: string; type?: string };
      track: HtmlAttributes & {
        src?: string;
        kind?: string;
        label?: string;
        srcLang?: string;
        default?: boolean;
      };
      html: HtmlAttributes;
      head: HtmlAttributes;
      body: HtmlAttributes;
      title: HtmlAttributes;
      meta: MetaAttributes;
      link: LinkAttributes;
      style: HtmlAttributes;
      script: ScriptAttributes;
      br: HtmlAttributes;
      hr: HtmlAttributes;
      input: HtmlAttributes & { type?: string; value?: string; name?: string };
      canvas: HtmlAttributes & { width?: number; height?: number };
      svg: SvgAttributes & {
        width?: SvgLength;
        height?: SvgLength;
        viewBox?: string;
        preserveAspectRatio?: string;
        xmlns?: string;
      };
      g: SvgAttributes;
      defs: SvgAttributes;
      symbol: SvgAttributes & { viewBox?: string; preserveAspectRatio?: string };
      use: SvgAttributes & {
        href?: string;
        x?: SvgLength;
        y?: SvgLength;
        width?: SvgLength;
        height?: SvgLength;
      };
      path: SvgAttributes & { d?: string; pathLength?: number };
      rect: SvgAttributes & {
        x?: SvgLength;
        y?: SvgLength;
        width?: SvgLength;
        height?: SvgLength;
        rx?: SvgLength;
        ry?: SvgLength;
      };
      circle: SvgAttributes & { cx?: SvgLength; cy?: SvgLength; r?: SvgLength };
      ellipse: SvgAttributes & { cx?: SvgLength; cy?: SvgLength; rx?: SvgLength; ry?: SvgLength };
      line: SvgAttributes & { x1?: SvgLength; y1?: SvgLength; x2?: SvgLength; y2?: SvgLength };
      polyline: SvgAttributes & { points?: string };
      polygon: SvgAttributes & { points?: string };
      text: SvgTextAttributes;
      tspan: SvgTextAttributes;
      image: SvgAttributes & {
        href?: string;
        x?: SvgLength;
        y?: SvgLength;
        width?: SvgLength;
        height?: SvgLength;
        preserveAspectRatio?: string;
      };
      linearGradient: SvgAttributes & {
        x1?: SvgLength;
        y1?: SvgLength;
        x2?: SvgLength;
        y2?: SvgLength;
        gradientUnits?: "userSpaceOnUse" | "objectBoundingBox";
        gradientTransform?: string;
        spreadMethod?: "pad" | "reflect" | "repeat";
      };
      radialGradient: SvgAttributes & {
        cx?: SvgLength;
        cy?: SvgLength;
        r?: SvgLength;
        fx?: SvgLength;
        fy?: SvgLength;
        gradientUnits?: "userSpaceOnUse" | "objectBoundingBox";
        gradientTransform?: string;
        spreadMethod?: "pad" | "reflect" | "repeat";
      };
      stop: SvgAttributes & { offset?: SvgLength; stopColor?: string; stopOpacity?: number | string };
      clipPath: SvgAttributes & { clipPathUnits?: "userSpaceOnUse" | "objectBoundingBox" };
      mask: SvgAttributes & {
        x?: SvgLength;
        y?: SvgLength;
        width?: SvgLength;
        height?: SvgLength;
        maskUnits?: "userSpaceOnUse" | "objectBoundingBox";
        maskContentUnits?: "userSpaceOnUse" | "objectBoundingBox";
      };
      pattern: SvgAttributes & {
        x?: SvgLength;
        y?: SvgLength;
        width?: SvgLength;
        height?: SvgLength;
        viewBox?: string;
        patternUnits?: "userSpaceOnUse" | "objectBoundingBox";
        patternContentUnits?: "userSpaceOnUse" | "objectBoundingBox";
        patternTransform?: string;
      };
    }
  }
}`;

const JSX_RUNTIME_EXPORTS = `export declare function jsx(type: any, props: any, key?: string): React.ReactElement;
export declare function jsxs(type: any, props: any, key?: string): React.ReactElement;
export declare function Fragment(props: { children?: any }): React.ReactElement;`;

const output = `/* eslint-disable */

${REACT_NAMESPACE}

${ZOD_STUBS}

${JSX_NAMESPACE}

${dtsBody}

${JSX_RUNTIME_EXPORTS}
`;

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, output, "utf-8");
childProcess.execSync(`oxfmt --write ${outFile}`, { stdio: "ignore" });

console.log(`Generated template mod.ts → ${path.relative(process.cwd(), outFile)}`);
