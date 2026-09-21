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

  it("names each class Tailwind generates nothing for, under its label", async () => {
    const found = await codeOf(`<div class="flex text-whit justify-centre"></div>`);
    expect(found?.code).toBe("COMPOSITION_CLASS_INVALID");
    expect(found?.message).toContain("video:shot.01#composition: text-whit, justify-centre");
    expect(found?.message).not.toMatch(/: flex\b/);
  });

  it("passes a class a <style> rule or an <Animate> selector names", async () => {
    expect(
      await codeOf(
        `<style>.badge { color: red; }</style><div class="badge title"></div>` +
          `<script>timeline.fromTo(".title", { opacity: 0 }, { opacity: 1 }, 0);</script>`,
      ),
    ).toBeNull();
  });

  it("passes konte's own classes, which a nested shot carries without their styles", async () => {
    expect(
      await codeOf(
        `<video class="konte-clip"></video><div class="konte-clip konte-subtitle"></div>`,
      ),
    ).toBeNull();
  });

  it("refuses a class that sets a literal font family, and passes a theme one", async () => {
    const found = await codeOf(`<div class="font-[Inter] [font-family:Inter] font-sans"></div>`);
    expect(found?.code).toBe("COMPOSITION_CLASS_INVALID");
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
