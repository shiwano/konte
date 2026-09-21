import * as fs from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ctx, useTempWorkspace, initWithTestVideo, run, initWorkspace } from "./cli-fixtures.js";

vi.setConfig({ testTimeout: 15000 });

useTempWorkspace();

describe("workspace new command", () => {
  it("splits the scaffold: shared setup in the workspace, the video under videos/", async () => {
    const workspace = path.join(ctx.dir, "myworkspace");
    await fs.mkdir(workspace);
    const { stdout } = await run(["workspace", "new"], workspace);
    expect(stdout).toContain("created");

    // Everything shared lives at the workspace root, and no video exists yet.
    const modTs = await fs.readFile(path.join(workspace, ".konte", "mod.ts"), "utf-8");
    expect(modTs).toContain("export declare function defineVideo");
    const tsconfig = await fs.readFile(path.join(workspace, "tsconfig.json"), "utf-8");
    expect(tsconfig).toContain("konte");
    const agentsMd = await fs.readFile(path.join(workspace, "AGENTS.md"), "utf-8");
    expect(agentsMd).toContain("AGENTS.md");
    const config = JSON.parse(
      await fs.readFile(path.join(workspace, "konte.config.json"), "utf-8"),
    );
    expect(config.comfyui.url).toBe("http://127.0.0.1:8000");
    await expect(fs.access(path.join(workspace, "konte.state.json"))).rejects.toThrow();

    await run(["video", "new", "opening", "--template", "kitchen-sink"], workspace);

    const videoDir = path.join(workspace, "videos", "opening");
    const videoTsx = await fs.readFile(path.join(videoDir, "video.tsx"), "utf-8");
    expect(videoTsx).toContain("defineVideo");
    // Adapters are the workspace's, reached via the workspace-rooted `konte/workspace/` alias.
    expect(videoTsx).toContain('from "konte/workspace/adapters/comfy/');
    await fs.access(path.join(videoDir, "konte.state.json"));
  });

  it("uses the current directory with no <dir>, and drops the cd step", async () => {
    const workspace = path.join(ctx.dir, "here");
    await fs.mkdir(workspace);
    await fs.mkdir(path.join(workspace, ".git"));
    await fs.writeFile(path.join(workspace, "README.md"), "# hi\n");

    const { stdout } = await run(["workspace", "new"], workspace);
    await fs.access(path.join(workspace, "konte.config.json"));
    expect(stdout).toContain("current directory");
    expect(stdout).not.toMatch(/^\s*cd /m);
  });

  it("confirms before scaffolding over a directory holding more than a fresh repo does", async () => {
    const workspace = path.join(ctx.dir, "existing");
    await fs.mkdir(workspace);
    await fs.writeFile(path.join(workspace, "package.json"), "{}\n");

    await expect(run(["workspace", "new"], workspace)).rejects.toMatchObject({
      stderr: expect.stringContaining("CONFIRMATION_REQUIRED"),
    });
    await expect(fs.access(path.join(workspace, "konte.config.json"))).rejects.toThrow();

    const { stdout } = await run(["workspace", "new", "--no"], workspace);
    expect(stdout).toContain("Aborted.");
    await expect(fs.access(path.join(workspace, "konte.config.json"))).rejects.toThrow();

    await run(["workspace", "new", "-y"], workspace);
    await fs.access(path.join(workspace, "konte.config.json"));
  });

  it("makes the video it creates current", async () => {
    const workspace = path.join(ctx.dir, "myworkspace");
    await fs.mkdir(workspace);
    await run(["workspace", "new"], workspace);
    await run(["video", "new", "opening", "--template", "blank"], workspace);

    const { stdout } = await run(["video", "list"], workspace);
    expect(stdout).toContain("* opening");
  });

  it("fails on a duplicate workspace or video", async () => {
    const workspace = path.join(ctx.dir, "myworkspace");
    await fs.mkdir(workspace);
    await run(["workspace", "new"], workspace);
    await expect(run(["workspace", "new"], workspace)).rejects.toMatchObject({
      stderr: expect.stringContaining("WORKSPACE_ALREADY_EXISTS"),
    });

    await run(["video", "new", "opening", "--template", "blank"], workspace);
    await expect(
      run(["video", "new", "opening", "--template", "blank"], workspace),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("VIDEO_ALREADY_EXISTS") });
  });

  it("rejects a video name that is not a plain path segment", async () => {
    const workspace = path.join(ctx.dir, "myworkspace");
    await fs.mkdir(workspace);
    await run(["workspace", "new"], workspace);
    await expect(
      run(["video", "new", "../escape", "--template", "blank"], workspace),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("INVALID_VIDEO_NAME") });
  });

  it("refuses to create a video outside a workspace", async () => {
    await expect(run(["video", "new", "opening", "--template", "blank"])).rejects.toMatchObject({
      stderr: expect.stringContaining("NOT_A_KONTE_WORKSPACE"),
    });
  });

  // The suite scaffolds its own fixture video, so nothing else would notice the kitchen-sink
  // drifting into a state its own gate refuses.
  it("scaffolds a kitchen-sink whose direction check is clean", async () => {
    const { video: projectDir } = await initWorkspace(path.join(ctx.dir, "kitchensink"), {
      template: "kitchen-sink",
    });
    const { stdout } = await run(["status"], projectDir);
    expect(stdout).not.toContain("Direction findings:");
  });

  it("scaffolds the blank template without assets", async () => {
    const { video: projectDir } = await initWorkspace(path.join(ctx.dir, "myproject"), {
      template: "blank",
    });

    // The blank video stub declares an empty timeline array (only commented-out
    // examples, no active shot() calls), and no character asset is present.
    const videoTsx = await fs.readFile(path.join(projectDir, "video.tsx"), "utf-8");
    expect(videoTsx).toContain("timeline: () => ({ shots: [] })");
    expect(videoTsx).not.toMatch(/^\s*shot\(/m);
    await expect(
      fs.access(path.join(projectDir, "assets", "static", "character.png")),
    ).rejects.toThrow();
  });

  it("fails on an unknown template", async () => {
    const workspace = path.join(ctx.dir, "myworkspace");
    await fs.mkdir(workspace);
    await run(["workspace", "new"], workspace);
    await expect(
      run(["video", "new", "opening", "--template", "nope"], workspace),
    ).rejects.toThrow();
  });
});

