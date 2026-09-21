import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  GenerationBackend,
  GenerationRequest,
  GenerationResult,
  WaitForCompletionResult,
  WaitOptions,
} from "../core/backend.js";
import { assertRetimeRate, atempoChain, retimeRate } from "../core/audio-retime.js";
import { parsePlaceholder } from "../core/dsl/shot-context.js";
import { KonteError, errorMessage } from "../core/errors.js";
import {
  ffmpegBin,
  SINGLE_FRAME_INPUT_ARGS,
  SINGLE_FRAME_OUTPUT_ARGS,
} from "../core/ffmpeg-binary.js";
import { extractFrameAt, lastSeekableTime, probeVideo } from "../core/thumbnail.js";
import { requireFileWithinRoot } from "../core/path-containment.js";
import { asJsxStillInputs, renderJsxStill } from "../core/jsx-still.js";
import { trimVideo } from "../core/ffmpeg.js";
import { probeMediaDuration } from "../core/video-probe.js";
import type { LocalAssetDefinition } from "../core/types/index.js";
import { execFileAsync } from "../core/exec-file.js";

export class LocalBackend implements GenerationBackend {
  private readonly videoRoot: string;

  constructor(videoRoot: string) {
    this.videoRoot = videoRoot;
  }

  async submit(request: GenerationRequest): Promise<string> {
    await this.generate(request);
    return `local-${request.variantId}`;
  }

  // Local media ops run synchronously inside submit() (there is no external job to poll), so this
  // is a private helper, not part of GenerationBackend.
  private async generate(request: GenerationRequest): Promise<GenerationResult> {
    const start = performance.now();
    const def = this.assertLocalDef(request.assetDefinition);
    const outputFile = await this.executeOperation(
      def,
      request.outputDir,
      request.resolvedDependencies,
      request.address,
    );
    return { files: [outputFile], metadata: {}, durationMs: Math.round(performance.now() - start) };
  }

  async waitForCompletion(
    _backendJobId: string,
    outputDir: string,
    _options?: WaitOptions,
  ): Promise<WaitForCompletionResult> {
    const entries = await fs.readdir(outputDir);
    const outputFile = entries.find((e) => e.startsWith("output."));
    if (!outputFile) {
      throw new KonteError("GENERATION_FAILED", `No output file found in ${outputDir}`);
    }
    return {
      kind: "done",
      result: { files: [path.join(outputDir, outputFile)], metadata: {}, durationMs: 0 },
    };
  }

  async cancel(_jobId: string): Promise<void> {}

  private assertLocalDef(def: GenerationRequest["assetDefinition"]): LocalAssetDefinition {
    if (def.kind !== "local") {
      throw new KonteError("INVALID_ASSET_TYPE", `Expected local asset, got "${def.kind}"`);
    }
    return def;
  }

  private outputExtension(
    def: LocalAssetDefinition,
    resolvedDependencies: Record<string, string>,
  ): string {
    if (def.operation === "trim" || def.operation === "retime") {
      const sourceFile = this.dependencyFilePath(def.inputs.source as string, resolvedDependencies);
      return path.extname(sourceFile) || (def.mediaType === "audio" ? ".wav" : ".mp4");
    }
    switch (def.mediaType) {
      case "video":
        return ".mp4";
      case "audio":
        return ".wav";
      default:
        return ".png";
    }
  }

  private async executeOperation(
    def: LocalAssetDefinition,
    outputDir: string,
    resolvedDependencies: Record<string, string>,
    address: string,
  ): Promise<string> {
    await fs.mkdir(outputDir, { recursive: true });
    const ext = this.outputExtension(def, resolvedDependencies);
    const outputFile = path.join(outputDir, `output${ext}`);

    switch (def.operation) {
      case "resize":
        await this.resizeImage(def.inputs, outputFile, resolvedDependencies);
        break;
      case "crop":
        await this.cropImage(def.inputs, outputFile, resolvedDependencies);
        break;
      case "blank":
        await this.createBlankImage(def.inputs, outputFile);
        break;
      case "trim":
        await this.trimMedia(def.inputs, outputFile, resolvedDependencies);
        break;
      case "retime":
        await this.retimeMedia(def.inputs, outputFile, resolvedDependencies, address);
        break;
      case "frame":
        await this.extractFrame(def.inputs, outputFile, resolvedDependencies);
        break;
      case "render":
        await this.renderStill(def.inputs, outputFile, resolvedDependencies);
        break;
    }

    return outputFile;
  }

