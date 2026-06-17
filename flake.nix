{
  description = "Ixtli — dev shell for the KWin tiling script.";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
      in {
        devShells.default = pkgs.mkShell {
          name = "ixtli-dev";

          # Matches the toolchain used by .githooks/* and .github/workflows/check.yml.
          packages = with pkgs; [
            shellcheck
            jq
            nodejs_22
          ];

          shellHook = ''
            echo "ixtli dev shell — shellcheck $(shellcheck --version | awk '/^version:/{print $2}'), node $(node --version), jq $(jq --version)"
          '';
        };
      });
}
