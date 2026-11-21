import type { BuiltinLens, Pleasure } from "../lenses.js";
import type { ScriptLine } from "../types/script.js";
import type { ShotJoin } from "../types/definition.js";
import type { LensSpec } from "../direction-check.js";
import type { WaivableCode } from "../direction-findings.js";
import type { DirectionShotTuple } from "./animatic-builders.js";
import type {
  Character,
  DirectionBrief,
  DirectionLyrics,
  DirectionPolicy,
  Framing,
  Location,
  Prop,
  Setup,
  View,
  Voice,
} from "./direction.js";
import type { ValidatedIdentifier } from "./validate-identifier.js";

// `const` inference produces readonly tuples, which are NOT assignable to the mutable arrays of
// `Direction` — so `<const D extends Direction>` would reject every literal. Constrain to a
// structural shape whose arrays are `readonly` instead: it still type-checks `role` and the span,
// but never widens the inferred literal ids. Which span a shot owes is `ConstrainSpan`'s.
type NarrativeShotShape = {
  id: string;
  kind?: "shot";
  role: string;
  action: string;
  setup: string;
  duration?: number;
  beats?: number;
  script?: readonly ScriptLine[];
  telop?: readonly string[];
  // Left as `readonly string[]` rather than narrowed to the roster keys: `<const D>` captures the
  // literal tuple either way (that is what `LineupOf` reads), and `ConstrainIds` re-blames each
  // element at its own position.
  lineup: readonly string[];
  lineupTo?: readonly string[];
  passing?: readonly string[];
  props?: readonly string[];
  join?: ShotJoin;
  cutin?: CutinShape;
  coverage?: true;
};
type CutinShape = {
  setup: string;
  lineup: readonly string[];
  lineupTo?: readonly string[];
  passing?: readonly string[];
  props?: readonly string[];
  join?: ShotJoin;
};
// The camera fields a graphic shot does not have are `never` rather than merely absent: a const
// literal is not checked for excess properties against a generic constraint, so without these a
// `setup` written on a graphic shot would be accepted and silently ignored.
type GraphicShotShape = {
  id: string;
  kind: "graphic";
  role: string;
  action: string;
  duration?: number;
  beats?: number;
  script?: readonly ScriptLine[];
  telop?: readonly string[];
  cutin?: CutinShape;
  setup?: never;
  lineup?: never;
  lineupTo?: never;
  passing?: never;
  props?: never;
  join?: never;
  coverage?: never;
};
type AsideShotShape = {
  id: string;
  kind: "aside";
  label: string;
  duration?: number;
  beats?: number;
  telop?: readonly string[];
  cutin?: never;
};
type ShotShape = NarrativeShotShape | GraphicShotShape | AsideShotShape;
type NodeBodyShape = { shots: readonly ShotShape[] } | { sequences: readonly ChildNodeShape[] };
type NodeCommonShape = {
  lens: string;
  pleasure: Pleasure;
  waivers?: DirectionViolation<"konte: a waiver belongs in the direction's top-level `waivers`, not on a sequence">;
};
// A child node is an item in its parent's arc, so it carries `id`/`role`/`synopsis`; the recursion
// bottoms out at a leaf (a body of `shots`).
type ChildNodeShape = NodeCommonShape & {
  id: string;
  role: string;
  synopsis: string;
} & NodeBodyShape;
// The root node has no parent, so no `id`/`role`/`synopsis`; its `pleasure` is the piece's own.
type RootNodeShape = NodeCommonShape & NodeBodyShape;

export type DirectionInput = {
  brief: DirectionBrief;
  characters: Record<string, Character>;
  props?: Record<string, Prop>;
  locations: Record<string, Location>;
  setups: Record<string, Setup>;
  narrator?: Voice;
  lenses?: readonly LensSpec<string>[];
  policy: DirectionPolicy;
  lyrics?: DirectionLyrics;
  waivers?: Record<string, string>;
  sequence: RootNodeShape;
};

