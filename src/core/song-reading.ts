import { readFileSync } from "node:fs";
import * as path from "node:path";
import { writeFileAtomic } from "./atomic-write.js";
import { sha256Hex } from "./content-hash.js";
import { stableStringify } from "./stable-stringify.js";
import {
  type SongAnalysis,
  type SongReading,
  SongReadingSchema,
  type SongRecord,
} from "./types/index.js";
import { variantDir } from "./variant-dir.js";

const SONG_READING_FILE = "song.json";

function songReadingPath(videoRoot: string, address: string, variantId: string): string {
  return path.join(variantDir(videoRoot, address, variantId), SONG_READING_FILE);
}

function songReadingHash(reading: SongReading): string {
  return sha256Hex(stableStringify(reading)).slice(0, 16);
}

// Writes a take's reading beside it and returns the hash its record holds.
export async function writeSongReading(
  videoRoot: string,
  address: string,
  variantId: string,
  reading: SongReading,
): Promise<string> {
  await writeFileAtomic(
    songReadingPath(videoRoot, address, variantId),
    `${JSON.stringify(reading, null, 2)}\n`,
  );
  return songReadingHash(reading);
}

// The reading `record` names, null where its file is gone or no longer hashes to it.
export function readSongReading(
  videoRoot: string,
  address: string,
  variantId: string,
  record: SongRecord,
): SongReading | null {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(songReadingPath(videoRoot, address, variantId), "utf-8"));
  } catch {
    return null;
  }
  const parsed = SongReadingSchema.safeParse(raw);
  if (!parsed.success || songReadingHash(parsed.data) !== record.reading) return null;
  return parsed.data;
}

// A take's reading with what a person set on it, null where it has not been read.
export function songAnalysisOf(
  videoRoot: string,
  address: string,
  variantId: string,
  record: SongRecord | undefined,
): SongAnalysis | null {
  if (!record) return null;
  const reading = readSongReading(videoRoot, address, variantId, record);
  if (!reading) return null;
  const { reading: _, ...set } = record;
  return { ...reading, ...set };
}
