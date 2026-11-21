// What a finding is — what it reads, how it clears, what it holds and from when — as a property of
// its code.

// Every command that can spend on a backend.
export type SpendCommand = "generate" | "reroll" | "patch" | "export";

// How far a spend hold reaches, from the finding's stage: `edge` holds only the subject's assets and
// what is built on them, on its stage and downstream; the rest still spends.
export type SpendReach = "stage" | "stage+downstream" | "downstream" | "edge";

export type FindingTraits = {
  reads: "definition" | "take";
  clears: "fix" | "waive" | "vouch" | "accept";
  holds: {
    // `named`: a targeted spend (`reroll`, `patch apply`) is held only when it names an asset under
    // the finding's targets, or one of no shot.
    spend?: { reach: SpendReach; commands?: readonly SpendCommand[]; named?: true };
    accept?: true;
    preview?: true;
  };
  onset: "always" | "after-direction-accepted" | "after-take";
  // An accept of the addresses it is judged by (`judgedBy`) signs it off.
  signsOff: boolean;
};

export const waive = (
  reach: SpendReach,
  onset: FindingTraits["onset"] = "always",
  reads: FindingTraits["reads"] = "definition",
) => ({
  reads,
  clears: "waive" as const,
  holds: { spend: { reach } },
  onset,
  signsOff: false as const,
});

export const judged = <T extends FindingTraits>(
  traits: T,
): Omit<T, "signsOff"> & { signsOff: true } => ({
  ...traits,
  signsOff: true,
});

// A declaration contradicting another, or naming nothing.
export const fixDirection = {
  reads: "definition",
  clears: "fix",
  holds: { spend: { reach: "stage+downstream" }, accept: true },
  onset: "always",
  signsOff: false,
} as const satisfies FindingTraits;

export const ROSTER = "after-direction-accepted" as const;