describe("file asset path containment", () => {
  // The DSL's file adapter only checks that the path *starts with* "assets/files/", which a `..`
  // walks straight back out of.
  // Keeps the fixture's real reference assets (animatic.tsx consumes them) and adds the escaping one.
  const ESCAPING_REFERENCE_TS = `import { defineReference, asset, adapters } from "konte";
import direction from "./direction";

export default defineReference(direction, () => {
  const character = asset("character", adapters.imageFile, { path: "assets/files/character.png" });
  const bgm = asset("bgm", adapters.audioFile, { path: "assets/files/bgm.mp3" });
  const leak = asset("leak", adapters.imageFile, { path: "assets/files/../../../konte.credentials.json" });
  return { character, bgm, leak };
});
`;

  it("refuses a file asset whose path escapes the video, rather than hashing the workspace credentials", async () => {
    const { workspace, video } = await initWorkspace(path.join(ctx.dir, "leakproj"));
    await fs.writeFile(
      path.join(workspace, "konte.credentials.json"),
      JSON.stringify({ FAL_KEY: "super-secret" }),
    );
    await fs.writeFile(path.join(video, "reference.tsx"), ESCAPING_REFERENCE_TS);

    await expect(run(["status"], video)).rejects.toMatchObject({
      stderr: expect.stringContaining("INVALID_REFERENCE"),
    });

    // Nothing about the secret reached state: no variant, and no content hash of the file.
    const state = await fs.readFile(path.join(video, "konte.state.json"), "utf-8");
    expect(state).not.toContain("leak");
  });

  it("refuses a symlink under assets/files that points out of the video", async () => {
    const { workspace, video } = await initWorkspace(path.join(ctx.dir, "linkproj"));
    await fs.writeFile(
      path.join(workspace, "konte.credentials.json"),
      JSON.stringify({ FAL_KEY: "super-secret" }),
    );

    // Lexically inside the video; reads the workspace's credentials.
    await fs.rm(path.join(video, "assets", "files", "character.png"), { force: true });
    await fs.symlink(
      path.join(workspace, "konte.credentials.json"),
      path.join(video, "assets", "files", "character.png"),
    );

    await expect(run(["status"], video)).rejects.toMatchObject({
      stderr: expect.stringContaining("INVALID_REFERENCE"),
    });
  });
});

