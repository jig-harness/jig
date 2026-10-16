import { expect, test } from "bun:test";
import { join } from "node:path";
import {
  LEAKY_GIT_ENV,
  spawnSync,
} from "../../../../plugin/shared/guarded-git-spawn.ts";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";
import { main, namespaceFor, parseOptions } from "./namespace-for-worktree.ts";

const script = join(import.meta.dir, "namespace-for-worktree.ts");
const naming = { prefix: "wt_", maxLength: 63 };

function run(args: string[], extraEnv: Record<string, string> = {}) {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (
      value !== undefined &&
      !LEAKY_GIT_ENV.some((n) => n === key.toUpperCase())
    )
      env[key] = value;
  delete env.WORKTREE_ID;
  const r = spawnSync(process.execPath, [script, ...args], {
    env: { ...env, ...extraEnv },
    input: "",
  });
  return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr };
}

test("the same identity always gets the same name, and two identities differ", () => {
  expect(namespaceFor("feature/refunds", naming)).toBe(
    "wt_feature_refunds_190b79a5137797d4",
  );
  expect(namespaceFor("feature/refunds", naming)).toBe(
    namespaceFor("feature/refunds", naming),
  );
  expect(namespaceFor("fix/rounding--v2", naming)).toMatch(
    /^wt_fix_rounding_v2_[0-9a-f]{16}$/,
  );
  expect(namespaceFor("fix/rounding", naming)).not.toBe(
    namespaceFor("fix/rounding-v2", naming),
  );
});

test("identities that share a slug still get different names", () => {
  const names = ["feature/refunds", "feature-refunds", "Feature/Refunds"].map(
    (id) => namespaceFor(id, naming),
  );
  for (const name of names) expect(name).toStartWith("wt_feature_refunds_");
  expect(new Set(names).size).toBe(3);
});

test("a long identity is cut to fit, and a shared head still differs", () => {
  const head = "a".repeat(70);
  const one = namespaceFor(`${head}/one`, naming);
  const two = namespaceFor(`${head}/two`, naming);
  expect(one).toHaveLength(63);
  expect(two).toHaveLength(63);
  expect(one).not.toBe(two);
  expect(one).toMatch(/^wt_a+_[0-9a-f]{16}$/);
});

test("two long identities whose hashes share 32 bits still get different names", () => {
  const head = `feature/${"a".repeat(60)}`;
  const one = namespaceFor(`${head}10421`, naming);
  const two = namespaceFor(`${head}13897`, naming);
  expect(one.slice(0, -8)).toBe(two.slice(0, -8));
  expect(one).not.toBe(two);
});

test("an identity that leaves no name is refused: the bare prefix is production's", () => {
  expect(() => namespaceFor("///", naming)).toThrow("leaves no name");
  expect(() => namespaceFor("", naming)).toThrow("leaves no name");
});

test("prints the name for an argument or WORKTREE_ID", () => {
  const byArg = run(["feature/refunds"]);
  expectSpawnExit(byArg, 0);
  expect(byArg.stdout).toBe("wt_feature_refunds_190b79a5137797d4\n");
  const byEnv = run([], { WORKTREE_ID: "fix/rounding" });
  expectSpawnExit(byEnv, 0);
  expect(byEnv.stdout).toBe("wt_fix_rounding_7638af83318d09c1\n");
  const prefixed = run([
    "--prefix",
    "dev_",
    "--max-length",
    "24",
    "feature/refunds",
  ]);
  expectSpawnExit(prefixed, 0);
  expect(prefixed.stdout).toMatch(/^dev_fea_[0-9a-f]{16}\n$/);
});

for (const [label, args] of [
  ["no identity", []],
  ["an empty identity", ["//"]],
  ["an empty prefix", ["--prefix", "", "x"]],
  ["a prefix with a capital", ["--prefix", "WT_", "x"]],
  ["a max length too short for a hash", ["--max-length", "12", "x"]],
  [
    "a prefix too long for the default max length",
    ["--prefix", `w${"x".repeat(59)}`, "x"],
  ],
  ["two identities", ["a", "b"]],
  ["an unknown option", ["--frob", "x"]],
] as [string, string[]][])
  test(`${label} is a usage error`, () => {
    const r = run(args);
    expectSpawnExit(r, 2);
    expect(r.stdout).toBe("");
  });

test("parseOptions and main run in-process", () => {
  expect(parseOptions(["feature/x"], {})).toEqual({
    identity: "feature/x",
    naming: { prefix: "wt_", maxLength: 63 },
  });
  expect(parseOptions([], { WORKTREE_ID: "fix/y" }).identity).toBe("fix/y");
  expect(() => parseOptions([], {})).toThrow("no worktree identity");
  expect(main(["feature/x"], {})).toBe(0);
});
