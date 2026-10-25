import { describe, expect, it } from "vitest";
import {
  checkPrompts,
  promptFindings,
  spokenLinesAt,
  type PromptOccurrence,
} from "../prompt-check.js";

function at(address: string, value: string, exemptions?: readonly RegExp[]): PromptOccurrence {
  return { address, input: "prompt", value, ...(exemptions ? { exemptions } : {}) };
}

function negative(address: string, value: string): PromptOccurrence {
  return { address, input: "negativePrompt", value, negative: true };
}

function phrases(occurrences: readonly PromptOccurrence[]): string[] {
  return checkPrompts(occurrences).map((f) => f.phrase);
}

function codes(occurrences: readonly PromptOccurrence[]): string[] {
  return checkPrompts(occurrences).map((f) => f.code);
}

// The three classes: a style exclusion, an absence, and a negative definition.
describe("checkPrompts vocabulary", () => {
  it("flags a style exclusion, one finding per clause", () => {
    expect(
      phrases([at("video:shot.01.motion", "flat watercolor, no outlines, no shading")]),
    ).toEqual(["no outlines", "no shading"]);
  });

  it("flags an absence and a negative definition", () => {
    expect(
      phrases([
        at("animatic:shot.02.first", "an empty desk with nobody in frame"),
        at("animatic:shot.03.first", "the coin is not round"),
        at("animatic:shot.04.first", "a street without cars"),
      ]),
    ).toEqual([
      "an empty desk with nobody in frame",
      "the coin is not round",
      "a street without cars",
    ]);
  });

  it("reads a perfect negative, contracted or not", () => {
    expect(
      codes([
        at("video:shot.01.motion", "the hand hasn't reached the cup"),
        at("video:shot.02.motion", "the hand has not reached the cup"),
      ]),
    ).toEqual(["prompt-not-yet", "prompt-not-yet"]);
  });

  it("reads a contraction, curly apostrophe included", () => {
    expect(phrases([at("video:shot.01.motion", "the door doesn’t open")])).toEqual([
      "the door doesn’t open",
    ]);
  });

  it("reads every `n't` contraction", () => {
    expect(
      phrases([
        at("video:shot.01.motion", "the door wasn't open"),
        at("video:shot.02.motion", "she didn't look back"),
        at("video:shot.03.motion", "the cup wouldn't tip"),
      ]),
    ).toEqual(["the door wasn't open", "she didn't look back", "the cup wouldn't tip"]);
  });

  it("flags an absence written as `free of` / `empty of` / `devoid of`", () => {
    expect(
      phrases([
        at("animatic:shot.01.first", "a desk free of clutter"),
        at("animatic:shot.02.first", "a room empty of furniture"),
        at("animatic:shot.03.first", "a sky devoid of clouds"),
      ]),
    ).toEqual(["a desk free of clutter", "a room empty of furniture", "a sky devoid of clouds"]);
  });

  it("leaves a set phrase alone — its negation word excludes nothing", () => {
    expect(
      phrases([
        at("animatic:shot.01.first", "not only red but also blue"),
        at("animatic:shot.02.first", "she walks on no matter the rain"),
        at("animatic:shot.03.first", "no doubt in her stride"),
      ]),
    ).toEqual([]);
  });

  it("still reads a negation beside a set phrase in the same clause", () => {
    expect(
      phrases([at("animatic:shot.01.first", "no matter the rain and never looking up")]),
    ).toEqual(["no matter the rain and never looking up"]);
  });

  it("leaves a comparative alone — it bounds a value, it excludes nothing", () => {
    expect(
      phrases([at("video:shot.01.motion", "the push-in runs no longer than 2 seconds")]),
    ).toEqual([]);
  });

  it("still reads a negation beside a comparative in the same clause", () => {
    expect(
      phrases([at("video:shot.01.motion", "no longer than 2 seconds and never cutting away")]),
    ).toEqual(["no longer than 2 seconds and never cutting away"]);
  });

  it("leaves `-less` alone — the false-positive rate is what keeps it out of the vocabulary", () => {
    expect(phrases([at("animatic:shot.01.first", "a sleeveless linen dress")])).toEqual([]);
  });

  it("says nothing about an empty prompt", () => {
    expect(phrases([at("video:shot.01.motion", "")])).toEqual([]);
  });
});