// Every id in the direction is an address part (`reference:<id>`, `<stage>:shot.<id>.<name>`), so it
// must be an identifier — `a-z A-Z 0-9 - _`. These constrain each id-bearing position of the inferred
// literal at the type level: `defineDirection` takes `D & ConstrainIds<D>`, so `D` still infers from
// the bare argument (keeping ShotIdOf/DirectionIdTuple exact) while `ConstrainIds<D>` re-blames any bad
// id at its own position. A non-literal `string` id passes through (caught at runtime instead).
type ConstrainRosterIds<R> = R & {
  [K in keyof R & string as ValidatedIdentifier<K> extends string
    ? never
    : K]: ValidatedIdentifier<K>;
};
// The ids a `lineup` may name: the characters roster — a prop is not lined up, since the row has one
// axis and a prop sits in front of or behind as often as beside. A roster typed `Record<string, …>`
// rather than a literal widens this to `string`, so a computed direction passes through here and is
// caught by `lineup-unknown-id`.
type SubjectIdOf<D extends DirectionInput> = Extract<keyof D["characters"], string>;
// A branded error carrying the offending id in a required property KEY, the way
// `IdentifierViolation` does — an OBJECT rather than the roster union, because a lineup is checked
// through an intersection with the tuple the author wrote, and a `never` element collapses the whole
// tuple to `never` and blames every id in it.
type LineupSubjectViolation<T extends string> = {
  [P in `konte: lineup id "${T}" is not a declared character id`]: never;
};
// Re-blame each element of a lineup at its own position, so a typo draws its line where it was
// typed rather than on the shot.
type ConstrainLineup<L, Subjects extends string> = {
  // A widened `string` element passes through, exactly as `Identifier` lets one through: a computed
  // list has no literal to blame, and `lineup-unknown-id` is the receiver for it.
  [K in keyof L]: string extends L[K]
    ? L[K]
    : L[K] extends Subjects
      ? L[K]
      : L[K] extends string
        ? LineupSubjectViolation<L[K]>
        : never;
};
// A `lineupTo` equal to the `lineup` says the frame ends where it began, which leaving it out
// already says. Branded in the `lineupTo` position, the way `HoldsRequired` brands `holds`. A
// widened tuple on either side passes through — two `readonly string[]`s are mutually assignable,
// and a computed order has no literal to blame — and `lineup-vacuous` receives it.
// The names a direction's own `lenses` declares. `resolveLens` prefers one of these over the built-in
// of the same name, and `defineLens` widens its name to `string` — which could be any built-in's.
type DeclaredLensNameOf<D> = D extends { lenses: readonly (infer L)[] }
  ? L extends { name: infer N }
    ? N
    : never
  : never;
// The roles a node's lens declares, read off the built-in registry's literals. A name a declared lens
// could shadow, a name no built-in has, and a widened name all answer `string` — the pass-through a
// widened id takes, with `lens-role-mismatch` as the receiver.
type LensRolesOf<Name, Declared> = string extends Name
  ? string
  : [Declared] extends [never]
    ? BuiltinLensRolesOf<Name>
    : [Name] extends [Declared]
      ? string
      : BuiltinLensRolesOf<Name>;
type BuiltinLensRolesOf<Name> =
  Extract<BuiltinLens, { name: Name }> extends infer L
    ? [L] extends [never]
      ? string
      : L extends { roles: infer B extends readonly { role: string }[] }
        ? B[number]["role"]
        : string
    : string;
// An item's `role` against the roles its parent's lens declares, blamed at the role itself. A node
// carrying none (the root, an aside) has nothing to blame.
type ConstrainRole<Item, Roles extends string> = Item extends { role: infer R }
  ? string extends R
    ? unknown
    : string extends Roles
      ? unknown
      : [R] extends [Roles]
        ? unknown
        : {
            role: DirectionViolation<`konte: "${R & string}" is not a role this node's lens declares`>;
          }
  : unknown;

// An array whose contents the type does not know — `string[]`, `readonly ScriptLine[]` — rather than a
// tuple. Read off `length`, which a tuple carries as a literal: a `readonly T[]` guard alone misses a
// mutable `T[]`, since a readonly array is not assignable to a mutable one.
type IsWidenedArray<A> = A extends readonly unknown[]
  ? number extends A["length"]
    ? true
    : false
  : false;