  // Path only — no containment check, because the caller (outputExtension) reads nothing but the
  // extension. Anything that opens the file must go through resolveDependencyFile instead.
  private dependencyFilePath(
    placeholder: string,
    resolvedDependencies: Record<string, string>,
  ): string {
    const ref = parsePlaceholder(placeholder);
    const key = ref ?? placeholder;
    const depPath = resolvedDependencies[key] ?? placeholder;
    return path.isAbsolute(depPath) ? depPath : path.join(this.videoRoot, depPath);
  }

  // Re-checks containment at the moment of use: state's recorded path was validated when the file
  // asset was synced, but a symlink could have been swapped in since (see path-containment).
  private resolveDependencyFile(
    placeholder: string,
    resolvedDependencies: Record<string, string>,
  ): Promise<string> {
    const ref = parsePlaceholder(placeholder);
    const key = ref ?? placeholder;
    return requireFileWithinRoot(this.videoRoot, resolvedDependencies[key] ?? placeholder);
  }

  private async resizeImage(
    inputs: Record<string, unknown>,
    outputFile: string,
    resolvedDependencies: Record<string, string>,
  ): Promise<void> {
    const width = inputs.width as number;
    const height = inputs.height as number;

    const inputFile = await this.resolveDependencyFile(
      inputs.image as string,
      resolvedDependencies,
    );

    const args = ["-y", "-i", inputFile, "-vf", `scale=${width}:${height}`, outputFile];

    const ffmpeg = await ffmpegBin();
    try {
      await execFileAsync(ffmpeg, args);
    } catch (err) {
      const message = errorMessage(err);
      throw new KonteError("FFMPEG_ERROR", `ffmpeg resizeImage failed: ${message}`);
    }
  }

  private async cropImage(
    inputs: Record<string, unknown>,
    outputFile: string,
    resolvedDependencies: Record<string, string>,
  ): Promise<void> {
    const x = inputs.x as number;
    const y = inputs.y as number;
    const width = inputs.width as number;
    const height = inputs.height as number;
    const outWidth = inputs.outWidth as number;
    const outHeight = inputs.outHeight as number;

    const inputFile = await this.resolveDependencyFile(
      inputs.image as string,
      resolvedDependencies,
    );

    // One filtergraph, so the window is cut at the master's own resolution and the scale down to
    // the canvas is the only resampling the pixels see.
    const args = [
      "-y",
      "-i",
      inputFile,
      "-vf",
      `crop=${width}:${height}:${x}:${y},scale=${outWidth}:${outHeight}`,
      outputFile,
    ];

    const ffmpeg = await ffmpegBin();
    try {
      await execFileAsync(ffmpeg, args);
    } catch (err) {
      const message = errorMessage(err);
      throw new KonteError("FFMPEG_ERROR", `ffmpeg cropImage failed: ${message}`);
    }
  }

  // konte's own primitive, reachable only through the `internalTestImage` fixture — there is no
  // author-facing adapter for it (`jsxImage` with a `background` and no `build` is that).
  private async createBlankImage(
    inputs: Record<string, unknown>,
    outputFile: string,
  ): Promise<void> {
    const width = inputs.width as number;
    const height = inputs.height as number;
    const color = (inputs.color as string) ?? "#000000";

    let ffmpegColor = color;
    if (color.startsWith("#")) {
      const hex = color.slice(1);
      // ffmpeg expects 0xRRGGBB[AA]; expand shorthand (#RGB → 0xRRGGBB, #RGBA → 0xRRGGBBAA).
      const expanded = hex.length === 3 || hex.length === 4 ? hex.replace(/./g, (c) => c + c) : hex;
      ffmpegColor = `0x${expanded}`;
    }

    const args = [
      "-y",
      ...SINGLE_FRAME_INPUT_ARGS,
      "-f",
      "lavfi",
      // format=rgba in the filtergraph preserves the alpha channel; an output
      // -pix_fmt rgba goes through a yuv roundtrip that drops alpha and shifts colors.
      "-i",
      `color=c=${ffmpegColor}:s=${width}x${height}:d=0.04,format=rgba`,
      ...SINGLE_FRAME_OUTPUT_ARGS,
      "-frames:v",
      "1",
      outputFile,
    ];

    const ffmpeg = await ffmpegBin();
    try {
      await execFileAsync(ffmpeg, args);
    } catch (err) {
      const message = errorMessage(err);
      throw new KonteError("FFMPEG_ERROR", `ffmpeg createBlankImage failed: ${message}`);
    }
  }

