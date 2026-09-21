import { shortId } from "./short-id.js";

export function generateVariantId(): string {
  return `v-${shortId()}`;
}
