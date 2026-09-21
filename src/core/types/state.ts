import { z } from "zod";

const DeliveryTargetSchema = z.object({
  scale: z.number(),
  width: z.number(),
  height: z.number(),
});

// What one ffprobe measured on a variant's committed output, recorded when the file lands so no
// later reader probes it again. Keyed to the bytes at `outputHash`: whatever replaces or removes
// them clears it.
//
// A missing record means UNMEASURED (a failed probe, a file with no media extension); a real absence
// is a null INSIDE a record — a silent video's `audio`. So a half-measured file is dropped whole:
// a video's `fps` is a number, or there is no record.
//
// `kind` is `inferMediaType`'s, konte's own image/video/audio axis, not a second one sniffed from the
// streams — a still is a one-frame video stream to ffprobe, so the split is konte's to make.
// What EBU R128 measured on the file's audio, so a later mix levels the take without re-decoding
// it. Absent means UNMEASURED (the loudness pass failed, or the record predates it), which a mix
// levels at unity. `integratedLufs` is null for content too short or too quiet to hold one.
// `leadInSec` is the silence before the sound begins, absent on a record that predates it.
const AudioLoudnessSchema = z.object({
  integratedLufs: z.number().nullable(),
  truePeakDb: z.number(),
  leadInSec: z.number().nonnegative().optional(),
});

export const VariantMediaSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("image"),
    width: z.number().positive(),
    height: z.number().positive(),
  }),
  z.object({
    kind: z.literal("video"),
    width: z.number().positive(),
    height: z.number().positive(),
    fps: z.number().positive(),
    durationSec: z.number().positive(),
    // Null when the file carries no audio stream.
    audio: z
      .object({
        channels: z.number().positive(),
        sampleRate: z.number().positive(),
        loudness: AudioLoudnessSchema.optional(),
      })
      .nullable(),
  }),
  z.object({
    kind: z.literal("audio"),
    durationSec: z.number().positive(),
    channels: z.number().positive(),
    sampleRate: z.number().positive(),
    loudness: AudioLoudnessSchema.optional(),
  }),
]);

export type VariantMedia = z.infer<typeof VariantMediaSchema>;

// The reviewer's verdict on one take. `none` is undecided — nobody has looked, or nobody has
// settled it. `dismissed` is decided-against: seen beside the take that was accepted and not
// chosen, or thrown out on its own by `konte dismiss`. What is wrong with a take lives in a
// feedback comment, never here.
//
// Either way it is written by a decision, never inferred, so "I decided against this" is told apart
// from "I have not looked yet" with no timestamps compared.
//
// A dismissed take is out of resolution (`resolveCore`) and out of generation's skip test
// (`assetSkipReason`): dismissing every take at an address means the same thing as having none.
// The file stays on disk until `clean`/`prune` takes it.
export const VariantStatusSchema = z.enum(["none", "accepted", "dismissed"]);

export type VariantStatus = z.infer<typeof VariantStatusSchema>;

