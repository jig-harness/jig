import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { checksum } from "./allocate-port";
const gate = join(import.meta.dir, "allocate-port.ts");
function run(args: string[] = [], env: Record<string, string> = {}) {
  return Bun.spawnSync([process.execPath, gate, ...args], {
    env: {
      ...process.env,
      WORKTREE_ID: "",
      PORT_BASE: "",
      PORT_SPAN: "",
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}
for (const row of readFileSync(
  join(import.meta.dir, "fixtures/golden-ports.tsv"),
  "utf8",
).split(/\r?\n/)) {
  if (!row || row.startsWith("#")) continue;
  const [id, port] = row.trim().split(/\s+/);
  test(`golden ${id}`, () => {
    expect(20000 + (checksum(id ?? "") % 1000)).toBe(Number(port));
    expect(
      run([id ?? ""])
        .stdout.toString()
        .trim(),
    ).toBe(port ?? "");
    expect(run([id ?? ""]).stdout.toString()).toBe(
      run([id ?? ""]).stdout.toString(),
    );
  });
}
test("argument and environment agree", () =>
  expect(run([], { WORKTREE_ID: "main" }).stdout.toString()).toBe(
    run(["main"]).stdout.toString(),
  ));
test("range and distinctness", () => {
  const ids = [
    "main",
    "develop",
    "feature-a",
    "feature-b",
    "bugfix-c",
    "release-9",
    "spike/xyz",
    "agent_7",
  ];
  for (const id of ids) {
    const port = Number(
      run([id], { PORT_BASE: "30000", PORT_SPAN: "200" }).stdout.toString(),
    );
    expect(port).toBeGreaterThanOrEqual(30000);
    expect(port).toBeLessThan(30200);
  }
  expect(
    new Set(
      ["main", "feature-login", "feature-logout", "bugfix-auth"].map(
        (id) => checksum(id) % 1000,
      ),
    ).size,
  ).toBe(4);
});
for (const env of [
  { PORT_SPAN: "0" },
  { PORT_SPAN: "abc" },
  { PORT_BASE: "xx" },
  { PORT_BASE: "65500", PORT_SPAN: "1000" },
  { PORT_BASE: "0" },
  { PORT_BASE: "999999999999999999999999" },
] as Record<string, string>[])
  test(`bad range ${JSON.stringify(env)}`, () =>
    expect(run(["x"], env).exitCode).toBe(2));
test("missing identity errors", () => expect(run().exitCode).toBe(2));