// A branded error in the offending field's own position, carrying its message in the type ARGUMENT
// so the compiler prints the advice rather than an alias name — the form `WithinViolation` takes.
type DirectionViolation<M extends string> = { [P in M]: never };
// Every key of the literal against the keys its shape declares, at every depth — a const literal is
// not checked for excess properties against a generic constraint, so without this a misspelled or
// removed field would be accepted and silently ignored. A union shape admits the keys of any member;
// a `Record<string, …>` roster admits every key. Only the path down to an unknown key is constrained
// — everything else is `unknown` — so the intersection leaves the other constraints' errors where
// they land.
export type ConstrainKnownFields<V, S> =
  HasUnknownField<V, S> extends true
    ? V extends readonly unknown[]
      ? { [I in keyof V]: ConstrainKnownFields<V[I], ElementShapeOf<S>> }
      : {
          [K in keyof V as K extends ShapeKeyOf<NonNullable<S>>
            ? HasUnknownField<V[K], ShapeValueOf<NonNullable<S>, K>> extends true
              ? K
              : never
            : K]: K extends ShapeKeyOf<NonNullable<S>>
            ? ConstrainKnownFields<V[K], ShapeValueOf<NonNullable<S>, K>>
            : DirectionViolation<`konte: "${K & string}" is not a field konte reads here`>;
        }
    : unknown;
// A value as wide as its shape (a computed direction) has no key to blame, and walking it would
// recurse through the arc tree's own recursive shape.
type HasUnknownField<V, S> = V extends
  | string
  | number
  | boolean
  | bigint
  | symbol
  | null
  | undefined
  ? false
  : [NonNullable<S>] extends [V]
    ? false
    : V extends readonly unknown[]
      ? true extends { [I in keyof V]: HasUnknownField<V[I], ElementShapeOf<S>> }[number]
        ? true
        : false
      : V extends object
        ? NonNullable<S> extends readonly unknown[] | string | number | boolean
          ? false
          : true extends {
                [K in keyof V]-?: K extends ShapeKeyOf<NonNullable<S>>
                  ? HasUnknownField<V[K], ShapeValueOf<NonNullable<S>, K>>
                  : true;
              }[keyof V]
            ? true
            : false
        : false;
type ElementShapeOf<S> = NonNullable<S> extends readonly (infer E)[] ? E : unknown;
type ShapeKeyOf<S> = S extends unknown ? keyof S : never;
type ShapeValueOf<S, K> = S extends unknown ? (K extends keyof S ? S[K] : never) : never;
type ConstrainLineupTo<F, LT> = F extends { lineup: infer L extends readonly string[] }
  ? IsWidenedArray<L> extends true
    ? unknown
    : IsWidenedArray<LT> extends true
      ? unknown
      : [L] extends [LT]
        ? [LT] extends [L]
          ? {
              lineupTo: DirectionViolation<"konte: this `lineupTo` is the `lineup` again — write the order the shot leaves behind, or drop it">;
            }
          : unknown
        : unknown
  : unknown;
// The two lineup positions of one frame, re-blamed per element. A main frame and a cutin carry the
// same pair.
type FrameEndpointIds<F> =
  | (F extends { lineup: readonly (infer I extends string)[] } ? I : never)
  | (F extends { lineupTo: readonly (infer I extends string)[] } ? I : never);
type ConstrainPassing<F, P, Subjects extends string> = {
  [K in keyof P]: P[K] extends string
    ? string extends P[K]
      ? P[K]
      : P[K] extends Subjects
        ? string extends FrameEndpointIds<F>
          ? P[K]
          : P[K] extends FrameEndpointIds<F>
            ? DirectionViolation<"konte: a passing character is absent from both `lineup` and `lineupTo`">
            : P[K]
        : DirectionViolation<`konte: "${P[K]}" is not a declared character`>
    : P[K];
};
type ConstrainFrameLineups<F, Subjects extends string> = (F extends {
  lineup: infer L extends readonly string[];
}
  ? { lineup: ConstrainLineup<L, Subjects> }
  : unknown) &
  (F extends { lineupTo: infer L extends readonly string[] }
    ? { lineupTo: ConstrainLineup<L, Subjects> } & ConstrainLineupTo<F, L>
    : unknown) &
  (F extends { passing: infer P } ? { passing: ConstrainPassing<F, P, Subjects> } : unknown);

