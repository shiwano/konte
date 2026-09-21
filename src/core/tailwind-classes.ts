/// <reference path="../md.d.ts" />
import { __unstable__loadDesignSystem } from "tailwindcss";
import tailwindCss from "tailwindcss/index.css" with { type: "text" };
import { KonteError } from "./errors.js";

type DesignSystem = Awaited<ReturnType<typeof __unstable__loadDesignSystem>>;

let designSystem: Promise<DesignSystem> | undefined;

// konte's own classes: `.konte-clip` is styled by the document head, which a nested shot does not carry.
const KONTE_CLASSES = new Set(["konte-clip", "konte-subtitle"]);

const EMBEDDED_BLOCK = /<(script|style)\b[^>]*>([\s\S]*?)<\/\1>/gi;
const CLASS_ATTR = /\sclass="([^"]*)"/g;
const CLASS_SELECTOR = /\.(-?[A-Za-z_][\w-]*)/g;
const LITERAL_FONT_FAMILY = /font-family:(?!\s*var\()/;

export interface ClassSubject {
  /** What the author finds the markup by — a composition or jsxImage address. */
  label: string;
  html: string;
}

interface ClassFindings {
  label: string;
  unknown: string[];
  fontFamily: string[];
}

function decodeAttr(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function findClassProblems(subject: ClassSubject, system: DesignSystem): ClassFindings {
  // A class a `<style>` rule or an `<Animate>` selector names is the author's own, not Tailwind's.
  const selected = new Set<string>();
  const markup = subject.html.replace(EMBEDDED_BLOCK, (_, _tag: string, body: string) => {
    for (const match of body.matchAll(CLASS_SELECTOR)) selected.add(match[1]!);
    return "";
  });

  const classes = new Set<string>();
  for (const match of markup.matchAll(CLASS_ATTR)) {
    for (const name of decodeAttr(match[1]!).split(/\s+/)) {
      if (name && !KONTE_CLASSES.has(name) && !selected.has(name)) classes.add(name);
    }
  }

  const candidates = [...classes];
  const css = system.candidatesToCss(candidates);
  const unknown: string[] = [];
  const fontFamily: string[] = [];
  candidates.forEach((name, i) => {
    const rule = css[i];
    if (rule == null) unknown.push(name);
    else if (LITERAL_FONT_FAMILY.test(rule)) fontFamily.push(name);
  });
  return { label: subject.label, unknown, fontFamily };
}

function formatFindings(
  findings: readonly ClassFindings[],
  pick: "unknown" | "fontFamily",
): string {
  return findings
    .filter((f) => f[pick].length > 0)
    .map((f) => `    ${f.label}: ${f[pick].join(", ")}`)
    .join("\n");
}

// Abort with COMPOSITION_CLASS_INVALID when rendered markup carries a class Tailwind generates
// nothing for, or one that sets a font family the export cannot embed.
export async function assertTailwindClasses(subjects: readonly ClassSubject[]): Promise<void> {
  if (subjects.length === 0) return;
  designSystem ??= __unstable__loadDesignSystem(tailwindCss);
  const system = await designSystem;
  const findings = subjects.map((s) => findClassProblems(s, system));

  const blocks: string[] = [];
  if (findings.some((f) => f.unknown.length > 0)) {
    blocks.push(
      `  Tailwind generates nothing for these classes — fix the typo, or name a class of your own in a <style> rule or an <Animate> selector:\n${formatFindings(findings, "unknown")}`,
    );
  }
  if (findings.some((f) => f.fontFamily.length > 0)) {
    blocks.push(
      `  A class cannot set a font family — declare it on direction.policy.fonts; the export embeds faces by reading the HTML, and a class's CSS does not exist until the browser has run:\n${formatFindings(findings, "fontFamily")}`,
    );
  }
  if (blocks.length === 0) return;

  throw new KonteError(
    "COMPOSITION_CLASS_INVALID",
    `Rendered markup has invalid classes:\n${blocks.join("\n")}`,
  );
}
