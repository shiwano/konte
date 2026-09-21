import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { isWithinVideoRoot } from "../review-shared.js";

describe("isWithinVideoRoot", () => {
  const videoRoot = "/home/user/project";

  it("allows a file inside the project root", () => {
    expect(isWithinVideoRoot("/home/user/project/dist/video.mp4", videoRoot)).toBe(true);
  });

  it("allows a deeply nested file", () => {
    expect(
      isWithinVideoRoot("/home/user/project/dist/profile/timestamp/video.mp4", videoRoot),
    ).toBe(true);
  });

  it("allows the project root itself", () => {
    expect(isWithinVideoRoot("/home/user/project", videoRoot)).toBe(true);
  });

  it("rejects a path that shares a prefix but crosses a separator boundary", () => {
    expect(isWithinVideoRoot("/home/user/project-evil/file.mp4", videoRoot)).toBe(false);
  });

  it("rejects a path traversal via ..", () => {
    const traversalPath = path.resolve(videoRoot, "../outside/file.mp4");
    expect(isWithinVideoRoot(traversalPath, videoRoot)).toBe(false);
  });

  it("rejects a completely unrelated path", () => {
    expect(isWithinVideoRoot("/tmp/file.mp4", videoRoot)).toBe(false);
  });

  it("handles relative videoRoot by resolving it", () => {
    const cwd = process.cwd();
    const relativeRoot = "my-project";
    const resolvedRoot = path.resolve(cwd, relativeRoot);
    const filePath = path.join(resolvedRoot, "dist/video.mp4");
    expect(isWithinVideoRoot(filePath, relativeRoot)).toBe(true);
  });

  it("rejects when relative path resolves outside project root", () => {
    expect(isWithinVideoRoot("/home/user/project/../other/file.mp4", videoRoot)).toBe(false);
  });
});

// The thumbnail route confines reads to .konte/cache/thumbnails/ by passing that dir as the
// containment root — a bare project-root check would still serve secrets like the credentials file.
describe("thumbnail directory confinement", () => {
  const thumbnailsDir = "/home/user/project/.konte/cache/thumbnails";

  it("allows a file inside the thumbnails directory", () => {
    expect(
      isWithinVideoRoot("/home/user/project/.konte/cache/thumbnails/v1/frame.jpg", thumbnailsDir),
    ).toBe(true);
  });

  it("rejects a project-root file outside the thumbnails directory (e.g. the credentials)", () => {
    expect(isWithinVideoRoot("/home/user/project/konte.credentials.json", thumbnailsDir)).toBe(
      false,
    );
  });

  it("rejects a sibling .konte file outside thumbnails (e.g. state)", () => {
    expect(isWithinVideoRoot("/home/user/project/.konte/jobs/x.json", thumbnailsDir)).toBe(false);
  });
});