// The ids a frame's `props` may name, and whether every frame owes the field: a literal roster with
// at least one key. A widened roster answers `string` and owes nothing here — `props-missing` and
// `props-unknown-id` receive it.
type PropIdOf<D extends DirectionInput> = D extends { props: infer P }
  ? Extract<keyof P, string>
  : never;
type PropsViolation<T extends string> = {
  [P in `konte: props id "${T}" is not a declared prop id`]: never;
};
type ConstrainProps<P, Ids extends string> = {
  [K in keyof P]: string extends P[K]
    ? P[K]
    : P[K] extends Ids
      ? P[K]
      : P[K] extends string
        ? PropsViolation<P[K]>
        : never;
};
type ConstrainFrameProps<F, Ids extends string> = F extends { props: infer P }
  ? { props: ConstrainProps<P, Ids> }
  : [Ids] extends [never]
    ? unknown
    : string extends Ids
      ? unknown
      : {
          props: DirectionViolation<"konte: this direction declares props, so every frame states the ones it shows in `props` — `[]` where none">;
        };

// A shot's span is a window the render cuts the take to, so it lands on the 0.5s grid every legal
// fps divides whole. Read off the literal's decimal digits — a type does no arithmetic — so a
// negative or computed value passes through to `off-grid-duration`. An aside is outside the check
// (`checkDurations` walks `collectArcShots`), so it is outside this too.
type ConstrainDuration<B> = B extends { kind: "aside" }
  ? unknown
  : B extends { duration: infer N }
    ? number extends N
      ? unknown
      : `${N & number}` extends `${string}.${infer Decimals}`
        ? Decimals extends "5"
          ? unknown
          : {
              duration: DirectionViolation<"konte: a shot's duration is a multiple of 0.5s, so it lands a whole frame at every fps">;
            }
        : [N] extends [0]
          ? {
              duration: DirectionViolation<"konte: a shot's duration is a multiple of 0.5s, so it lands a whole frame at every fps">;
            }
          : unknown
    : unknown;
// Which span a shot owes: `beats` on a direction with `policy.song`, `duration` without one, and
// never both. A computed policy (`Clocked` widened to `boolean`) checks only the grid of what was
// written and leaves which one to `shot-span-mismatch`.
type ConstrainSpan<B, Clocked extends boolean> = boolean extends Clocked
  ? ConstrainDuration<B>
  : Clocked extends true
    ? (B extends { duration: number }
        ? {
            duration: DirectionViolation<"konte: this direction is cut to policy.song, so a shot's span is `beats`, not `duration`">;
          }
        : unknown) &
        (B extends { beats: number }
          ? unknown
          : {
              beats: DirectionViolation<"konte: this direction is cut to policy.song, so every shot declares its span in `beats`">;
            })
    : (B extends { beats: number }
        ? {
            beats: DirectionViolation<"konte: `beats` counts on policy.song, which this direction does not declare — a shot's span is `duration` in seconds">;
          }
        : unknown) &
        (B extends { duration: number }
          ? ConstrainDuration<B>
          : {
              duration: DirectionViolation<"konte: every shot declares its span — `duration` in seconds">;
            });

// The one sentence a shot lands, and a child node's own summary. Empty is `empty-synopsis`; a
// whitespace-only string has no literal form to catch, so that one stays the finding's.
type ConstrainAction<B> = B extends { action: infer A }
  ? [A] extends [""]
    ? {
        action: DirectionViolation<"konte: `action` is the one thing this shot lands — it cannot be empty">;
      }
    : unknown
  : unknown;
type ConstrainSynopsis<N> = N extends { synopsis: infer S }
  ? [S] extends [""]
    ? {
        synopsis: DirectionViolation<"konte: `synopsis` is what this act of the arc IS — it cannot be empty">;
      }
    : unknown
  : unknown;

// The shot just before `Id` on the clock, asides included, over the whole arc flattened. `null` at
// the first shot; `never` where the tuple is widened or the id is not in it, which passes through.
type ShotBefore<Shots, Id extends string, Prev = null> = Shots extends readonly [
  infer H extends { id: string },
  ...infer T extends readonly { id: string }[],
]
  ? H extends { id: Id }
    ? Prev
    : ShotBefore<T, Id, H>
  : never;
