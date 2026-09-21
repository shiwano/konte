import * as crypto from "node:crypto";

// Alphanumerics only — URL-safe nanoid minus `-`/`_`.
// Avoids misreads when an id is hand-mixed into an address (no v--... / v-..._...).
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const SIZE = 8;

// Unbiased rejection sampling. Avoids the distribution bias of `random % length`
// by masking off remainder bits with a power-of-two mask and discarding values past the alphabet.
const mask = (2 << Math.floor(Math.log2(ALPHABET.length - 1))) - 1;
const step = Math.ceil((1.6 * mask * SIZE) / ALPHABET.length);

export function shortId(): string {
  let id = "";
  while (true) {
    const bytes = crypto.getRandomValues(new Uint8Array(step));
    for (let i = 0; i < step; i++) {
      const index = bytes[i]! & mask;
      if (index < ALPHABET.length) {
        id += ALPHABET[index];
        if (id.length === SIZE) return id;
      }
    }
  }
}

// Deterministically derive a fixed-length base-62 id from `input` (sha256, then
// base-62 encode with the same alphabet as shortId). Eight base-62 chars carry
// ~47.6 bits — far more than the 32 bits of an 8-char hex slice — at the same
// visual length, keeping every id type on one alphabet. For content-addressed
// dedup ids (a stable id is wanted for the same input).
export function hashToShortId(input: string, size = SIZE): string {
  const digest = crypto.createHash("sha256").update(input).digest();
  let n = 0n;
  for (let i = 0; i < 8; i++) n = (n << 8n) | BigInt(digest[i] ?? 0);
  let id = "";
  for (let i = 0; i < size; i++) {
    id = ALPHABET[Number(n % 62n)] + id;
    n /= 62n;
  }
  return id;
}
