import type { Command } from "commander";
import { formatShotAddress, parseReelScope } from "../../../core/address.js";
import { applyResolutionDefinitions } from "../../../core/definition-hashes.js";
import { KonteError } from "../../../core/errors.js";
import { formatSecondsRange } from "../../../core/format-duration.js";
import { stageLineTimings } from "../../../core/line-timing.js";
import { buildRenderPlan } from "../../../core/render-plan.js";
import { recognizesSpeechIn } from "../../../core/sherpa-binary.js";
import { loadAnimatic } from "../../../core/loader.js";
import { loadVideoAndAnimatic } from "../../../core/stage-definitions.js";
import { StateManager } from "../../../core/state/index.js";
import { type LineTiming, lineTimingKey, timeSubtitleLine } from "../../../core/subtitle-timing.js";
import { requireVideoRoot } from "../../context.js";

// The line cut after each mark that closes a clause, the mark kept with it.
function clauses(text: string): string[] {
  return text.match(/[^、。，．,.!?！？…]+[、。，．,.!?！？…]*|[、。，．,.!?！？…]+/gu) ?? [text];
}

function formatLine(timing: LineTiming): string[] {
  const head = `${timing.shotId} line ${timing.line}`;
  if (!timing.take) return [`${head}  no take on the reel owes it`, `  ${timing.text}`];
  const take = `${timing.take.address} ${timing.take.variantId}`;
  const timings = new Map([[lineTimingKey(timing.shotId, timing.line), timing]]);
  const spec = { shot: timing.shotId, line: timing.line };
  const [whole] = timeSubtitleLine({ ...spec, text: timing.text }, timings);
  const span = whole ? formatSecondsRange(whole.start, whole.end) : "unmeasured";
  if (!timing.charAt) {
    const pauses = timing.pauses.map((p, i) => `${i + 1} ${formatSecondsRange(p[0], p[1])}`);
    const others = timing.takeLines.filter((l) => l.line !== timing.line).map((l) => l.line);
    return [
      `${head}  ${span}  not heard  ${take}`,
      `  ${timing.text}`,
      ...(others.length > 0 ? [`  one take with line ${others.join(", ")}`] : []),
      `  pauses: ${pauses.length > 0 ? pauses.join("  ") : "none"}`,
    ];
  }
  const parts = clauses(timing.text).map((p) => [p, p] as const);
  return [
    `${head}  ${span}  ${take}`,
    ...timeSubtitleLine({ ...spec, parts }, timings).map(
      (t) => `  ${formatSecondsRange(t.start, t.end)}  ${t.text}`,
    ),
  ];
}

export function registerProbeReelLinesCommand(program: Command): void {
  program
    .command("reel-lines <address-scope>")
    .description("Show where each script line is said on a reel")
    .addHelpText(
      "after",
      `
Lists every script line of the scope with the reel seconds it is said over and the take saying it,
as a script-line \`<Subtitle>\` entry is timed. A line heard in the piece's language is broken at
each clause, with the seconds of each — the words a \`parts\` entry names. A line not heard lists
the pauses of its take, numbered, which a \`pauses\` entry breaks it at, written with that take's
id as \`take\`.

  animatic | video           Every shot of that stage
  <stage>:shot.<id>          One shot

Examples:
  konte probe reel-lines video              Where the delivered reel says each line
  konte probe reel-lines animatic:shot.03   Where the board's shot 03 says its lines
`,
    )
    .action(async (addressScope: string) => {
      const { stage, shotId } = parseReelScope(addressScope);
      const videoRoot = requireVideoRoot();
      const video =
        stage === "animatic"
          ? await loadAnimatic(videoRoot)
          : (await loadVideoAndAnimatic(videoRoot)).video;
      if (shotId && !video.shots.some((s) => s.id === shotId)) {
        throw new KonteError("SHOT_NOT_FOUND", `Shot "${shotId}" not found`);
      }
      const manager = await StateManager.load(videoRoot);
      await applyResolutionDefinitions({ videoRoot, state: manager.getState() });
      const plan = buildRenderPlan(video, manager, {
        outputDir: "",
        allowUnaccepted: true,
        allowNotReady: true,
      });
      const timings = await stageLineTimings(
        video,
        manager,
        plan,
        shotId ? new Set([shotId]) : null,
      );
      const lang = video.typography.lang;
      console.log(
        `${shotId ? formatShotAddress(stage, shotId) : stage}   ${timings.size} line${timings.size === 1 ? "" : "s"}   ` +
          (recognizesSpeechIn(lang)
            ? `heard in ${lang}`
            : `${lang} is not heard: lines are timed off their takes' sound`),
      );
      for (const timing of timings.values()) {
        console.log("");
        for (const line of formatLine(timing)) console.log(line);
      }
    });
}