type SameSetup<PS, S> = string extends PS
  ? true
  : string extends S
    ? true
    : [PS] extends [S]
      ? [S] extends [PS]
        ? true
        : false
      : false;
// Whether a frame on setup `S` could run on from shot `P` in one take: `P` is a narrative shot on
// the same declared setup. A pass-through `never` (a computed direction) answers true.
type RunsOnFrom<P, S> = [P] extends [never]
  ? true
  : P extends null
    ? false
    : P extends { kind: "aside" | "graphic" }
      ? false
      : P extends { setup: infer PS }
        ? SameSetup<PS, S>
        : false;
type CutinRunsOnFrom<P, S> = [P] extends [never]
  ? true
  : P extends { cutin: { setup: infer PS } }
    ? SameSetup<PS, S>
    : false;
type IsCoverage<P> = [P] extends [never] ? false : P extends { coverage: true } ? true : false;
// `join-impossible`, on a literal `continuous`: the shot before on the clock has to be one the take
// could run on from. Blamed in the `join` position; a widened join or shot list passes through.
type ConstrainJoin<B, Shots> = B extends {
  join: "continuous";
  id: infer Id extends string;
  setup: infer S;
}
  ? IsCoverage<ShotBefore<Shots, Id>> extends true
    ? {
        join: DirectionViolation<"konte: the shot before is a coverage shot, whose camera ends wherever the model cut to, so no take runs on from it — drop the join, or declare a jump">;
      }
    : RunsOnFrom<ShotBefore<Shots, Id>, S> extends true
      ? unknown
      : {
          join: DirectionViolation<"konte: `continuous` is one unbroken take with the shot before it on the clock, so that shot is a narrative shot on this same setup — declare a jump, or drop the join">;
        }
  : unknown;
// A coverage shot's board is its opening frame alone, so nothing declares where it ends or what a
// second camera over it holds.
type ConstrainCoverage<B> = B extends { coverage: true }
  ? (B extends { lineupTo: readonly string[] }
      ? {
          lineupTo: DirectionViolation<"konte: a coverage shot's frame after the opening is the model's cut, so it declares no `lineupTo`">;
        }
      : unknown) &
      (B extends { cutin: object }
        ? {
            cutin: DirectionViolation<"konte: a coverage shot cuts inside its own take, so it carries no `cutin`">;
          }
        : unknown)
  : unknown;
type ConstrainCutinJoin<B, Shots> = B extends {
  id: infer Id extends string;
  cutin: { join: "continuous"; setup: infer S };
}
  ? CutinRunsOnFrom<ShotBefore<Shots, Id>, S> extends true
    ? unknown
    : {
        cutin: {
          join: DirectionViolation<"konte: a `continuous` cutin runs on from the cutin over the shot before it on the clock, so that shot carries a cutin on this same setup — declare a jump, or drop the join">;
        };
      }
  : unknown;
type ConstrainShotIds<
  Arr,
  Subjects extends string,
  PropIds extends string,
  Roles extends string,
  Shots,
  Clocked extends boolean,
> = {
  [K in keyof Arr]: Omit<Arr[K], "id" | "lineup" | "lineupTo" | "passing" | "props" | "cutin"> & {
    id: ValidatedIdentifier<Arr[K] extends { id: infer I extends string } ? I : never>;
  } & ConstrainFrameLineups<Arr[K], Subjects> &
    (Arr[K] extends { kind: "graphic" | "aside" }
      ? unknown
      : ConstrainFrameProps<Arr[K], PropIds>) &
    ConstrainSpan<Arr[K], Clocked> &
    ConstrainAction<Arr[K]> &
    ConstrainRole<Arr[K], Roles> &
    ConstrainJoin<Arr[K], Shots> &
    ConstrainCutinJoin<Arr[K], Shots> &
    ConstrainCoverage<Arr[K]> &
    (Arr[K] extends { cutin: infer C }
      ? {
          cutin: Omit<C, "lineup" | "lineupTo" | "passing" | "props"> &
            ConstrainFrameLineups<C, Subjects> &
            ConstrainFrameProps<C, PropIds>;
        }
      : unknown);
};
// Preserve the full node (so the sibling-array covariance check still sees every field) and override
// only the id-bearing positions, recursing through both node bodies to any depth. `Shots` is the
// whole arc flattened, for the checks that read the shot before on the clock.
type ConstrainNodeIds<
  N,
  Subjects extends string,
  PropIds extends string,
  Lenses,
  Shots,
  Clocked extends boolean,
