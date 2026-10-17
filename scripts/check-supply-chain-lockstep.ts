// Scope: Jig's own supply-chain policy (.config/supply-chain-policy.yaml)
// against the files that enforce it: the bunfig.toml (Bun's release
// cooldown) and package.json (Bun's install-script allowlist) of each install
// root, the repository's and the website's, and renovate.json5 (the updater),
// measured with M1's lockstep reference gate. Built-ins only, so CI runs it
// before installing dependencies: a change that allows a package to run
// install scripts is judged before any script can run.
import { join } from "node:path";
import { cli } from "../lib/cli.ts";
import { main } from "../modules/M1-gates-enforcement-ladder/reference/supply-chain-lockstep/check-supply-chain-lockstep.ts";

export function checkSupplyChainLockstep(root = "."): number {
  const policy = ["--policy", join(root, ".config/supply-chain-policy.yaml")];
  const repository = main([
    ...policy,
    "--root",
    root,
    "--bunfig",
    join(root, "bunfig.toml"),
    "--package-json",
    join(root, "package.json"),
    "--renovate",
    join(root, "renovate.json5"),
  ]);
  // The website is a second install root: Bun reads its own bunfig.toml and
  // package.json there, not the repository's.
  const website = main([
    ...policy,
    "--root",
    root,
    "--bunfig",
    join(root, "website/bunfig.toml"),
    "--package-json",
    join(root, "website/package.json"),
  ]);
  // A finding (1) in either outranks could-not-check (2), as in the gate
  // runner's verdict: a known violation is reported as one.
  return repository === 1 || website === 1 ? 1 : Math.max(repository, website);
}
if (import.meta.main) cli(() => checkSupplyChainLockstep(process.argv[2]));
