/* eslint-disable */

declare global {
  namespace React {
    type ReactElement = { type: string | Function; props: Record<string, unknown> };
    type ReactNode = ReactElement | string | number | boolean | null | undefined | ReactNode[];
    type ComponentPropsWithoutRef<T extends keyof JSX.IntrinsicElements> = JSX.IntrinsicElements[T];
  }

  namespace JSX {
    type Element = {
      type: string | Function;
      props: Record<string, unknown>;
    };

    interface ElementChildrenAttribute {
      children: {};
    }

    interface IntrinsicAttributes {
      key?: string | number;
    }

    interface HtmlAttributes extends IntrinsicAttributes {
      id?: string;
      className?: string;
      style?: string | Record<string, string | number>;
      title?: string;
      lang?: string;
      hidden?: boolean;
      dir?: "ltr" | "rtl" | "auto";
      role?: string;
      tabIndex?: number;
      children?: any;
      dangerouslySetInnerHTML?: { __html: string };
      [key: `data-${string}`]: string | number | boolean;
      [key: `aria-${string}`]: string | number | boolean;
    }

    interface FormControlAttributes extends HtmlAttributes {
      name?: string;
      disabled?: boolean;
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

    type HtmlElements = { [K in keyof HTMLElementTagNameMap]: HtmlAttributes };

    interface IntrinsicElements extends HtmlElements {
      a: HtmlAttributes & {
        href?: string;
        target?: string;
        rel?: string;
        download?: string | boolean;
      };
      img: HtmlAttributes & {
        src?: string;
        srcSet?: string;
        sizes?: string;
        alt?: string;
        width?: number;
        height?: number;
        loading?: "eager" | "lazy";
        decoding?: "sync" | "async" | "auto";
      };
      video: MediaAttributes & { width?: number; height?: number; poster?: string };
      audio: MediaAttributes;
      source: HtmlAttributes & {
        src?: string;
        srcSet?: string;
        sizes?: string;
        media?: string;
        type?: string;
      };
      track: HtmlAttributes & {
        src?: string;
        kind?: string;
        label?: string;
        srcLang?: string;
        default?: boolean;
      };
      iframe: HtmlAttributes & { src?: string; srcDoc?: string; width?: number; height?: number };
      meta: MetaAttributes;
      link: LinkAttributes;
      script: ScriptAttributes;
      canvas: HtmlAttributes & { width?: number; height?: number };
      ol: HtmlAttributes & { start?: number; reversed?: boolean; type?: string };
      li: HtmlAttributes & { value?: number };
      th: HtmlAttributes & { colSpan?: number; rowSpan?: number; scope?: string };
      td: HtmlAttributes & { colSpan?: number; rowSpan?: number };
      col: HtmlAttributes & { span?: number };
      colgroup: HtmlAttributes & { span?: number };
      time: HtmlAttributes & { dateTime?: string };
      details: HtmlAttributes & { open?: boolean };
      dialog: HtmlAttributes & { open?: boolean };
      form: HtmlAttributes & { action?: string; method?: string };
      label: HtmlAttributes & { htmlFor?: string };
      input: FormControlAttributes & {
        type?: string;
        value?: string | number;
        placeholder?: string;
        checked?: boolean;
        readOnly?: boolean;
        required?: boolean;
        min?: number | string;
        max?: number | string;
        step?: number | string;
      };
      button: FormControlAttributes & { type?: "button" | "submit" | "reset"; value?: string };
      textarea: FormControlAttributes & {
        placeholder?: string;
        rows?: number;
        cols?: number;
        readOnly?: boolean;
        required?: boolean;
      };
      select: FormControlAttributes & { multiple?: boolean; required?: boolean };
      option: HtmlAttributes & { value?: string; selected?: boolean; disabled?: boolean };
      optgroup: HtmlAttributes & { label?: string; disabled?: boolean };
      fieldset: HtmlAttributes & { disabled?: boolean };
      progress: HtmlAttributes & { value?: number; max?: number };
      meter: HtmlAttributes & {
        value?: number;
        min?: number;
        max?: number;
        low?: number;
        high?: number;
        optimum?: number;
      };
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
      stop: SvgAttributes & {
        offset?: SvgLength;
        stopColor?: string;
        stopOpacity?: number | string;
      };
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
}

export type ReactElement = React.ReactElement;
export type ReactNode = React.ReactNode;
export type ComponentPropsWithoutRef<T extends keyof JSX.IntrinsicElements> =
  React.ComponentPropsWithoutRef<T>;

export declare function Fragment(props: { children?: any }): React.ReactElement;
