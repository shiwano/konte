import { KonteError } from "./errors.js";

/**
 * SHA-256 of every managed-tool artifact konte downloads, keyed by its exact URL.
 *
 * Regenerate with `bun run scripts/update-tool-checksums.ts` after bumping any pinned version; the
 * diff is the review surface — a hash that moves without a version moving is an upstream artifact
 * that was replaced in place. Every pin must therefore address an immutable artifact (this is why
 * ffmpeg pins BtbN's dated `autobuild-*` tag rather than its rolling `latest`).
 */
export const TOOL_CHECKSUMS: Readonly<Record<string, string>> = {
  "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-08-31-13-27/ffmpeg-n8.1.2-50-g1a748fe2cd-linux64-gpl-8.1.tar.xz":
    "c733b4b2951e5957e15505f788b2c65a7a41b6da4b289e295852cc38079b4d2b",
  "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-08-31-13-27/ffmpeg-n8.1.2-50-g1a748fe2cd-linuxarm64-gpl-8.1.tar.xz":
    "ae5da4f51b9052390f414005f8ab26c1eed1268f327cce7cb79aa076b29bd66e",
  "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-08-31-13-27/ffmpeg-n8.1.2-50-g1a748fe2cd-win64-gpl-8.1.zip":
    "273abb45f3f9f76c303e35ff39f5bb6c23c163ae65f6244a32b7d4a7f6cf0616",
  "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-08-31-13-27/ffmpeg-n8.1.2-50-g1a748fe2cd-winarm64-gpl-8.1.zip":
    "722be613f4fdb0b114671515c44a747edd86b814d4e367ca11b10df4539e6e74",
  "https://github.com/cloudflare/cloudflared/releases/download/2026.8.3/cloudflared-darwin-amd64.tgz":
    "61e1316266a00fd70ce40da011d612badc805367fb65293dd1925f938f704c99",
  "https://github.com/cloudflare/cloudflared/releases/download/2026.8.3/cloudflared-darwin-arm64.tgz":
    "40c9144d86df8937c5b43293a1f7d2d2107029aa74725023dd46b1b27154352f",
  "https://github.com/cloudflare/cloudflared/releases/download/2026.8.3/cloudflared-linux-amd64":
    "f29324fe934d1e100617484c78deef803c4dc2cd351d645bbde42e96b4fccc5e",
  "https://github.com/cloudflare/cloudflared/releases/download/2026.8.3/cloudflared-linux-arm64":
    "4bcfd35521a7cbc545ebfd5d57334a71ee180e2a64874981f374c81472118391",
  "https://github.com/cloudflare/cloudflared/releases/download/2026.8.3/cloudflared-windows-amd64.exe":
    "83e726ed18ea78c5ad5213c4c3a3a27051393950d2bc8ed4de69bec12d14eaae",
  "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-darwin-arm64.gz":
    "8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa",
  "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffprobe-darwin-arm64.gz":
    "d986a8ec7b030899fe66a8a288ed809a3543338705a3ce178cfb85869c5d80be",
  "https://registry.npmjs.org/@typescript/typescript-darwin-arm64/-/typescript-darwin-arm64-7.0.2.tgz":
    "902e2fe1cf0799198ef902c6b8c310a450fef629a6baba41d45641ef75c04ebd",
  "https://registry.npmjs.org/@typescript/typescript-darwin-x64/-/typescript-darwin-x64-7.0.2.tgz":
    "eba158cb54050f723d5ff781438f33de5640054440bb4f2bd170cfe9bc2eb551",
  "https://registry.npmjs.org/@typescript/typescript-linux-arm/-/typescript-linux-arm-7.0.2.tgz":
    "33a15a7badb207a38957373c410b970319baac8960109232ab64502497caea06",
  "https://registry.npmjs.org/@typescript/typescript-linux-arm64/-/typescript-linux-arm64-7.0.2.tgz":
    "c83d931ac9dd7549cde6e71246aa9d6a9812843023df3e277fe3b5dcf41dd0ea",
  "https://registry.npmjs.org/@typescript/typescript-linux-x64/-/typescript-linux-x64-7.0.2.tgz":
    "7ecad6f67377e831856367ab062ef394f21506a611405bf8ac0ff039348637d3",
  "https://registry.npmjs.org/@typescript/typescript-win32-arm64/-/typescript-win32-arm64-7.0.2.tgz":
    "0a73534e6ee50cdbb2a29ac48657ca0ad13cf0f424cf63808e4df7baeb87b8be",
  "https://registry.npmjs.org/@typescript/typescript-win32-x64/-/typescript-win32-x64-7.0.2.tgz":
    "61fc4e141d2bc687db580e71bbfa63b9c209f0310645d82ca1b457eb3a24fd19",
  "https://storage.googleapis.com/chrome-for-testing-public/151.0.7922.71/linux64/chrome-headless-shell-linux64.zip":
    "7dd9d23b46fa7a9bfa26f1af96f413e0514c32698f6a43a57e1ade48d88a6578",
  "https://storage.googleapis.com/chrome-for-testing-public/151.0.7922.71/mac-arm64/chrome-headless-shell-mac-arm64.zip":
    "a873b850acb443ebd801cd6fc09b77806c379a13230f41bba260226d8877a5d9",
  "https://storage.googleapis.com/chrome-for-testing-public/151.0.7922.71/mac-x64/chrome-headless-shell-mac-x64.zip":
    "0603577363df323e57f9dd9aa72c49253374ff6718c7c1a5d0d0f29c59772844",
  "https://storage.googleapis.com/chrome-for-testing-public/151.0.7922.71/win64/chrome-headless-shell-win64.zip":
    "6e48a9cd964aa5fb80c9a02a677d9b810a53bbcf6d747959e8f0a9c09a3891b2",
};

/**
 * The pinned SHA-256 for a managed-tool URL. Throws when the URL is not in the manifest — a
 * download konte cannot verify is one it does not make, so a new platform or a bumped version
 * fails here until the manifest is regenerated.
 */
export function toolChecksum(url: string): string {
  const sha256 = TOOL_CHECKSUMS[url];
  if (!sha256) {
    throw new KonteError(
      "CHECKSUM_UNKNOWN",
      `No pinned checksum for "${url}". Run \`bun run scripts/update-tool-checksums.ts\` to regenerate the manifest.`,
    );
  }
  return sha256;
}

/**
 * The pin a tool cache directory is stamped with: the manifest digests of every artifact that
 * built it, in the order given. Several for a tool whose install is more than one download.
 */
export function toolPin(urls: readonly string[]): string {
  return urls.map(toolChecksum).join(" ");
}