export const VariantStateSchema = z.object({
  status: VariantStatusSchema,
  file: z.string().nullable(),
  definitionHash: z.string().nullable().default(null),
  outputHash: z.string().nullable().default(null),
  // What ffprobe measured on the file at `outputHash` (see VariantMediaSchema). Present or absent,
  // never null: a failed measurement leaves no record, so a later reader retries. Cleared when the
  // bytes it described are replaced.
  media: VariantMediaSchema.optional(),
  // When the variant was reserved (ISO 8601). Drives "newest" selection in
  // `selectResolvedVariant`.
  createdAt: z.string(),
  // When the variant's file first became available (ISO 8601) — generation/materialization
  // committed an output. Distinct from `createdAt` (reservation, stamped before the file exists),
  // so "ready since the review" can be told apart from "reserved before it but finished after".
  // Absent/null until ready; a variant with a file always has it set.
  readyAt: z.string().nullable().optional(),
  // When this variant's `status` was last settled (ISO 8601) — the human's decision moment, for an
  // accept and a dismissal alike. Distinct from `readyAt` (when the file landed). Null while
  // undecided. Nothing branches on it: a verdict is read from `status`, never from a comparison of
  // times.
  decidedAt: z.string().nullable().optional(),
  inputFingerprints: z.record(z.string(), z.string()).default({}),
  // Upstream address -> the output hash a human accept kept this take against, written when the
  // take was accepted while input-stale — or, for an input konte re-makes (a deterministic
  // intermediate, a stem), a `keptViaMarker` naming the upstream takes it is made from. Read by
  // staleness only while the take is accepted; `inputFingerprints` stays the record of what the take
  // was made from.
  keptInputs: z.record(z.string(), z.string()).optional(),
  // The seed injected into this generation, captured so a variant can be reproduced (a future
  // `konte restore`). One seed per job, reused across every `__konte:seed__` occurrence; absent
  // when the definition declares no seed placeholder (or for non-generation variants). Not a
  // secret, unlike `${VAR}` values, so persisting it is allowed.
  seed: z.number().nullable().optional(),
  // `#delivery` variants only (absent on every other variant): the upscale target (scale +
  // absolute dims) resolved when the upscale was submitted. A per-layer target's dims come from
  // the source's ffprobed size, so snapshotting them lets the variant's definition hash be re-derived
  // from the SAME dims at export time — never re-probed — preventing a freshly-built upscale from
  // being judged definition-stale against a slightly different later probe.
  deliveryTarget: DeliveryTargetSchema.nullable().optional(),
  // Patch variants only: the variant this one was produced from, by applying `patches/<id>.ts` to
  // it. Absent on every other variant. The lineage it forms decides what is reviewable — a variant
  // with a descendant is no longer a review candidate, it is the "before" of one — and what gets
  // deleted together (a lineage is cleaned as a unit; see `collectDescendants`).
  derivedFrom: z.string().nullable().optional(),
  // Patch variants only: the hash of the patch definition that produced this variant. A second
  // staleness axis alongside `definitionHash` — editing the patch script ages out its old output
  // exactly as editing animatic.tsx ages out a generated one. `definitionHash` meanwhile is
  // INHERITED from the source, so an address-level definition change stales the whole lineage.
  patchHash: z.string().nullable().optional(),
  // The address's first take, generated on its adapter's `turbo` inputs (see `isTurboTake`). Decided
  // when the variant is reserved; absent on every other variant.
  turbo: z.literal(true).optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export type VariantState = z.infer<typeof VariantStateSchema>;

export const AssetStateSchema = z.object({
  variants: z.record(z.string(), VariantStateSchema).optional(),
});

export type AssetState = z.infer<typeof AssetStateSchema>;

export const SCHEMA_VERSION = 1;

// One part's sign-off: the part's hash when the human accepted it (see `directionPartHashes`), and
// when. Once the part hashes to something else, this acceptance is about words that no longer exist.
const DirectionPartAcceptanceSchema = z.object({
  partHash: z.string(),
  acceptedAt: z.string(),
});

// The human's sign-off on the direction. Variant-less and project-wide (unlike every
// per-asset accept in `assets`), so it lives at the top level.
//
// `parts` is the verdict, one entry per part address: fixing the logline re-blocks the logline
// alone, and every other part stays signed off. The gate is satisfied only when `parts` covers the
// live part set exactly — key for key — so a part that was DELETED since it was accepted (its key
// lingers with nothing to hash against) re-blocks just as a rewritten one does.
//
// `whole` is the same reviewer's verdict on the direction AS A WHOLE, and its PRESENCE is what
// narrows the spend gate (`direction-acceptance.ts`). Its `hash` is the short-circuit for the
// part-by-part comparison — the whole-direction `directionHash` stamped while `parts` covers the
// live set exactly, null while it does not. Whenever the hash still matches the live direction, no
// part can have changed (`projectDirection` subsumes every part hash), so the gate answers without
// walking the tree. `acceptedAt` survives the hash going null; emptying `parts`
// (`konte accept direction --off`) clears the record, the only way back to "never accepted".
export const DirectionWholeAcceptanceSchema = z.object({
  hash: z.string().nullable(),
  acceptedAt: z.string(),
});

export type DirectionWholeAcceptance = z.infer<typeof DirectionWholeAcceptanceSchema>;

export const DirectionAcceptanceSchema = z.object({
  parts: z.record(z.string(), DirectionPartAcceptanceSchema).default({}),
  whole: DirectionWholeAcceptanceSchema.nullable().default(null),
});

export type DirectionAcceptance = z.infer<typeof DirectionAcceptanceSchema>;

export const KonteStateSchema = z.object({
  schemaVersion: z.number(),
  assets: z.record(z.string(), AssetStateSchema),
  // Absent/null = nothing accepted. A state written before acceptance became per-part carries the
  // old whole-page shape, whose keys strip away to leave an empty `parts` — so it reads as never
  // accepted and the direction is re-reviewed once, which is the correct outcome for a verdict whose
  // parts were never recorded.
  directionAcceptance: DirectionAcceptanceSchema.nullable().optional(),
});

export type KonteState = z.infer<typeof KonteStateSchema>;
