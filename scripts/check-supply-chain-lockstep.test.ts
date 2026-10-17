import { afterAll, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkSupplyChainLockstep } from "./check-supply-chain-lockstep.ts";

const agree = join(
  import.meta.dir,
  "../modules/M1-gates-enforcement-ladder/reference/supply-chain-lockstep/fixtures/agree",
);
const scratch = mkdtempSync(join(tmpdir(), "jig-supply-chain-lockstep-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let roots = 0;
/** A repository root whose files agree with the policy, website included. */
function repo(): string {
  const root = join(scratch, `case-${roots++}`);
  mkdirSync(join(root, ".config"), { recursive: true });
  mkdirSync(join(root, "website"));
  cpSync(
    join(agree, "policy.yaml"),
    join(root, ".config/supply-chain-policy.yaml"),
  );
  for (const file of ["bunfig.toml", "package.json", "renovate.json5"])
    cpSync(join(agree, file), join(root, file));
  for (const file of ["bunfig.toml", "package.json"])
    cpSync(join(agree, file), join(root, "website", file));
  return root;
}

test("the repository and the website install roots agree", () => {
  expect(checkSupplyChainLockstep(repo())).toBe(0);
});

test("the website's own cooldown is checked", () => {
  const weakened = repo();
  writeFileSync(
    join(weakened, "website/bunfig.toml"),
    "[install]\nminimumReleaseAge = 0\n",
  );
  expect(checkSupplyChainLockstep(weakened)).toBe(1);
  const missing = repo();
  rmSync(join(missing, "website/bunfig.toml"));
  expect(checkSupplyChainLockstep(missing)).toBe(2);
});

test("a finding outranks a could-not-check in the same install root", () => {
  const root = repo();
  writeFileSync(
    join(root, "bunfig.toml"),
    "[install]\nminimumReleaseAge = 1\n",
  );
  rmSync(join(root, "renovate.json5"));
  expect(checkSupplyChainLockstep(root)).toBe(1);
});

test("a finding in one install root outranks the other's could-not-check", () => {
  const root = repo();
  // The repository root trusts a package the policy does not allow ...
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ trustedDependencies: ["esbuild", "sharp", "core-js"] }),
  );
  // ... and the website's package.json cannot be read.
  rmSync(join(root, "website/package.json"));
  expect(checkSupplyChainLockstep(root)).toBe(1);
  // Either way round.
  const other = repo();
  rmSync(join(other, "bunfig.toml"));
  writeFileSync(
    join(other, "website/package.json"),
    JSON.stringify({ trustedDependencies: ["esbuild", "sharp", "core-js"] }),
  );
  expect(checkSupplyChainLockstep(other)).toBe(1);
});

test("could-not-check alone is could-not-check", () => {
  const root = repo();
  rmSync(join(root, "website/package.json"));
  expect(checkSupplyChainLockstep(root)).toBe(2);
});
