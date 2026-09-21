{
  description = "konte dev environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};

        waza =
          let
            version = "0.37.0";
            dist = {
              x86_64-linux = { suffix = "linux-amd64"; sha256 = "9170008bd5c367d81777572e74a2a796367ff49a5e941291a55e480cd584f971"; };
              aarch64-linux = { suffix = "linux-arm64"; sha256 = "65aa01ef5052bc06629dcea26c3b12b432907b08e3f063e769796e6c1f7895c8"; };
              x86_64-darwin = { suffix = "darwin-amd64"; sha256 = "cea6c2f4ec72b589e2316a875fae70b26513d7259145f1b3a9ec0a407d8a5e6c"; };
              aarch64-darwin = { suffix = "darwin-arm64"; sha256 = "617b45884597f53efdc454794f14522d4d8c8daa479b2e67980eafc88082353d"; };
            }.${system};
          in
          pkgs.stdenvNoCC.mkDerivation {
            pname = "waza";
            inherit version;
            src = pkgs.fetchurl {
              url = "https://github.com/microsoft/waza/releases/download/v${version}/waza-${dist.suffix}";
              inherit (dist) sha256;
            };
            dontUnpack = true;
            nativeBuildInputs = pkgs.lib.optionals pkgs.stdenv.hostPlatform.isLinux [ pkgs.autoPatchelfHook ];
            buildInputs = pkgs.lib.optionals pkgs.stdenv.hostPlatform.isLinux [ pkgs.stdenv.cc.cc.lib pkgs.zlib ];
            installPhase = ''
              runHook preInstall
              install -Dm755 $src $out/bin/waza
              runHook postInstall
            '';
            meta = {
              description = "AI agent skill evaluator (microsoft/waza)";
              homepage = "https://github.com/microsoft/waza";
              mainProgram = "waza";
            };
          };
      in
      {
        packages.waza = waza;

        devShells.default = pkgs.mkShell {
          packages = [
            pkgs.bun
            pkgs.ffmpeg_8
            pkgs.cloudflared
            waza
          ];
        };

        # What CI builds, checks and tests with, minus the dev-only extras.
        devShells.ci = pkgs.mkShell {
          packages = [
            pkgs.bun
            pkgs.ffmpeg_8
            waza
          ];
        };
      }
    );
}
