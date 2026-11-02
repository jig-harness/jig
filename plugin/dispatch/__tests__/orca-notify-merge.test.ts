import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { MAX_COMMENT } from "../lib/runtime/port.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A fake `orca` whose `worktree show` answers `card` and whose `worktree set` records its comment. */
function fakeOrca(card: Record<string, unknown>): {
  script: string;
  sets: () => string[];
} {
  const dir = mkdtempSync(join(tmpdir(), "fake-orca-"));
  dirs.push(dir);
  const script = join(dir, "orca");
  const log = join(dir, "sets.log");
  writeFileSync(log, "");
  writeFileSync(
    script,
    `#!/usr/bin/env bun
import { appendFileSync } from "node:fs";
const a = process.argv.slice(2);
if (a[1] === "set") appendFileSync(${JSON.stringify(log)}, JSON.stringify(a[a.indexOf("--comment") + 1]) + "\\n");
console.log(JSON.stringify({ ok: true, result: { worktree: ${JSON.stringify(card)} } }));
`,
  );
  chmodSync(script, 0o755);
  return {
    script,
    sets: () =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as string),
  };
}

const CHILD = `
import { orcaNotify } from ${JSON.stringify(new URL("../lib/runtime/orca-notify.ts", import.meta.url).pathname)};
const lockless = async (_w, body) => ({ value: await body() });
const [name, message] = process.argv.slice(1);
const receipt = await orcaNotify({ id: "w", path: "/ws/notify-merge/" + name }, message, 5000, lockless);
console.log(JSON.stringify(receipt));
`;

/** Runs `orcaNotify` in a child whose environment names the fake `orca`. */
async function notify(
  orca: { script: string },
  name: string,
  message: string,
): Promise<Record<string, unknown>> {
  const child = Bun.spawnSync([process.execPath, "-e", CHILD, name, message], {
    env: { ...process.env, ORCA_CLI_COMMAND: orca.script },
    stdout: "pipe",
    stderr: "pipe",
  });
  expectSpawnExit(child, 0);
  return JSON.parse(child.stdout.toString()) as Record<string, unknown>;
}

describe("notify on Orca: merging into an unread comment", () => {
  test("appends only the entries the unread comment lacks", async () => {
    const orca = fakeOrca({
      isUnread: true,
      comment: "[jig dispatch: a]\nfirst",
    });
    await notify(
      orca,
      "partial",
      "[jig dispatch: a]\nfirst\n\n[jig dispatch: b]\nsecond",
    );
    expect(orca.sets()).toEqual([
      "[jig dispatch: a]\nfirst\n\n[jig dispatch: b]\nsecond",
    ]);
  });

  test("a merged comment that opens with '-' is passed as text, not a flag", async () => {
    const orca = fakeOrca({ isUnread: true, comment: "- investigate release" });
    await notify(orca, "dash", "[jig dispatch: k]\nx");
    expect(orca.sets()[0]?.startsWith("Unread notes:\n- investigate")).toBe(
      true,
    );
  });

  test("an unread card that names no comment is not overwritten", async () => {
    const orca = fakeOrca({ isUnread: true });
    const receipt = await notify(orca, "nocomment", "[jig dispatch: k]\nx");
    expect(receipt).toMatchObject({ ok: false, lost: false });
    expect(orca.sets()).toEqual([]);
  });

  test("the '-' prefix counts toward the limit", async () => {
    const orca = fakeOrca({
      isUnread: true,
      comment: `-${"n".repeat(MAX_COMMENT - 22)}`,
    });
    const receipt = await notify(orca, "prefix", "[jig dispatch: k]\n" + "x");
    expect(receipt).toMatchObject({ ok: false, lost: false });
    expect(orca.sets()).toEqual([]);
  });

  test("a merged comment past the limit is not written", async () => {
    const orca = fakeOrca({
      isUnread: true,
      comment: "n".repeat(MAX_COMMENT - 5),
    });
    const receipt = await notify(orca, "full", "[jig dispatch: k]\nx");
    expect(receipt).toMatchObject({ ok: false, lost: false });
    expect(orca.sets()).toEqual([]);
  });
});
