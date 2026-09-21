function defaultTarget(): string {
  const { platform, arch } = process;
  // On x64, the `-baseline` flavor never matches a locally-installed bun's own
  // build, so bun fetches its official prebuilt runtime instead of reusing the
  // local one. This dodges Nix-packaged bun, whose `--compile` output embeds a
  // runtime pinned to the Nix glibc loader and segfaults outside that store.
  switch (`${platform}/${arch}`) {
    case "linux/x64":
      return "bun-linux-x64-baseline";
    case "linux/arm64":
      return "bun-linux-arm64";
    case "darwin/x64":
      return "bun-darwin-x64-baseline";
    case "darwin/arm64":
      return "bun-darwin-arm64";
    case "win32/x64":
      return "bun-windows-x64-baseline";
    default:
      throw new Error(`Unsupported build platform: ${platform}/${arch}`);
  }
}

const target = process.env.KONTE_COMPILE_TARGET ?? defaultTarget();
const outfile = process.env.KONTE_COMPILE_OUTFILE ?? "dist/konte";

const { exitCode } = Bun.spawnSync(
  [
    "bun",
    "build",
    "src/cli/index.ts",
    "--compile",
    // The entry re-execs itself and has to rebuild its own argv, which differs between a standalone
    // binary and `bun run`. Bun's virtual bundle root is spelled per platform, so the answer comes
    // from here rather than from sniffing that path.
    "--define",
    "KONTE_COMPILED=true",
    `--target=${target}`,
    "--outfile",
    outfile,
  ],
  { stdio: ["inherit", "inherit", "inherit"] },
);

process.exit(exitCode);