describe("checkPrompts classes", () => {
  it("separates the not-yet class from a plain exclusion", () => {
    expect(
      codes([
        at("video:shot.01.motion", "no outlines"),
        at("video:shot.02.motion", "neither has moved yet"),
        at("video:shot.03.motion", "the hand has not reached the cup"),
      ]),
    ).toEqual(["prompt-negation", "prompt-not-yet", "prompt-not-yet"]);
  });
});

describe("checkPrompts exemptions", () => {
  const freeze = [/\bnothing\b[^.,;]*\b(?:moves|slides|turns)\b/i];

  it("drops a negation the adapter declares as this model's own instruction", () => {
    expect(phrases([at("video:shot.01.motion", "and nothing slides or turns", freeze)])).toEqual(
      [],
    );
  });

  it("keeps the rest of a clause an exemption cut a span out of", () => {
    expect(
      phrases([at("video:shot.01.motion", "nothing slides and no shadows fall", freeze)]),
    ).toEqual(["nothing slides and no shadows fall"]);
  });

  it("applies an exemption to every occurrence, not just the first", () => {
    expect(
      phrases([at("video:shot.01.motion", "nothing moves and nothing turns", freeze)]),
    ).toEqual([]);
  });

  it("matches an anchored exemption against the whole clause", () => {
    const absent = [/^none$/i];
    expect(
      phrases([
        at(
          "animatic:timeline.score",
          "Vocal Gender & Timbre: None.\nHarmony/Backing Vocals: no backing vocals, none of it heavy",
          absent,
        ),
      ]),
    ).toEqual(["no backing vocals", "none of it heavy"]);
  });

  it("exempts nothing for an adapter that declares none", () => {
    expect(phrases([at("video:shot.01.motion", "and nothing slides or turns")])).toEqual([
      "and nothing slides or turns",
    ]);
  });
});

describe("checkPrompts script", () => {
  const line = "I don't want to. Not today, not ever.";
  // What an adapter's `spokenTextPattern` marks — each `<d>` block and the words inside it. A value
  // with no `<d>` marks nothing: a prompt with no lines in it.
  const DIALOGUE = /<d>\[[^\]]*\]\s*([\s\S]*?)<\/d>/g;
  const marked = (value: string): { words: string[]; marks: string[] } => {
    const found = [...value.matchAll(DIALOGUE)];
    return {
      words: found.map((m) => (m[1] ?? "").trim()),
      marks: found.map((m) => m[0]),
    };
  };

  const spoken = (value: string, script: readonly string[] = [line]): PromptOccurrence => ({
    address: "video:shot.01.motion",
    input: "prompt",
    value,
    script,
    spokenWithin: marked(value).words,
    spokenMarks: marked(value).marks,
  });

  it("cuts a verbatim quotation, its own clause breaks included", () => {
    expect(
      phrases([
        spoken(`She turns to him and says, <d>[English] ${line}</d> while the rain falls.`),
      ]),
    ).toEqual([]);
  });

  it("matches the line across a rewrap of its spacing", () => {
    expect(
      phrases([spoken("says <d>[English] I don't want to.\n  Not today,   not ever.</d>")]),
    ).toEqual([]);
  });

  // The exemption is the model's words: a shot whose line is one word would otherwise strip that
  // word out of every prompt in the stage.
  it("cuts nothing from a prompt the adapter marks no lines in", () => {
    expect(phrases([spoken("no people in the street", ["no"])])).toEqual([
      "no people in the street",
    ]);
  });

  it("cuts a short line inside the marked span and nowhere else in the same prompt", () => {
    expect(phrases([spoken("says <d>[English] no</d>, and no rain falling", ["no"])])).toEqual([
      "and no rain falling",
    ]);
  });

  it("keeps a negation written beside the line", () => {
    expect(phrases([spoken(`says <d>[English] ${line}</d>, with no rain falling`)])).toEqual([
      "with no rain falling",
    ]);
  });

  it("reads a paraphrase as the author's words", () => {
    expect(phrases([spoken("says she does not want to")])).toEqual(["says she does not want to"]);
  });
});

