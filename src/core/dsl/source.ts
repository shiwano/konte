import { KonteError } from "../errors.js";
import { chunkKind, chunkPositionPrefix, parseAt, sceneChunk } from "../source-locator.js";

// One scene of a chunk, as the original has it: where (`at`), the place and who is present by the
// names the original calls them, what changes in it (one sentence), whether it is mostly interior
// narration, and whether it runs on into the next chunk.
export type SourceScene = {
  at: string;
  place: string;
  present: readonly string[];
  change: string;
  interior?: boolean;
  continues?: boolean;
};

// How a person or a place looks, where the original says so: a quote of the text, or a description
// of the page or frame for a comic or a clip.
export type SourceLook = { of: string; at: string; text: string };

// A piece of text on a comic page, in reading order: a balloon spoken, or a thought unspoken, by
// the name the original calls its speaker (null where the page does not settle who), a caption box,
// a sound effect, or lettering drawn into the picture (a sign, a letter).
export type SourcePanelText =
  | { kind: "balloon" | "thought"; by: string | null; text: string }
  | { kind: "caption" | "sfx" | "sign"; text: string };

export type SourcePanel = { picture: string; text: readonly SourcePanelText[] };

// The digest of one chunk (`source/digest/<chunk>.ts`), written by a reader. A comic's carries
// `pages`: every page of the chunk, its panels in reading order.
export type SourceChunk<C extends string = string, S extends string = string> = {
  readonly chunk: C;
  readonly scenes: Readonly<Record<S, SourceScene>>;
  readonly looks: readonly SourceLook[];
  readonly pages?: Readonly<Record<string, readonly SourcePanel[]>>;
  readonly notes?: string;
};

type PagesOf<C extends string> = C extends `${infer V}.b${number}`
  ? { pages: Readonly<Record<`${V}.p${number}`, readonly SourcePanel[]>> }
  : { pages?: never };

type SceneKeys<C extends string, S> = {
  [K in keyof S]: K extends `${C}.s${number}` ? SourceScene : never;
};

function validateAt(chunk: string, at: string, where: string, errors: string[]): void {
  const kind = chunkKind(chunk)!;
  const parsed = parseAt(kind, at);
  if (!parsed) {
    errors.push(`${where}: at "${at}" is no ${kind} locator`);
    return;
  }
  const prefix = chunkPositionPrefix(chunk);
  if (parsed.prefix !== prefix) {
    errors.push(`${where}: at "${at}" is outside chunk ${chunk} — it is written ${prefix}.p<n>`);
  }
}

export function defineSourceChunk<
  const C extends string,
  const S extends Record<string, SourceScene>,
>(
  digest: {
    chunk: C;
    scenes: S & SceneKeys<C, S>;
    looks?: readonly SourceLook[];
    notes?: string;
  } & PagesOf<C>,
): SourceChunk<C, Extract<keyof S, string>> {
  const { chunk } = digest;
  if (!chunkKind(chunk)) {
    throw new KonteError("VALIDATION_FAILED", `defineSourceChunk: "${chunk}" is no chunk id`);
  }
  const errors: string[] = [];
  for (const [id, scene] of Object.entries(digest.scenes as Record<string, SourceScene>)) {
    if (sceneChunk(id) !== chunk) errors.push(`scene "${id}" is not ${chunk}.s<n>`);
    validateAt(chunk, scene.at, `scene ${id}`, errors);
  }
  for (const look of digest.looks ?? []) validateAt(chunk, look.at, `look of ${look.of}`, errors);
  const pages = (digest as { pages?: Record<string, readonly SourcePanel[]> }).pages;
  if (chunkKind(chunk) === "comic") {
    if (pages === undefined) errors.push("a comic chunk transcribes its pages in `pages`");
    for (const [at, panels] of Object.entries(pages ?? {})) {
      validateAt(chunk, at, `page ${at}`, errors);
      if (parseAt("comic", at)?.from !== parseAt("comic", at)?.to) {
        errors.push(`page ${at}: one page per key, never a range`);
      }
      if (panels.length === 0) errors.push(`page ${at} holds no panel`);
    }
  } else if (pages !== undefined) {
    errors.push("only a comic chunk transcribes `pages`");
  }
  if (errors.length > 0) {
    throw new KonteError(
      "VALIDATION_FAILED",
      `digest of ${chunk} has ${errors.length} error(s)`,
      errors,
    );
  }
  return {
    chunk,
    scenes: digest.scenes,
    looks: digest.looks ?? [],
    ...(pages !== undefined ? { pages } : {}),
    ...(digest.notes !== undefined ? { notes: digest.notes } : {}),
  };
}
