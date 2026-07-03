# SPDX-FileCopyrightText: 2026 jtekk <jtekk@jtekk.dev>
# SPDX-License-Identifier: GPL-3.0-or-later

{
  description = "Kwilt — dev shell for the KWin tiling script.";

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
          name = "kwilt-dev";

          # Matches the toolchain used by .githooks/* and .github/workflows/check.yml.
          packages = with pkgs; [
            shellcheck
            jq
            nodejs_22
            reuse
          ];

          shellHook = ''
            echo "kwilt dev shell — shellcheck $(shellcheck --version | awk '/^version:/{print $2}'), node $(node --version), jq $(jq --version), reuse $(reuse --version 2>&1 | awk '/version [0-9]/ {print $NF; exit}')"
          '';
        };
      });
}
