import { describe, expect, it } from "vitest";
import { KonteError } from "../errors.js";
import { assertTailwindClasses } from "../tailwind-classes.js";

async function codeOf(html: string): Promise<{ code: string; message: string } | null> {
  try {
    await assertTailwindClasses([{ label: "video:shot.01#composition", html }]);
    return null;
  } catch (err) {
    if (!(err instanceof KonteError)) throw err;
    return { code: err.code, message: err.message };
  }
}

describe("assertTailwindClasses", () => {
  it("passes utilities, variants and arbitrary values Tailwind generates", async () => {
    expect(
      await codeOf(
        `<div class="absolute inset-0 flex md:p-4 bg-black/50 text-[1.875vmax] [&amp;&gt;p]:mt-2"></div>`,
      ),
    ).toBeNull();
  });

  it("passes a class Tailwind generates nothing for", async () => {
    expect(
      await codeOf(
        `<div class="text-whit step-0 step-1 konte-clip"></div>` +
          "<script>[0, 1].forEach((i) => timeline.to(`.step-${i}`, { opacity: 1 }, i));</script>",
      ),
    ).toBeNull();
  });

  it("refuses a class that sets a literal font family, and passes a theme one", async () => {
    const found = await codeOf(`<div class="font-[Inter] [font-family:Inter] font-sans"></div>`);
    expect(found?.code).toBe("REVIEW_HELD");
    expect(found?.message).toContain("direction.policy.fonts");
    expect(found?.message).toContain(
      "video:shot.01#composition: font-[Inter], [font-family:Inter]",
    );
    expect(found?.message).not.toContain("font-sans");
  });

  it("does not read a class attribute inside a script", async () => {
    expect(await codeOf(`<script>const s = ' class="nope"';</script>`)).toBeNull();
  });
});