> = N &
  (N extends { id: infer I extends string } ? { id: ValidatedIdentifier<I> } : unknown) &
  ConstrainSynopsis<N> &
  (N extends { shots: infer S }
    ? {
        shots: ConstrainShotIds<
          S,
          Subjects,
          PropIds,
          LensRolesOf<LensNameOf<N>, Lenses>,
          Shots,
          Clocked
        >;
      }
    : unknown) &
  (N extends { sequences: infer Q }
    ? {
        sequences: ConstrainSequenceIds<
          Q,
          Subjects,
          PropIds,
          Lenses,
          LensRolesOf<LensNameOf<N>, Lenses>,
          Shots,
          Clocked
        >;
      }
    : unknown);
type LensNameOf<N> = N extends { lens: infer L } ? L : string;
// A child node is an item in its PARENT's arc, so its own `role` is blamed against the parent's
// lens while it recurses carrying its own.
type ConstrainSequenceIds<
  Arr,
  Subjects extends string,
  PropIds extends string,
  Lenses,
  ParentRoles extends string,
  Shots,
  Clocked extends boolean,
> = {
  [K in keyof Arr]: ConstrainNodeIds<Arr[K], Subjects, PropIds, Lenses, Shots, Clocked> &
    ConstrainRole<Arr[K], ParentRoles>;
};
// A cast voice's `id` is an address part like any other, but it sits in a value rather than a key, so
// it is blamed at its own position instead of through `ConstrainRosterIds`.
type ConstrainVoiceId<V> = V extends { id: infer I extends string }
  ? { id: ValidatedIdentifier<I> }
  : unknown;
type ConstrainCastVoiceIds<R> = {
  [K in keyof R]: R[K] &
    (R[K] extends { voice: infer V } ? { voice: ConstrainVoiceId<V> } : unknown);
};
// A landmark id is an id like any other, blamed inside the location that declares it. A view's
// `holds` names landmarks of its own location.
type ConstrainLandmarkIds<R> = {
  [K in keyof R]: R[K] &
    (R[K] extends { landmarks: infer L } ? { landmarks: ConstrainRosterIds<L> } : unknown) &
    (R[K] extends { landmarks: infer L; views: infer V }
      ? string extends keyof L
        ? unknown
        : {
            views: {
              [W in keyof V]: V[W] extends { holds: infer H }
                ? {
                    holds: ConstrainHolds<H, Extract<keyof L, string>, Extract<keyof L, string>, W>;
                  }
                : unknown;
            };
          }
      : unknown);
};
// The landmark ids one setup's `holds` may name: those of the location it is set in, reached through
// its own `location` literal. A widened roster or an unknown place answers `string`, so a computed
// direction passes through here and is caught by `holds-unknown-id`.
type LandmarkIdOf<D extends DirectionInput, S> = S extends { location: infer L }
  ? L extends keyof D["locations"]
    ? D["locations"][L] extends { landmarks: infer M }
      ? Extract<keyof M, string>
      : string
    : string
  : string;
// The view a setup faces: its own literal `view`, or its window chain's root's. A framing is strictly
// narrower than its `within`, so a chain is at most three deep. Anything unresolved answers `View`.
type SetupViewOf<Setups, S, Depth extends unknown[] = []> = Depth["length"] extends 3
  ? View
  : S extends { view: infer V extends View }
    ? V
    : S extends { within: infer W extends keyof Setups }
      ? SetupViewOf<Setups, Setups[W], [...Depth, unknown]>
      : View;
