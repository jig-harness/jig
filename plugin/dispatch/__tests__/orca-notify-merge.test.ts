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
import { orcaNotify } from "../lib/runtime/orca-notify.ts";
import { MAX_COMMENT } from "../lib/runtime/port.ts";

const dirs: string[] = [];
const saved = process.env.ORCA_CLI_COMMAND;

afterEach(() => {
  process.env.ORCA_CLI_COMMAND = saved;
  if (saved === undefined) delete process.env.ORCA_CLI_COMMAND;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A fake `orca` whose `worktree show` answers `card` and whose `worktree set` records its comment. */
function fakeOrca(card: Record<string, unknown>): { sets: () => string[] } {
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
  process.env.ORCA_CLI_COMMAND = script;
  return {
    sets: () =>
      readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as string),
  };
}

const target = (name: string) => ({
  id: "w",
  path: `/ws/notify-merge/${name}`,
});
const lockless = async <T>(_w: string, body: () => Promise<T>) => ({
  value: await body(),
});

describe("notify on Orca: merging into an unread comment", () => {
  test("appends only the entries the unread comment lacks", async () => {
    const orca = fakeOrca({
      isUnread: true,
      comment: "[jig dispatch: a]\nfirst",
    });
    await orcaNotify(
      target("partial"),
      "[jig dispatch: a]\nfirst\n\n[jig dispatch: b]\nsecond",
      5000,
      lockless,
    );
    expect(orca.sets()).toEqual([
      "[jig dispatch: a]\nfirst\n\n[jig dispatch: b]\nsecond",
    ]);
  });

  test("a merged comment that opens with '-' is passed as text, not a flag", async () => {
    const orca = fakeOrca({ isUnread: true, comment: "- investigate release" });
    await orcaNotify(target("dash"), "[jig dispatch: k]\nx", 5000, lockless);
    expect(orca.sets()[0]?.startsWith("Unread notes:\n- investigate")).toBe(
      true,
    );
  });

  test("an unread card that names no comment is not overwritten", async () => {
    const orca = fakeOrca({ isUnread: true });
    const receipt = await orcaNotify(
      target("nocomment"),
      "[jig dispatch: k]\nx",
      5000,
      lockless,
    );
    expect(receipt).toMatchObject({ ok: false, lost: false });
    expect(orca.sets()).toEqual([]);
  });

  test("a merged comment past the limit is not written", async () => {
    const orca = fakeOrca({
      isUnread: true,
      comment: "n".repeat(MAX_COMMENT - 5),
    });
    const receipt = await orcaNotify(
      target("full"),
      "[jig dispatch: k]\nx",
      5000,
      lockless,
    );
    expect(receipt).toMatchObject({ ok: false, lost: false });
    expect(orca.sets()).toEqual([]);
  });
});
