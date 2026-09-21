import { describe, expect, it } from "vitest";
import { promptReferenceTags } from "../dsl/validators/prompt-tags.js";
import { defineComfyAsset } from "../dsl/comfy-asset.js";
import { makeMediaAsset } from "../dsl/builders.js";
import { KonteError } from "../errors.js";
import type { ComfyAssetDefinition } from "../types/index.js";

const validator = promptReferenceTags({
  prompt: "prompt",
  tags: {
    Picture: ["image1", "image2", "image3"],
    Video: ["video1", "video2"],
    Audio: { slots: ["video1", "video2", "audio1", "audio2"], exhaustive: false },
  },
});

function run(inputs: Record<string, unknown>): string | undefined {
  return validator(inputs);
}

function messageOf(fn: () => string | undefined): string {
  const rejection = fn();
  if (rejection === undefined) throw new Error("expected a rejection");
  return rejection;
}

describe("promptReferenceTags", () => {
  it("accepts a prompt whose ordinals match the wired slots", () => {
    expect(
      run({
        prompt: "<Subject 1> is the woman in <Picture 1>, walking as in <Picture 2>.",
        image1: "a",
        image2: "b",
      }),
    ).toBeUndefined();
  });

  it("accepts an adapter with nothing wired and nothing tagged", () => {
    expect(run({ prompt: "A wide shot of an empty station platform." })).toBeUndefined();
  });

  it("rejects an ordinal above the wired count", () => {
    const message = messageOf(() =>
      run({ prompt: "<Picture 1> and <Picture 3>.", image1: "a", image2: "b" }),
    );
    expect(message).toContain("<Picture 3>");
    expect(message).toContain("image1 → <Picture 1>");
    expect(message).toContain("image2 → <Picture 2>");
  });

  it("names the modality when the adapter wires none of that kind", () => {
    expect(
      messageOf(() => run({ prompt: "<Picture 1> continues <Video 1>.", image1: "a" })),
    ).toContain("no <Video N> slot is wired (available: video1, video2)");
  });

  it("rejects a wired slot no ordinal reaches", () => {
    const message = messageOf(() => run({ prompt: "<Picture 1> only.", image1: "a", image2: "b" }));
    expect(message).toContain('"image2" is wired');
    expect(message).toContain("image2 → <Picture 2>  (unnamed)");
  });

  it("rejects a wired slot when the prompt tags nothing at all", () => {
    expect(messageOf(() => run({ prompt: "A quiet room.", image1: "a" }))).toContain(
      '"image1" is wired, but no <Picture N> in the prompt reaches it',
    );
  });

  it("rejects a skipped ordinal below the highest one", () => {
    const message = messageOf(() =>
      run({ prompt: "<Picture 1> beside <Picture 3>.", image1: "a", image2: "b", image3: "c" }),
    );
    expect(message).toContain('"image2" is wired');
    expect(message).toContain("image2 → <Picture 2>  (unnamed)");
  });

  it("rejects a top ordinal that leaves the one below it unreferenced", () => {
    expect(
      messageOf(() => run({ prompt: "<Picture 2> alone.", image1: "a", image2: "b" })),
    ).toContain('"image1" is wired');
  });

  it("reports every unbacked ordinal, not just the highest", () => {
    const message = messageOf(() =>
      run({ prompt: "<Picture 2>, <Picture 4> and <Picture 5>.", image1: "a" }),
    );
    expect(message).toContain("<Picture 2>, <Picture 4>, <Picture 5>");
  });

  it("rejects a zero ordinal, which no reference can carry", () => {
    expect(messageOf(() => run({ prompt: "<Picture 0>", image1: "a" }))).toContain("<Picture 0>");
  });

  it("rejects a gap in a numbered slot family", () => {
    const message = messageOf(() =>
      run({ prompt: "<Picture 1> and <Picture 2>.", image1: "a", image3: "c" }),
    );
    expect(message).toContain('"image3" is wired and "image2" is not');
  });

  // H3's clip soundtracks: `video2Audio` alone is a first clip with no track, and compacting it
  // onto `video1Audio` would pair it with the wrong clip.
  it("leaves a slot outside a numbered family free to gap", () => {
    const soundtracks = promptReferenceTags({
      prompt: "prompt",
      tags: { Audio: ["video1Audio", "video2Audio", "audio1"] },
    });

    expect(soundtracks({ prompt: "<Audio 1> is the line.", video2Audio: "b" })).toBeUndefined();
    expect(
      soundtracks({
        prompt: "<Audio 1> is the line, <Audio 2> the room.",
        video2Audio: "b",
        audio1: "c",
      }),
    ).toBeUndefined();
  });

  it("counts the bare form an alignment line uses", () => {
    expect(
      run({
        prompt:
          "How the reference pictures align — Picture 1 (from Shot 1) aligns with the 0.00-second mark; Picture 2 (from Shot 7) aligns with the 5.00-second mark.",
        image1: "a",
        image2: "b",
      }),
    ).toBeUndefined();
  });

  it("ignores lowercase prose about a picture", () => {
    expect(messageOf(() => run({ prompt: "the picture 2 steps back", image1: "a" }))).toContain(
      '"image1" is wired',
    );
  });

  it("leaves a bare ordinal off the first line alone — it is on-screen text, not a tag", () => {
    // The alignment line is the prompt's first line; below it, `Video 1` is a label the shot is
    // asked to render. Counting it would reject a legitimate prompt outright.
    expect(
      run({
        prompt: '<Picture 1> holds.\n\nA monitor behind her reads "Video 1" in white lettering.',
        image1: "a",
      }),
    ).toBeUndefined();
  });

  it("still counts a bracketed tag below the first line", () => {
    expect(
      messageOf(() =>
        run({ prompt: "<Picture 1> waits.\n\nThe shot cuts to <Video 1>.", image1: "a" }),
      ),
    ).toContain("no <Video N> slot is wired");
  });

  it("leaves a non-exhaustive group unnamed-checked, ceiling only", () => {
    // Two clips and one standalone audio: at most three `<Audio N>`, and as few as one when both
    // clips are silent — so `<Audio 3>` passes and an untagged one is not reported.
    expect(
      run({ prompt: "<Video 1> <Video 2> <Audio 3>", video1: "a", video2: "b", audio1: "c" }),
    ).toBeUndefined();
    expect(
      run({ prompt: "<Video 1> <Video 2>", video1: "a", video2: "b", audio1: "c" }),
    ).toBeUndefined();
    expect(
      messageOf(() =>
        run({ prompt: "<Video 1> <Video 2> <Audio 4>", video1: "a", video2: "b", audio1: "c" }),
      ),
    ).toContain("<Audio 4>");
  });

  it("leaves an ordinal inside quotes alone — that is text the shot renders", () => {
    expect(
      run({ prompt: '<Picture 1> holds a sign reading "Picture 4".', image1: "a" }),
    ).toBeUndefined();
    expect(
      run({ prompt: "<Picture 1> holds a sign reading “Picture 4”.", image1: "a" }),
    ).toBeUndefined();
  });

  it("rejects a declaration whose numbered family skips a number", () => {
    // An adapter bug, not an author's: both wired, nothing absent between them, so the fill-upward
    // check would never fire. Raised where the adapter is declared.
    expect(() =>
      promptReferenceTags({ prompt: "prompt", tags: { Picture: ["image1", "image3"] } }),
    ).toThrow(/skip a number/);
  });

  it("allows a family numbered from anywhere, as long as it is unbroken", () => {
    expect(() =>
      promptReferenceTags({ prompt: "prompt", tags: { Picture: ["image0", "image1"] } }),
    ).not.toThrow();
  });
});

