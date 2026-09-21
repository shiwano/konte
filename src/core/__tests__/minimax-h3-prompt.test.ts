import { describe, expect, it } from "vitest";
import { minimaxH3CutSource, minimaxH3Prompt } from "../dsl/validators/minimax-h3.js";
import { LANGUAGE_NAMES } from "../typography.js";

const r2i = minimaxH3Prompt({ mode: "r2i", prompt: "prompt", length: "length" });
const r2iCut = minimaxH3Prompt({
  mode: "r2i",
  prompt: "prompt",
  length: "length",
  frameIndex: "frameIndex",
});
const r2a = minimaxH3Prompt({
  mode: "r2a",
  prompt: "prompt",
  length: "length",
  references: ["image1", "audio1"],
});
const r2v = minimaxH3Prompt({ mode: "r2v", prompt: "prompt", length: "length" });

interface Six {
  subjects?: string;
  summary?: string;
  retention?: string;
  description?: string;
  soundscape?: string;
  music?: string;
}

function six(parts: Six = {}): string {
  return [
    `subject_definitions: ${parts.subjects ?? "<Picture 1> is the first frame of [Shot 1]."}`,
    "",
    `summary: ${parts.summary ?? "[keyframe completion] She walks on down the path."}`,
    "",
    `retention_analysis: ${parts.retention ?? "<Picture 1> ([Shot 1] first frame): fully_preserved - the take opens on this exact frame."}`,
    "",
    `detailed_description: ${parts.description ?? "watercolor. [Shot 1] She walks on down the path."}`,
    "",
    `overall_soundscape: ${parts.soundscape ?? "N/A"}`,
    "",
    `non_diegetic_music: ${parts.music ?? "N/A"}`,
  ].join("\n");
}

function three(description: string, soundscape = "A faint room tone.", music = "N/A"): string {
  return [
    `integrated_multimodal_description: ${description}`,
    "",
    `overall_soundscape: ${soundscape}`,
    "",
    `non_diegetic_music: ${music}`,
  ].join("\n");
}

const ctx = { promptInput: "prompt" };

describe("minimaxH3Prompt() — shape", () => {
  it("accepts the six sections in order", () => {
    expect(r2v({ prompt: six(), length: 124 }, ctx)).toBeUndefined();
  });

  // `""` is the prompt input's own default on every H3 adapter, so it is present and no required
  // check reaches it.
  it("rejects an empty prompt, which no required check refuses", () => {
    expect(r2v({ prompt: "", length: 124 }, ctx)).toContain("The prompt is empty");
    expect(r2v({ prompt: "   \n  ", length: 124 }, ctx)).toContain("The prompt is empty");
  });

  it("reports a misspelled field name as the section it meant, and names it", () => {
    const prompt = six().replace("retention_analysis:", "retention_analysys:");
    const message = r2v({ prompt, length: 124 }, ctx);
    expect(message).toContain('missing "retention_analysis"');
    expect(message).toContain('It does carry "retention_analysys:"');
  });

  it("reads a colon-led body line as prose, not as a seventh field", () => {
    const prompt = six({
      description:
        "watercolor. [Shot 1] She walks on down the path.\nforeground: the reeds at the water's edge.",
    });
    expect(r2v({ prompt, length: 124 }, ctx)).toBeUndefined();
  });

  it("names no unrelated colon-led line when a section is genuinely missing", () => {
    const prompt = six({ description: "watercolor. [Shot 1] She walks.\nforeground: the reeds." })
      .split("\n")
      .filter((line) => !line.startsWith("non_diegetic_music:"))
      .join("\n");
    const message = r2v({ prompt, length: 124 }, ctx);
    expect(message).toContain('missing "non_diegetic_music"');
    expect(message).not.toContain("foreground");
  });

  it("rejects a missing section", () => {
    const prompt = six().replace(/\nnon_diegetic_music: N\/A/, "");
    expect(r2v({ prompt, length: 124 }, ctx)).toContain('missing "non_diegetic_music"');
  });

  it("rejects sections written out of order", () => {
    const prompt = [
      "summary: [keyframe completion] She walks on.",
      "",
      "subject_definitions: <Picture 1> is the first frame of [Shot 1].",
      "",
      "retention_analysis: <Picture 1>: fully_preserved - kept.",
      "",
      "detailed_description: [Shot 1] She walks on.",
      "",
      "overall_soundscape: N/A",
      "",
      "non_diegetic_music: N/A",
    ].join("\n");
    expect(r2v({ prompt, length: 124 }, ctx)).toContain("out of order");
  });

  it("rejects an empty section, which N/A is the literal for", () => {
    expect(r2v({ prompt: six({ music: "" }), length: 124 }, ctx)).toContain(
      '"non_diegetic_music" is empty',
    );
  });

  it("takes the three-field shape on an R2A with no reference wired", () => {
    expect(
      r2a({ prompt: three("[Shot 1] watercolor. A close, dry recording.") }, ctx),
    ).toBeUndefined();
  });

  it("takes the six-section shape on an R2A with a reference wired", () => {
    expect(r2a({ prompt: three("[Shot 1] A recording."), audio1: "x" }, ctx)).toContain(
      'names "integrated_multimodal_description", which this model does not read',
    );
  });

  it("says which half of R2A's shape applies, and what moves it to the other", () => {
    expect(r2a({ prompt: three("[Shot 1] A recording."), audio1: "x" }, ctx)).toContain(
      "because a reference is wired (audio1)",
    );
    expect(r2a({ prompt: six(), length: 124 }, ctx)).toContain(
      "while no reference is wired. Wire one",
    );
  });

  it("adds no such reason on a mode whose shape is fixed", () => {
    const message = r2v({ prompt: six().replace("summary:", "sumary:"), length: 124 }, ctx);
    expect(message).toContain('It does carry "sumary:"');
    expect(message).not.toContain("reference is wired");
  });
});

