{
  description = "OpenClaw Buzz channel plugin — native Nostr (NIP-01/42/29 kind:9)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = {
    self,
    nixpkgs,
  }: let
    systems = ["x86_64-linux" "aarch64-linux"];
    forAllSystems = f:
      nixpkgs.lib.genAttrs systems (system:
        f nixpkgs.legacyPackages.${system});
  in {
    packages = forAllSystems (pkgs: rec {
      openclaw-plugin-buzz = pkgs.buildNpmPackage {
        pname = "openclaw-plugin-buzz";
        version = "0.1.0";
        src = self;
        npmDepsHash = "sha256-d5boWWom+cbxybqIcqBYtB8tJv4BnvVszWlP3JVkaE4=";
        dontNpmBuild = true;
        # Ship the plugin as-is with its installed node_modules (nostr-tools,
        # ws). The consumer adds the node_modules/openclaw peer symlink — same
        # contract as openclaw-herdr.
        installPhase = ''
          runHook preInstall
          mkdir -p $out
          cp -r index.js setup-entry.js runtime.js src openclaw.plugin.json package.json LICENSE NOTICE node_modules $out/
          runHook postInstall
        '';
      };
      default = openclaw-plugin-buzz;
    });
  };
}