describe("promptReferenceTags with the bare form", () => {
  // Qwen Image Edit names its references in prose, so a sentence may open on one.
  const bare = promptReferenceTags({
    prompt: "prompt",
    form: "bare",
    tags: { image: { slots: ["image1", "image2", "image3"], exhaustive: false } },
  });

  it("counts a prose ordinal anywhere, whatever its case", () => {
    expect(
      bare({
        prompt: "Image 1 is the base; keep the girl from image 2.",
        image1: "a",
        image2: "b",
      }),
    ).toBeUndefined();
    expect(messageOf(() => bare({ prompt: "Rebuild image 2.", image1: "a" }))).toContain(
      "The prompt names image 2",
    );
  });

  it("leaves a wired reference the prompt never names alone", () => {
    // A local-edit delta ("change the leather to brushed aluminum") need not mention image 1.
    expect(
      bare({ prompt: "Change the leather to brushed aluminum.", image1: "a" }),
    ).toBeUndefined();
  });

  it("leaves an ordinal the shot is asked to render alone", () => {
    expect(
      bare({ prompt: 'Replace the caption with "IMAGE 2", keeping its font.', image1: "a" }),
    ).toBeUndefined();
  });
});

describe("adapter validators hook", () => {
  const adapter = defineComfyAsset({
    workflow: "test.json",
    description: "test adapter",
    inputs: {
      image1: { nodeId: "1", field: "image", type: "image" },
      image2: { nodeId: "2", field: "image", type: "image" },
      prompt: { nodeId: "3", field: "prompt", type: "string", default: "" },
    },
    outputs: { video: { nodeId: "9", type: "video" } },
    validators: promptReferenceTags({ prompt: "prompt", tags: { Picture: ["image1", "image2"] } }),
  });

  it("runs on the resolved inputs, so an omitted optional slot counts as unwired", () => {
    expect(() =>
      adapter.createDefinition({
        image1: makeMediaAsset("__konte:animatic:shot.01.first__"),
        prompt: "<Picture 2> follows.",
      }),
    ).toThrow(/only 1 is wired/);
  });

  it("raises a returned rejection as the typed error", () => {
    const rejecting = defineComfyAsset({
      workflow: "test.json",
      description: "test adapter",
      inputs: { prompt: { nodeId: "3", field: "prompt", type: "string", default: "" } },
      outputs: { image: { nodeId: "9", type: "image" } },
      validators: [() => undefined, () => "the first rejection", () => "the second"],
    });

    try {
      rejecting.createDefinition({ prompt: "anything" });
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(KonteError);
      expect((error as KonteError).code).toBe("INVALID_ADAPTER_INPUT");
      expect((error as KonteError).message).toBe("the first rejection");
    }
  });

  it("passes when the prompt matches what is wired", () => {
    const def = adapter.createDefinition({
      image1: makeMediaAsset("__konte:animatic:shot.01.first__"),
      prompt: "<Picture 1> holds.",
    }) as ComfyAssetDefinition;
    expect(def.inputs["1.image"]).toBe("__konte:animatic:shot.01.first__");
  });

  it("hides an input whose node the omitted media pruned out of the graph", () => {
    // A knob on a branch that is no longer submitted must not be visible to a cross-input validator —
    // it would let one reject on a value the definition does not carry.
    const seen: Record<string, unknown>[] = [];
    const branching = defineComfyAsset({
      workflow: "test.json",
      description: "test adapter",
      inputs: {
        control: { nodeId: "1", field: "image", type: "image", branch: ["2"] },
        strength: { nodeId: "2", field: "strength", type: "number", default: 0.8 },
        prompt: { nodeId: "3", field: "prompt", type: "string", default: "" },
      },
      outputs: { image: { nodeId: "9", type: "image" } },
      validators: (inputs) => {
        seen.push({ ...inputs });
      },
    });

    branching.createDefinition({ prompt: "no control image" });
    expect(seen[0]).toEqual({ prompt: "no control image" });

    branching.createDefinition({
      control: makeMediaAsset("__konte:reference:sheet__"),
      prompt: "with one",
    });
    expect(seen[1]).toEqual({
      control: "__konte:reference:sheet__",
      strength: 0.8,
      prompt: "with one",
    });
  });
});