describe("minimaxH3Prompt() — labels and retention", () => {
  it("requires a retention line for every declared label", () => {
    const prompt = six({
      subjects: "<Picture 1> is the first frame of [Shot 1].\n<Subject 1> is the mother.",
    });
    expect(r2v({ prompt, length: 124 }, ctx)).toContain("<Subject 1> is defined");
  });

  it("rejects a retention line for a label nothing defines", () => {
    const prompt = six({
      retention:
        "<Picture 1> ([Shot 1] first frame): fully_preserved - kept.\n<Audio 1>: reference - followed.",
    });
    expect(r2v({ prompt, length: 124 }, ctx)).toContain("names <Audio 1>");
  });

  it("reads a label cited inside another definition as a citation, not a declaration", () => {
    const prompt = six({
      subjects: "<Subject 1> is the mother, whose costume comes from <Picture 1>.",
      retention: "<Subject 1> (appears in [Shot 1]): fully_preserved - her kimono is carried.",
    });
    expect(r2v({ prompt, length: 124 }, ctx)).toBeUndefined();
  });

  it("rejects a second line for one label", () => {
    const prompt = six({
      retention:
        "<Picture 1> ([Shot 1] first frame): fully_preserved - kept.\n<Picture 1>: weak_reference - also kept.",
    });
    expect(r2v({ prompt, length: 124 }, ctx)).toContain("more than one line");
  });

  it("rejects an audio marker on visible content", () => {
    const prompt = six({
      retention: "<Picture 1> ([Shot 1] first frame): fully_copy - the frame is copied.",
    });
    const message = r2v({ prompt, length: 124 }, ctx);
    expect(message).toContain('"fully_copy"');
    expect(message).toContain("marker set of an <Audio N>");
  });

  it("rejects a visual marker on an <Audio N>", () => {
    const prompt = six({
      subjects: "<Audio 1> is the voice-timbre reference for the mother.",
      summary: "[audio reference] She reads the line.",
      retention: "<Audio 1>: attribute_transfer - the timbre is taken.",
    });
    expect(r2v({ prompt, length: 124 }, ctx)).toContain("marker set of visible content");
  });

  it("rejects a speaker id in retention_analysis", () => {
    const prompt = six({
      retention: "<Picture 1> (S1): fully_preserved - the take opens on this frame.",
    });
    expect(r2v({ prompt, length: 124 }, ctx)).toContain("speaker id (S1)");
  });
});

describe("minimaxH3Prompt() — task types", () => {
  it("accepts several joined with +", () => {
    const prompt = six({
      subjects: "<Picture 1> is the first frame of [Shot 1].\n<Audio 1> is the recorded line.",
      summary: "[keyframe completion + audio reuse] She speaks the line.",
      retention:
        "<Picture 1> ([Shot 1] first frame): fully_preserved - kept.\n<Audio 1>: partially_copy - the spoken layer is reused, with room tone around it.",
      soundscape: "A faint room tone under the voice.",
    });
    expect(r2v({ prompt, length: 124 }, ctx)).toBeUndefined();
  });
});

