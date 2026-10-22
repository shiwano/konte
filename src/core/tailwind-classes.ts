/// <reference path="../md.d.ts" />
import { __unstable__loadDesignSystem } from "tailwindcss";
import tailwindCss from "tailwindcss/index.css" with { type: "text" };
import { KonteError } from "./errors.js";

type DesignSystem = Awaited<ReturnType<typeof __unstable__loadDesignSystem>>;

let designSystem: Promise<DesignSystem> | undefined;

const EMBEDDED_BLOCK = /<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi;
const CLASS_ATTR = /\sclass="([^"]*)"/g;
const LITERAL_FONT_FAMILY = /font-family:(?!\s*var\()/;

export interface ClassSubject {
  /** What the author finds the markup by — a composition or jsxImage address. */
  label: string;
  html: string;
}

export interface ClassFindings {
  label: string;
  fontFamily: string[];
}

function decodeAttr(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function findFontFamilyClasses(subject: ClassSubject, system: DesignSystem): ClassFindings {
  const markup = subject.html.replace(EMBEDDED_BLOCK, "");
  const classes = new Set<string>();
  for (const match of markup.matchAll(CLASS_ATTR)) {
    for (const name of decodeAttr(match[1]!).split(/\s+/)) {
      if (name) classes.add(name);
    }
  }

  const candidates = [...classes];
  const css = system.candidatesToCss(candidates);
  const fontFamily = candidates.filter((_, i) => {
    const rule = css[i];
    return rule != null && LITERAL_FONT_FAMILY.test(rule);
  });
  return { label: subject.label, fontFamily };
}

// The subjects carrying a class that sets a font family the export cannot embed.
export async function checkTailwindClasses(
  subjects: readonly ClassSubject[],
): Promise<ClassFindings[]> {
  if (subjects.length === 0) return [];
  designSystem ??= __unstable__loadDesignSystem(tailwindCss);
  const system = await designSystem;
  return subjects
    .map((s) => findFontFamilyClasses(s, system))
    .filter((f) => f.fontFamily.length > 0);
}

// Abort with COMPOSITION_CLASS_INVALID on any finding of checkTailwindClasses.
export async function assertTailwindClasses(subjects: readonly ClassSubject[]): Promise<void> {
  const findings = await checkTailwindClasses(subjects);
  if (findings.length === 0) return;

  const count = findings.reduce((n, f) => n + f.fontFamily.length, 0);
  throw new KonteError(
    "COMPOSITION_CLASS_INVALID",
    `Rendered markup has ${count} class(es) setting a font family — declare it on direction.policy.fonts; the export embeds faces by reading the HTML, and a class's CSS does not exist until the browser has run`,
    findings.map((f) => `  ${f.label}: ${f.fontFamily.join(", ")}`),
  );
}