// An unresolved prompt input used to read as an empty prompt, reporting every wired reference as
// unnamed.
describe("promptReferenceTags prompt input", () => {
  const unnamed = promptReferenceTags({ tags: { Picture: ["image1"] } });

  it("defaults to the adapter's single prompt input", () => {
    expect(
      unnamed({ prompt: "<Picture 1> holds still.", image1: "a" }, { promptInput: "prompt" }),
    ).toBeUndefined();
  });

  it("says so when the adapter declares no single prompt input", () => {
    expect(unnamed({ prompt: "<Picture 1> holds still.", image1: "a" }, {})).toContain(
      "cannot tell which input holds the prompt",
    );
  });
});

describe("the previous panel", () => {
  const within = (prompt: string) => /FROM:(.*?)TO:/s.exec(prompt)?.[1];
  const tags = promptReferenceTags({
    prompt: "prompt",
    tags: { Picture: ["image1", "image2", "image3"] },
    prevPanel: { tag: "Picture", within },
  });
  const panel = (address: string) => `__konte:${address}__`;
  const inShot = (inputs: Record<string, unknown>) => tags(inputs, { shotId: "02" });

  it("accepts another shot's panel named where the cut comes from", () => {
    expect(
      inShot({
        prompt: "<Picture 1> FROM: <Picture 2> TO: the frame wanted",
        image1: "a",
        image2: panel("animatic:shot.01.last"),
      }),
    ).toBeUndefined();
  });

  it("refuses one named anywhere else", () => {
    expect(
      inShot({
        prompt: "FROM: the frame TO: <Picture 1> <Picture 2>",
        image1: "a",
        image2: panel("animatic:shot.01.last"),
      }),
    ).toContain("<Picture 2> is not named where the prompt places the frame a cut comes from");
  });

  it("refuses one the prompt has no place for", () => {
    expect(
      inShot({
        prompt: "<Picture 1> <Picture 2>",
        image1: "a",
        image2: panel("animatic:shot.01.last"),
      }),
    ).toContain("has no place for the frame a cut comes from");
  });

  it("refuses a second shot's panel", () => {
    expect(
      inShot({
        prompt: "FROM: <Picture 1> TO: <Picture 2>",
        image1: panel("animatic:shot.01.last"),
        image2: panel("animatic:shot.00.last"),
      }),
    ).toContain("a cut comes from one frame");
  });

  it("reads a panel of the declaring shot as no cut", () => {
    expect(
      inShot({
        prompt: "<Picture 1> <Picture 2>",
        image1: "a",
        image2: panel("animatic:shot.02.first"),
      }),
    ).toBeUndefined();
  });

  it("reads every shot's panel as another's outside a shot", () => {
    expect(
      tags({
        prompt: "<Picture 1> <Picture 2>",
        image1: "a",
        image2: panel("animatic:shot.02.first"),
      }),
    ).toContain("has no place");
  });

  it("refuses a tag the spec does not declare", () => {
    expect(() =>
      promptReferenceTags({
        prompt: "prompt",
        tags: { Picture: ["image1"] },
        prevPanel: { tag: "Image", within },
      }),
    ).toThrow('prevPanel names tag "Image"');
  });
});