describe("minimaxH3Prompt() — the reuse/reference choice", () => {
  const withAudio = (summary: string, marker: string, soundscape = "A faint room tone.") =>
    six({
      subjects: "<Audio 1> is the voice reference for the mother.",
      summary,
      retention: `<Audio 1>: ${marker} - the line.`,
      soundscape,
    });

  it("rejects audio reuse with no copy marker", () => {
    const prompt = withAudio("[audio reuse] She speaks.", "reference");
    expect(r2v({ prompt, length: 124 }, ctx)).toContain('claims "audio reuse"');
  });

  it("rejects audio reference with no reference marker", () => {
    const prompt = withAudio("[audio reference] She speaks.", "partially_copy");
    expect(r2v({ prompt, length: 124 }, ctx)).toContain('claims "audio reference"');
  });

  it("rejects a copy marker the summary never claims", () => {
    const prompt = withAudio("[keyframe completion] She speaks.", "partially_copy");
    expect(r2v({ prompt, length: 124 }, ctx)).toContain('takes "audio reuse"');
  });

  it("rejects a reference marker the summary never claims", () => {
    const prompt = withAudio("[keyframe completion] She speaks.", "weak_reference");
    expect(r2v({ prompt, length: 124 }, ctx)).toContain('takes "audio reference"');
  });

  it("rejects fully_copy beside a written soundscape", () => {
    const prompt = withAudio("[audio reuse] She speaks.", "fully_copy", "A quiet room.");
    expect(r2v({ prompt, length: 124 }, ctx)).toContain('"fully_copy"');
  });

  it("accepts fully_copy when nothing else sounds", () => {
    const prompt = withAudio("[audio reuse] She speaks.", "fully_copy", "N/A");
    expect(r2v({ prompt, length: 124 }, ctx)).toBeUndefined();
  });
});

describe("minimaxH3Prompt() — shots", () => {
  it("refuses a cut on a still whose adapter names no frame input", () => {
    const prompt = six({
      description:
        "watercolor. [Shot 1] She stands. [Shot 2] At 00:01.000, the camera cuts to her hands.",
    });
    expect(r2i({ prompt, length: 42 }, ctx)).toContain("names no frame input");
  });

  it("takes three shots on a video take", () => {
    const prompt = six({
      description:
        "watercolor. [Shot 1] She stands. [Shot 2] At 00:01.000, the camera cuts to her hands. " +
        "[Shot 3] At 00:02.000, the camera cuts to the door.",
    });
    expect(r2v({ prompt, length: 124 }, ctx)).toBeUndefined();
  });

  it("takes a cut on a still whose kept frame lands past it", () => {
    const prompt = six({
      description:
        "watercolor. [Shot 1] She stands. [Shot 2] At 00:01.000, the camera cuts to her hands.",
    });
    expect(r2iCut({ prompt, length: 42, frameIndex: 38 }, ctx)).toBeUndefined();
  });

  // The workflow clamps the index to the burst's last frame, so an index past the end keeps an
  // EARLIER frame than the one asked for.
  it("reads the clamped frame, not the index asked for", () => {
    const prompt = six({
      description:
        "watercolor. [Shot 1] She stands. [Shot 2] At 00:00.900, the camera cuts to her hands.",
    });
    // 22/24 is past 00:00.900, but a 22-frame burst ends at frame 21 (00:00.875), which is not.
    const message = r2iCut({ prompt, length: 22, frameIndex: 22 }, ctx);
    expect(message).toContain("no frame of the burst lands after that cut");
  });

  it("passes a clamped index that still lands past the cut", () => {
    const prompt = six({
      description:
        "watercolor. [Shot 1] She stands. [Shot 2] At 00:00.400, the camera cuts to her hands.",
    });
    const message = r2iCut({ prompt, length: 22, frameIndex: 30 }, ctx);
    expect(message).toBeUndefined();
  });

  it("rejects a kept frame that is still before the cut", () => {
    const prompt = six({
      description:
        "watercolor. [Shot 1] She stands. [Shot 2] At 00:01.000, the camera cuts to her hands.",
    });
    const message = r2iCut({ prompt, length: 42, frameIndex: 12 }, ctx);
    expect(message).toContain("keeps frame 12");
    expect(message).toContain("cuts away from");
  });

  it("names where to land on the one burst length that has been measured", () => {
    const prompt = six({
      description:
        "watercolor. [Shot 1] She stands. [Shot 2] At 00:00.400, the camera cuts to her hands.",
    });
    const message = r2iCut({ prompt, length: 22, frameIndex: 8 }, ctx);
    expect(message).toContain("`frameIndex: 20`");
    expect(message).toContain("from 10 up");
  });

  it("names only the floor on a burst length that has not been", () => {
    const prompt = six({
      description:
        "watercolor. [Shot 1] She stands. [Shot 2] At 00:00.400, the camera cuts to her hands.",
    });
    const message = r2iCut({ prompt, length: 39, frameIndex: 8 }, ctx);
    expect(message).toContain("a frame from 10 up");
    expect(message).not.toContain("Take `frameIndex:");
  });

  it("blames a repeated shot number on the back-reference that caused it", () => {
    const prompt = six({
      description:
        "watercolor. [Shot 1] She stands. [Shot 2] At 00:01.000, the camera cuts in, as pale as [Shot 1].",
    });
    expect(r2iCut({ prompt, length: 42, frameIndex: 38 }, ctx)).toContain(
      "name it in words instead",
    );
  });

  it("rejects cut times that do not rise", () => {
    const prompt = six({
      description:
        "watercolor. [Shot 1] She walks. [Shot 2] At 00:03.000, she turns. [Shot 3] At 00:02.000, she stops.",
    });
    expect(r2v({ prompt, length: 240 }, ctx)).toContain("is not after");
  });

  it("rejects a cut the take never reaches", () => {
    const prompt = six({
      description: "watercolor. [Shot 1] She walks. [Shot 2] At 00:07.000, she turns.",
    });
    expect(r2v({ prompt, length: 124 }, ctx)).toContain("never reaches");
  });

  it("rejects a [Shot N] outside the description past the shots it has", () => {
    const prompt = six({ subjects: "<Picture 1> is the first frame of [Shot 2]." });
    expect(r2v({ prompt, length: 124 }, ctx)).toContain(
      '"subject_definitions" names `[Shot 2]`, and the description has 1 shot.',
    );
  });

  it("rejects a later shot whose cut time cannot be read", () => {
    const prompt = six({
      description: "watercolor. [Shot 1] She walks. [Shot 2] At -1:59.500, she turns.",
    });
    expect(r2v({ prompt, length: 124 }, ctx)).toContain("no cut time konte can read");
  });

  it("leaves the cut times unbounded when no length input is named", () => {
    const unbounded = minimaxH3Prompt({ mode: "r2v", prompt: "prompt" });
    const prompt = six({
      description: "watercolor. [Shot 1] She walks. [Shot 2] At 00:59.000, she turns.",
    });
    expect(unbounded({ prompt, length: 124 }, ctx)).toBeUndefined();
  });
});