  private async trimMedia(
    inputs: Record<string, unknown>,
    outputFile: string,
    resolvedDependencies: Record<string, string>,
  ): Promise<void> {
    const start = inputs.start as number;
    const duration = inputs.duration as number;
    const inputFile = await this.resolveDependencyFile(
      inputs.source as string,
      resolvedDependencies,
    );
    await trimVideo({ inputFile, outputFile, start, duration });
  }

  private async retimeMedia(
    inputs: Record<string, unknown>,
    outputFile: string,
    resolvedDependencies: Record<string, string>,
    address: string,
  ): Promise<void> {
    const duration = inputs.duration as number;
    const waiver = inputs.waiver as string | undefined;
    const inputFile = await this.resolveDependencyFile(
      inputs.source as string,
      resolvedDependencies,
    );

    const sourceDuration = await probeMediaDuration(inputFile);
    if (sourceDuration === null) {
      throw new KonteError(
        "FFMPEG_ERROR",
        `ffmpeg retimeMedia failed: cannot read the length of ${inputFile}`,
      );
    }
    const rate = retimeRate(sourceDuration, duration);
    assertRetimeRate({ rate, sourceDuration, duration, waiver, where: address });

    // `atempo` moves the tempo and leaves the pitch. `-t` pins the result to the requested length,
    // which the filter otherwise lands on only to within a sample.
    const args = [
      "-y",
      "-i",
      inputFile,
      "-filter:a",
      atempoChain(rate),
      "-t",
      String(duration),
      outputFile,
    ];

    const ffmpeg = await ffmpegBin();
    try {
      await execFileAsync(ffmpeg, args);
    } catch (err) {
      throw new KonteError("FFMPEG_ERROR", `ffmpeg retimeMedia failed: ${errorMessage(err)}`);
    }
  }

  private async extractFrame(
    inputs: Record<string, unknown>,
    outputFile: string,
    resolvedDependencies: Record<string, string>,
  ): Promise<void> {
    const inputFile = await this.resolveDependencyFile(
      inputs.source as string,
      resolvedDependencies,
    );
    const at = inputs.at as number | "last";
    let timestamp: number;
    if (at === "last") {
      // videoDuration, not the container's: a longer audio track pushes `duration` past the last
      // frame. It already falls back to the container's where the stream declares none, and is 0
      // when neither does — seeking there would hand back the first frame as if it were the last.
      const probe = await probeVideo(inputFile);
      if (probe.videoDuration <= 0) {
        throw new KonteError(
          "FFPROBE_ERROR",
          `Cannot resolve at: "last" — ffprobe reports no duration for ${inputFile}. ` +
            "Pass an explicit `at` in seconds.",
        );
      }
      timestamp = lastSeekableTime(probe.videoDuration, probe.fps);
    } else {
      timestamp = at;
    }
    await extractFrameAt(inputFile, timestamp, outputFile);
  }

  private async renderStill(
    inputs: Record<string, unknown>,
    outputFile: string,
    resolvedDependencies: Record<string, string>,
  ): Promise<void> {
    await renderJsxStill({
      inputs: asJsxStillInputs(inputs),
      outputFile,
      videoRoot: this.videoRoot,
      resolveRef: (placeholder) => this.resolveDependencyFile(placeholder, resolvedDependencies),
    });
  }
}
