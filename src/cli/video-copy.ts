import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseAddress } from "../core/address.js";
import { hashFile } from "../core/content-hash.js";
import { errorMessage, KonteError } from "../core/errors.js";
import { loadVideoTemplate, VIDEO_BINARY_FILES } from "../core/generated/template-assets.js";
import { resolveWithinRoot } from "../core/path-containment.js";
import { STAGE_ENTRY_FILE, VIDEO_MARKER, VIDEO_NAME_PATTERN, VIDEOS_DIR } from "../core/roots.js";
import { StateManager } from "../core/state/index.js";
import { variantDir } from "../core/variant-dir.js";
import { generateVariantId } from "../core/variant-id.js";
import { generatedOrigin } from "../core/variant-lineage.js";
import { writeTemplateFiles } from "./template-files.js";

export const COPY_STAGES = ["direction", "reference", "animatic", "video"] as const;
export type CopyStage = (typeof COPY_STAGES)[number];

async function copyFile(source: string, destination: string): Promise<void> {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
}

async function copySupportFiles(source: string, destination: string, atRoot = true): Promise<void> {
  const excluded = new Set([
    ".konte",
    "assets",
    "dist",
    "review",
    "patches",
    "node_modules",
    ".git",
  ]);
  if (atRoot) {
    for (const file of Object.values(STAGE_ENTRY_FILE)) excluded.add(file);
    excluded.add(VIDEO_MARKER);
  }
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    if (excluded.has(entry.name) || entry.isSymbolicLink()) continue;
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await copySupportFiles(from, to, false);
    } else if (/\.(?:[cm]?[jt]sx?|json|css|html|md|txt)$/.test(entry.name)) {
      await copyFile(from, to);
    }
  }
}

export async function copyVideo(
  workspaceRoot: string,
  sourceRoot: string,
  name: string,
  through: CopyStage,
): Promise<number> {
  if (!VIDEO_NAME_PATTERN.test(name)) {
    throw new KonteError(
      "INVALID_VIDEO_NAME",
      `Invalid video name "${name}". Use lowercase letters, digits, ".", "_" and "-", starting with a letter or digit.`,
    );
  }
  const retained = new Set<string>(COPY_STAGES.slice(0, COPY_STAGES.indexOf(through) + 1));
  const source = (await StateManager.load(sourceRoot)).getRecordedState();
  const files = await loadVideoTemplate("blank");
  if (!files) throw new KonteError("INVALID_TEMPLATE", 'The "blank" template is unavailable');
  const destination = path.join(workspaceRoot, VIDEOS_DIR, name);
  try {
    await fs.mkdir(destination);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new KonteError("VIDEO_ALREADY_EXISTS", `Video "${name}" already exists`);
    }
    throw err;
  }

  try {
    await writeTemplateFiles(destination, files, VIDEO_BINARY_FILES);
    await copySupportFiles(sourceRoot, destination);
    for (const stage of COPY_STAGES) {
      if (!retained.has(stage)) continue;
      const file = STAGE_ENTRY_FILE[stage];
      try {
        await copyFile(path.join(sourceRoot, file), path.join(destination, file));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT" || stage === "direction") throw err;
      }
    }

    const manager = await StateManager.init(destination);
    const state = manager.getState();
    state.directionAcceptance = structuredClone(source.directionAcceptance ?? null);
    const copiedFiles = new Map<string, string>();
    let count = 0;
    for (const [address, asset] of Object.entries(source.assets)) {
      const parsed = parseAddress(address);
      if (!retained.has(parsed.stage) || parsed.kind === "patch") continue;
      for (const [oldId, variant] of Object.entries(asset.variants ?? {})) {
        if (variant.status !== "accepted" || !variant.file) continue;
        const from = await resolveWithinRoot(sourceRoot, variant.file);
        if (!from) {
          throw new KonteError(
            "INVALID_REFERENCE",
            `Asset "${address}" resolves outside its video`,
          );
        }
        const id = generateVariantId();
        const oldDir = variantDir(sourceRoot, address, oldId);
        const newDir = variantDir(destination, address, id);
        const originId = generatedOrigin(source, address, oldId);
        const origin = asset.variants?.[originId];
        const authoredFile = origin?.file?.startsWith("assets/files/") ? origin.file : null;
        if (authoredFile && !(await resolveWithinRoot(sourceRoot, authoredFile))) {
          throw new KonteError(
            "INVALID_REFERENCE",
            `Asset "${address}" resolves outside its video`,
          );
        }
        const relative = path.relative(oldDir, from);
        const generated =
          relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
        const patched = variant.derivedFrom != null;
        const to = authoredFile
          ? path.join(destination, authoredFile)
          : generated
            ? path.join(newDir, relative)
            : patched
              ? path.join(newDir, path.basename(from))
              : path.join(destination, path.relative(sourceRoot, from));
        const previous = copiedFiles.get(to);
        if (previous && (await hashFile(previous)) !== (await hashFile(from))) {
          throw new KonteError(
            "VIDEO_COPY_FAILED",
            `Accepted assets have different outputs at "${path.relative(destination, to)}". Give their file definitions separate paths before copying.`,
          );
        }
        await copyFile(from, to);
        copiedFiles.set(to, from);
        for (const sidecar of ["song.json", "heard.json", "definition.json"]) {
          try {
            const sourceDir =
              sidecar === "definition.json" ? variantDir(sourceRoot, address, originId) : oldDir;
            await copyFile(path.join(sourceDir, sidecar), path.join(newDir, sidecar));
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
          }
        }
        const copied = structuredClone(variant);
        copied.file = path.relative(destination, to);
        copied.derivedFrom = null;
        copied.patchHash = null;
        copied.metadata = {};
        copied.inputFingerprints = Object.fromEntries(
          Object.entries(copied.inputFingerprints).filter(
            ([dep]) => parseAddress(dep).kind !== "patch",
          ),
        );
        state.assets[address] ??= { variants: {} };
        state.assets[address]!.variants![id] = copied;
        count++;
      }
    }
    await manager.save();
    return count;
  } catch (err) {
    await fs.rm(destination, { recursive: true, force: true });
    if (err instanceof KonteError) throw err;
    throw new KonteError(
      "VIDEO_COPY_FAILED",
      `Could not copy video "${name}": ${errorMessage(err)}`,
    );
  }
}