// The landmark ids the view `V` of a setup's location sees. An unresolved view, or one the location
// does not declare (blamed on the `view`), answers every landmark of the place.
type SeenIdOf<D extends DirectionInput, S, V> = S extends { location: infer L }
  ? L extends keyof D["locations"]
    ? D["locations"][L] extends { views: infer VS }
      ? [V] extends [keyof VS]
        ? VS[V] extends { holds: infer H extends readonly string[] }
          ? H[number]
          : LandmarkIdOf<D, S>
        : LandmarkIdOf<D, S>
      : LandmarkIdOf<D, S>
    : string
  : string;
// The `holds` twin of `LineupSubjectViolation` — a branded object in the offending element's own
// position, so a typo draws its line where it was typed.
type HoldsLandmarkViolation<T extends string> = {
  [P in `konte: holds id "${T}" is not a landmark of this location`]: never;
};
type HoldsViewViolation<T extends string, V> = {
  [P in `konte: holds id "${T}" is not in the location's views.${V & string}.holds`]: never;
};
// `Seen` is what the frame's view sees, a subset of the place's `Landmarks`.
type ConstrainHolds<H, Landmarks extends string, Seen extends string, V> = {
  [K in keyof H]: string extends H[K]
    ? H[K]
    : H[K] extends Seen
      ? H[K]
      : H[K] extends Landmarks
        ? HoldsViewViolation<H[K], V>
        : H[K] extends string
          ? HoldsLandmarkViolation<H[K]>
          : never;
};
// An `insert` fills the frame with an object and shows no set, so it is the one framing whose
// `holds` may be empty. Every other frame carries something only its place has: an empty tuple is
// asked for a first element it cannot supply, which draws the line on the `holds` that was written.
type HoldsRequired = {
  "konte: this setup is not an insert, so `holds` must name at least one landmark": never;
};
type ConstrainSetupHolds<S, Landmarks extends string, Seen extends string, V> = S extends {
  holds: infer H;
}
  ? { holds: ConstrainHolds<H, Landmarks, Seen, V> } &
      // A computed `framing` could be `"insert"` at runtime, so it passes through here exactly as a
      // widened id does and `holds-empty` receives it — only a framing that CANNOT be an insert is
      // asked for a first element.
      (S extends { framing: infer F }
        ? "insert" extends F
          ? unknown
          : H extends readonly []
            ? { holds: readonly [HoldsRequired] }
            : unknown
        : unknown)
  : unknown;
// The framings a `within` target may take, per the framing the window itself declares. `wide` is the
// widest, and `insert` is off the axis, so both answer with nothing.
type WiderThan<F> = F extends "close" ? "wide" | "medium" : F extends "medium" ? "wide" : never;
// A branded error in the `within` position, the way `HoldsRequired` brands the `holds` one: an object
// where a string was written, so the line is drawn on the `within` that was typed.
type WithinViolation<M extends string> = { [P in M]: never };
// Every guard is written non-distributively (`[X] extends [Y]`) and lets a widened type through: a
// computed roster has no literal to blame, and the runtime `within-*` errors are the receivers.
type ConstrainWithinTarget<S, T, W extends string, F> = T extends {
  location: infer TL;
  framing: infer TF;
}
  ? S extends { location: infer SL }
    ? string extends SL
      ? unknown
      : string extends TL
        ? unknown
        : [SL] extends [TL]
          ? Framing extends TF
            ? unknown
            : [TF] extends [WiderThan<F>]
              ? unknown
              : {
                  within: WithinViolation<`konte: within "${W}" is ${TF & string}, not wider than this ${F & string}`>;
                }
          : { within: WithinViolation<`konte: within "${W}" is set in another location`> }
    : unknown
  : unknown;
type ConstrainSetupWithin<S, Setups> = S extends { within: infer W }
  ? [W] extends [null | undefined]
    ? unknown
    : string extends W
      ? unknown
      : S extends { framing: infer F }
        ? Framing extends F
          ? unknown
          : [F] extends ["insert"]
            ? { within: WithinViolation<"konte: an insert holds nothing, so it is no window"> }
            : W extends keyof Setups & string
              ? ConstrainWithinTarget<S, Setups[W], W, F>
              : W extends string
                ? { within: WithinViolation<`konte: within id "${W}" is not a declared setup`> }
                : unknown
        : unknown
  : unknown;