describe("--cwd option", () => {
  it("runs a subcommand against the specified project directory", async () => {
    const projectDir = await initWithTestVideo();
    const elsewhere = path.join(ctx.dir, "elsewhere");
    await fs.mkdir(elsewhere);
    const { stdout } = await run(["--cwd", projectDir, "status"], elsewhere);
    expect(stdout).toContain("Progress:");
  });

  it("creates a workspace in --cwd", async () => {
    const target = path.join(ctx.dir, "nested");
    await fs.mkdir(target);
    const { stdout } = await run(["--cwd", target, "workspace", "new"]);
    expect(stdout).toContain("created");
    await fs.access(path.join(target, "konte.config.json"));
  });

  it("fails with INVALID_CWD when the path does not exist", async () => {
    await expect(run(["--cwd", path.join(ctx.dir, "no-such-dir"), "status"])).rejects.toMatchObject(
      {
        stderr: expect.stringContaining("INVALID_CWD"),
      },
    );
  });

  it("fails with INVALID_CWD when the path is a file", async () => {
    const filePath = path.join(ctx.dir, "not-a-dir.txt");
    await fs.writeFile(filePath, "hello");
    await expect(run(["--cwd", filePath, "status"])).rejects.toMatchObject({
      stderr: expect.stringContaining("INVALID_CWD"),
    });
  });
});

describe("workspace setup", () => {
  it("allows the binary installed before workspace creation and rejects a positional directory", async () => {
    const root = path.join(ctx.dir, "installed");
    await fs.mkdir(path.join(root, ".konte/bin"), { recursive: true });
    const binary = path.join(root, ".konte/bin/konte");
    await fs.writeFile(binary, "binary");
    await run(["workspace", "new"], root);
    expect(await fs.readFile(binary, "utf8")).toBe("binary");
    await expect(run(["workspace", "new", "unexpected"], root)).rejects.toThrow();
  });

  it("repairs a cloned or moved workspace, preserving production and user settings", async () => {
    const { workspace, video } = await initWorkspace(path.join(ctx.dir, "original"));
    const originalVideo = await fs.readFile(path.join(video, "video.tsx"), "utf8");
    await fs.writeFile(path.join(workspace, "adapters/custom.txt"), "my adapter");
    await fs.writeFile(path.join(workspace, "HOUSE_RULES.md"), "my rules");
    await fs.writeFile(path.join(workspace, ".gitignore"), "my-cache/\n");
    await fs.writeFile(
      path.join(workspace, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          other: { command: "keep" },
          konte: { command: "/old/konte", env: { TOKEN: "${TOKEN}" } },
        },
      }),
    );
    await fs.rm(path.join(workspace, ".konte"), { recursive: true });
    await fs.rm(path.join(workspace, ".claude/settings.json"));
    const moved = path.join(ctx.dir, "moved space 日本語");
    await fs.rename(workspace, moved);
    await run(["workspace", "setup"], path.join(moved, "videos/main"));
    expect(await fs.readFile(path.join(moved, "videos/main/video.tsx"), "utf8")).toBe(
      originalVideo,
    );
    expect(await fs.readFile(path.join(moved, "HOUSE_RULES.md"), "utf8")).toBe("my rules");
    expect(await fs.readFile(path.join(moved, "adapters/custom.txt"), "utf8")).toBe("my adapter");
    const mcp = JSON.parse(await fs.readFile(path.join(moved, ".mcp.json"), "utf8"));
    expect(mcp.mcpServers.other.command).toBe("keep");
    expect(mcp.mcpServers.konte.command).toBe(path.join(moved, ".konte/bin/konte"));
    expect(mcp.mcpServers.konte.env.TOKEN).toBe("${TOKEN}");
    const ignore = await fs.readFile(path.join(moved, ".gitignore"), "utf8");
    expect(ignore).toContain("my-cache/\n");
    expect(ignore).toContain(".codex/config.toml\n");
    await fs.access(path.join(moved, ".claude/settings.json"));
    await fs.access(path.join(moved, ".konte/mod.ts"));
    await run(["workspace", "setup"], moved);
    expect(await fs.readFile(path.join(moved, ".gitignore"), "utf8")).toBe(ignore);
  });

  it("refuses setup outside a workspace", async () => {
    await expect(run(["workspace", "setup"])).rejects.toMatchObject({
      stderr: expect.stringContaining("NOT_A_KONTE_WORKSPACE"),
    });
  });
});
