import { describe, expect, it } from "vitest";
import { handleSubmit, type ReviewContext } from "../submit.js";

const ctx: ReviewContext = {
  videoRoot: "/nonexistent",
  stage: "video",
  handoff: null,
  direction: null,
  reference: null,
  animatic: null,
  video: null,
};

const post = (body: unknown) =>
  new Request("http://127.0.0.1/api/submit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

async function refused(body: unknown): Promise<{ status: number; error: string; taken: boolean }> {
  let taken = false;
  const res = await handleSubmit(ctx, post(body), () => {
    taken = true;
  });
  return { status: res.status, error: ((await res.json()) as { error: string }).error, taken };
}

describe("handleSubmit — a body it refuses", () => {
  it("names the review a submit for another stage belongs to", async () => {
    expect(await refused({ stage: "animatic", displayedStandInShotIds: [] })).toEqual({
      status: 400,
      error:
        "This page reviews the video; a submit for the animatic belongs to `konte preview animatic`",
      taken: false,
    });
  });

  it("refuses a body that names no stage", async () => {
    expect(await refused({ displayedStandInShotIds: [] })).toMatchObject({
      status: 400,
      taken: false,
    });
  });

  it("refuses it after the global Response is replaced", async () => {
    const original = globalThis.Response;
    globalThis.Response = class extends original {} as typeof Response;
    try {
      expect(await refused({ stage: "animatic", displayedStandInShotIds: [] })).toMatchObject({
        status: 400,
        taken: false,
      });
    } finally {
      globalThis.Response = original;
    }
  });

  it("names each invalid field by its path", async () => {
    const { status, error, taken } = await refused({
      stage: "video",
      displayedStandInShotIds: [],
      decisions: { "01": "maybe" },
    });
    expect(status).toBe(400);
    expect(taken).toBe(false);
    expect(error).toContain("decisions.01:");
  });
});