// A setup's literal `view` against the views its literal location declares.
type ConstrainSetupView<D extends DirectionInput, S> = S extends {
  view: infer V extends string;
  location: infer L;
}
  ? View extends V
    ? unknown
    : L extends keyof D["locations"]
      ? D["locations"][L] extends { views: infer VS }
        ? [V] extends [keyof VS]
          ? unknown
          : {
              view: DirectionViolation<`konte: view "${V}" is not one location "${L & string}" declares in \`views\``>;
            }
        : unknown
      : unknown
  : unknown;
type ConstrainSetupIds<D extends DirectionInput> = ConstrainRosterIds<D["setups"]> & {
  [K in keyof D["setups"]]: ConstrainSetupHolds<
    D["setups"][K],
    LandmarkIdOf<D, D["setups"][K]>,
    SeenIdOf<D, D["setups"][K], SetupViewOf<D["setups"], D["setups"][K]>>,
    SetupViewOf<D["setups"], D["setups"][K]>
  > &
    ConstrainSetupWithin<D["setups"][K], D["setups"]> &
    ConstrainSetupView<D, D["setups"][K]>;
};
// Whether the piece is cut to `policy.song`, read off the literal policy. A computed policy, whose
// `song` may or may not be there, is `boolean` and leaves every span to the runtime.
type ClockedOf<D extends DirectionInput> = D["policy"] extends { song: string }
  ? true
  : "song" extends keyof D["policy"]
    ? boolean
    : false;
// A key naming a code no reason cancels is blamed here; one naming no finding now is
// `waiver-stale`. A widened `string` key passes through to it.
type WaiverKey = WaivableCode | `${WaivableCode}_${string}`;
type ConstrainWaiverKeys<W> = {
  [K in keyof W & string as string extends K
    ? never
    : K extends WaiverKey
      ? never
      : K]: DirectionViolation<`konte: "${K}" names no code a waiver cancels — key it \`<code>\` or \`<code>_<subject>\` as the finding reads`>;
};
export type ConstrainIds<D extends DirectionInput> = {
  characters: ConstrainRosterIds<D["characters"]> & ConstrainCastVoiceIds<D["characters"]>;
  locations: ConstrainRosterIds<D["locations"]> & ConstrainLandmarkIds<D["locations"]>;
  setups: ConstrainSetupIds<D>;
  sequence: ConstrainNodeIds<
    D["sequence"],
    SubjectIdOf<D>,
    PropIdOf<D>,
    DeclaredLensNameOf<D>,
    DirectionShotTuple<D>,
    ClockedOf<D>
  >;
} & (D extends { waivers: infer W } ? { waivers: ConstrainWaiverKeys<W> } : unknown) &
  (D extends { props: infer P } ? { props: ConstrainRosterIds<P> } : unknown) &
  (D extends { narrator: infer N } ? { narrator: ConstrainVoiceId<N> } : unknown) &
  (D["policy"] extends { song: infer S extends string }
    ? { policy: { song: ValidatedIdentifier<S> } }
    : unknown) &
  (D extends { lyrics: infer L }
    ? ClockedOf<D> extends false
      ? {
          lyrics: DirectionViolation<"konte: `lyrics` are sung on the song policy.song names, which this direction does not declare">;
        }
      : string extends LyricSingerIdsOf<L>
        ? unknown
        : [Exclude<LyricSingerIdsOf<L>, SubjectIdOf<D>>] extends [never]
          ? unknown
          : {
              lyrics: DirectionViolation<`konte: singer "${Exclude<LyricSingerIdsOf<L>, SubjectIdOf<D>> & string}" is not a declared character id`>;
            }
    : unknown);

type SingerIdsOf<G> = G extends readonly (infer X)[] ? X : G;

// Every literal singer id the lyrics name, on a section or a line; a widened `string` names none.
type LyricSingerIdsOf<L> = L extends readonly (infer S)[]
  ? S extends { singer: infer G; lines: infer Lines }
    ?
        | SingerIdsOf<G>
        | (Lines extends readonly (infer Line)[]
            ? Line extends { singer: infer G2 }
              ? SingerIdsOf<G2>
              : never
            : never)
    : never
  : never;