describe("minimaxH3Prompt() — dialogue", () => {
  it("requires a language tag inside <d>", () => {
    const prompt = six({
      description: "watercolor. [Shot 1] She says, <d>おーい、待ってくれ。</d>",
    });
    expect(r2v({ prompt, length: 124 }, ctx)).toContain("no language tag");
  });

  it("rejects a tag naming no language konte carries", () => {
    for (const tag of ["english", "\u65e5\u672c\u8a9e", "ja", "Swedish"]) {
      const prompt = six({
        description: `watercolor. [Shot 1] She says, <d>[${tag}] Hello there.</d>`,
      });
      expect(r2v({ prompt, length: 124 }, ctx)).toContain("names no language konte carries");
    }
  });

  it("takes every language konte carries, by its English name", () => {
    for (const language of Object.values(LANGUAGE_NAMES)) {
      const prompt = six({
        description: `watercolor. [Shot 1] She says, <d>[${language}] Hello there.</d>`,
      });
      expect(r2v({ prompt, length: 124 }, ctx)).toBeUndefined();
    }
  });

  it("rejects an unclosed <d>", () => {
    const prompt = six({
      description: "watercolor. [Shot 1] She says, <d>[Japanese] おーい、待ってくれ。",
    });
    expect(r2v({ prompt, length: 124 }, ctx)).toContain("never closed");
  });

  it("accepts a tagged line", () => {
    const prompt = six({
      description: "watercolor. [Shot 1] She says, <d>[Japanese] おーい、待ってくれ。</d>",
    });
    expect(r2v({ prompt, length: 124 }, ctx)).toBeUndefined();
  });
});

describe("minimaxH3Prompt() — declared inputs", () => {
  it("names the inputs it reads", () => {
    expect(r2a.inputs).toEqual(["prompt", "length", "image1", "audio1"]);
  });

  it("names no reference slot outside R2A, whose shape does not turn on them", () => {
    expect(r2v.inputs).toEqual(["prompt", "length"]);
  });
});

describe("minimaxH3CutSource()", () => {
  it("returns [Shot 1] of a description that cuts", () => {
    const prompt = six({
      subjects: "<Picture 2> is the frame this take cuts from.",
      description:
        "watercolor. [Shot 1] The frame of <Picture 2>. [Shot 2] At 00:00.200, the camera cuts to <Picture 1>.",
    });
    expect(minimaxH3CutSource(prompt)?.trim()).toBe("The frame of <Picture 2>.");
  });

  it("returns nothing where the description does not cut", () => {
    expect(minimaxH3CutSource(six())).toBeUndefined();
  });

  it("reads only the description", () => {
    const prompt = six({ summary: "[reference generation] [Shot 1] a [Shot 2] b" });
    expect(minimaxH3CutSource(prompt)).toBeUndefined();
  });
});