// The unit is the phrase: a style constant shared by thirty prompts is one finding naming thirty
// addresses, not thirty findings.
describe("checkPrompts grouping", () => {
  it("collapses one phrase across addresses, in declaration order", () => {
    const active = checkPrompts([
      at("video:shot.01.motion", "watercolor, no outlines"),
      at("video:shot.02.motion", "ink wash, no outlines"),
      at("video:shot.03.motion", "no outlines"),
    ]);
    expect(active).toHaveLength(1);
    expect(active[0]!.addresses).toEqual([
      "video:shot.01.motion",
      "video:shot.02.motion",
      "video:shot.03.motion",
    ]);
  });

  it("reads a phrase past its casing and spacing", () => {
    expect(
      checkPrompts([
        at("video:shot.01.motion", "No  Outlines"),
        at("video:shot.02.motion", "no outlines"),
      ]),
    ).toHaveLength(1);
  });

  it("names one address once, however many of its prompts carry the phrase", () => {
    const active = checkPrompts([
      at("video:shot.01.motion", "no outlines"),
      { address: "video:shot.01.motion", input: "stylePrompt", value: "no outlines" },
    ]);
    expect(active[0]!.addresses).toEqual(["video:shot.01.motion"]);
  });
});

describe("checkPrompts on a negativePrompt", () => {
  it("passes the term list a negativePrompt is meant to hold", () => {
    expect(
      phrases([negative("video:shot.01.motion", "blurry, extra fingers, watermark, text")]),
    ).toEqual([]);
  });

  it("flags a negation inside it, one finding per clause", () => {
    expect(phrases([negative("video:shot.01.motion", "no watermark, without text")])).toEqual([
      "no watermark",
      "without text",
    ]);
  });

  it("reports it under its own code", () => {
    expect(codes([negative("video:shot.01.motion", "no watermark")])).toEqual([
      "prompt-double-negative",
    ]);
    expect(codes([at("video:shot.01.motion", "no watermark")])).toEqual(["prompt-negation"]);
  });

  it("does not sub-class time talk — the input holds terms, not a described frame", () => {
    expect(codes([negative("video:shot.01.motion", "the hand has not reached the cup")])).toEqual([
      "prompt-double-negative",
    ]);
  });
});

describe("promptFindings", () => {
  it("reports nothing for a stage whose prompts name only what is there", () => {
    expect(
      promptFindings(
        { prompts: [at("video:shot.01.motion", "flat watercolor")] },
        { stage: "video" },
      ),
    ).toEqual([]);
  });

  it("names the phrase, where it is written, and the file it is fixed in", () => {
    const [finding] = promptFindings(
      { prompts: [at("video:shot.01.motion", "no outlines")] },
      { stage: "video" },
    );
    expect(finding).toMatchObject({
      code: "prompt-negation",
      subject: '"no outlines"',
      fixIn: { stage: "video" },
      targets: ["video:shot.01.motion"],
    });
    expect(finding!.message).toContain("video:shot.01.motion");
    expect(finding!.message).toContain("describe what occupies the space");
  });

  it("gives each polarity its own remedy", () => {
    const messages = promptFindings(
      {
        prompts: [
          at("video:shot.01.motion", "no outlines"),
          negative("video:shot.01.motion", "no watermark"),
        ],
      },
      { stage: "video" },
    ).map((f) => f.message);
    expect(messages.join("\n")).toContain("describe what occupies the space");
    expect(messages.join("\n")).toContain("keep the term, drop the negation");
  });

  it("sits a patch's finding on nothing an accept could take", () => {
    const [finding] = promptFindings(
      { prompts: [at("video:shot.01.motion", "no outlines")] },
      { stage: "video", patch: "v-abc" },
    );
    expect(finding!.targets).toEqual([]);
  });
});

describe("spokenLinesAt", () => {
  const at = (address: string): PromptOccurrence[] => [
    { address, input: "script", value: "全部これがせりふです。", spoken: true },
    {
      address,
      input: "prompt",
      value: "She turns and asks, <d>[Japanese] かあちゃん、あたしにも。</d>",
      spokenWithin: ["かあちゃん、あたしにも。"],
    },
    { address, input: "prompt", value: "a clean studio read" },
  ];

  it("takes a spokenText input whole and a prompt only where its lines were marked", () => {
    expect(spokenLinesAt(at("animatic:shot.07.vo"), "animatic:shot.07.vo")).toEqual([
      "全部これがせりふです。",
      "かあちゃん、あたしにも。",
    ]);
  });

  it("reads the address itself, never another's", () => {
    expect(spokenLinesAt(at("animatic:shot.07.vo"), "animatic:shot.08.vo")).toEqual([]);
  });

  it("returns nothing where no input carries words", () => {
    expect(
      spokenLinesAt([{ address: "a", input: "prompt", value: "a clean studio read" }], "a"),
    ).toEqual([]);
  });
});
