import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ZodType, ZodTypeDef } from "zod";
import { writeFileAtomic } from "./atomic-write.js";
import { KonteError, type KonteErrorCode, errorMessage } from "./errors.js";
import { withFileLock } from "./file-lock.js";

export interface LockedJsonFileSpec<T> {
  filePath: string;
  lockPath: string;
  schema: ZodType<T, ZodTypeDef, unknown>;
  /** Names the file in error messages, e.g. "state file". */
  label: string;
  /** What an absent file reads as; it throws when the file must exist. */
  onMissing: (filePath: string) => T;
  readErrorCode: KonteErrorCode;
  writeErrorCode: KonteErrorCode;
}

export interface JsonSnapshot<T> {
  value: T;
  /** The serialization on disk, which `write` skips matching. */
  saved: string | null;
}

export class LockedJsonFile<T> {
  constructor(readonly spec: LockedJsonFileSpec<T>) {}

  withLock<R>(fn: () => Promise<R>): Promise<R> {
    return withFileLock(this.spec.lockPath, async () => {
      await this.recoverFromTemp();
      return fn();
    });
  }

  async read(): Promise<JsonSnapshot<T>> {
    const { filePath, label, schema } = this.spec;
    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        const value = this.spec.onMissing(filePath);
        return { value, saved: serialize(value) };
      }
      throw new KonteError(
        this.spec.readErrorCode,
        `Failed to read ${label} "${filePath}": ${errorMessage(err)}`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new KonteError("VALIDATION_FAILED", `Invalid JSON in ${label} "${filePath}"`);
    }

    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw new KonteError(
        "VALIDATION_FAILED",
        `${capitalize(label)} validation failed: ${result.error.message}`,
      );
    }
    return { value: result.data, saved: serialize(result.data) };
  }

  async write(value: T, saved: string | null): Promise<string> {
    const serialized = serialize(value);
    if (serialized === saved) return serialized;
    try {
      await writeFileAtomic(this.spec.filePath, serialized);
    } catch (err) {
      throw new KonteError(
        this.spec.writeErrorCode,
        `Failed to write ${this.spec.label}: ${errorMessage(err)}`,
      );
    }
    return serialized;
  }

  // Readers never adopt a temp: one could be a live writer's in-flight `writeFileAtomic` temp.
  private async recoverFromTemp(): Promise<void> {
    const { filePath, schema } = this.spec;
    try {
      await fs.access(filePath);
      return;
    } catch {
      // missing: look for an adoptable temp
    }

    const dir = path.dirname(filePath);
    const tempPrefix = `.${path.basename(filePath)}.`;
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return;
    }
    const temps = entries.filter((e) => e.startsWith(tempPrefix) && e.endsWith(".tmp"));

    for (const name of temps) {
      const tmpPath = path.join(dir, name);
      try {
        if (schema.safeParse(JSON.parse(await fs.readFile(tmpPath, "utf-8"))).success) {
          await fs.rename(tmpPath, filePath);
          for (const other of temps) {
            if (other !== name) await fs.unlink(path.join(dir, other)).catch(() => {});
          }
          return;
        }
      } catch {
        // try the next candidate
      }
    }

    for (const name of temps) {
      await fs.unlink(path.join(dir, name)).catch(() => {});
    }
  }
}

function serialize(value: unknown): string {
  return JSON.stringify(value, null, 1);
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
