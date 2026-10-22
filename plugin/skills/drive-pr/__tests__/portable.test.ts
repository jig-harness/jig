import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectFindings,
  recoverState,
  checkLog,
  runAtHead,
} from "../scripts/portable.ts";

import { recoveryCommand } from "../scripts/lib/state/orphans.ts";
import { expectSpawnExit } from "../../../../lib/test-helpers/expect-spawn-exit.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const temp = () => {
  const root = mkdtempSync(join(tmpdir(), "drive-portable-"));
  roots.push(root);
  return root;
};

test("a failed enumeration never reaches the filter or emits partial findings", async () => {
  const calls: string[][] = [];
  const result = await collectFindings(
    "threads",
    ["42", "--bots-only"],
    async (argv) => {
      calls.push(argv);
      return { code: 7, stdout: "partial", stderr: "unreadable" };
    },
  );
  expect(result).toEqual({ code: 7, stdout: "", stderr: "unreadable" });
  expect(calls).toHaveLength(1);
});

test("collection forwards scope to producer and passes records as data to filter", async () => {
  const calls: { argv: string[]; stdin?: string }[] = [];
  const result = await collectFindings(
    "threads",
    ["42", "--bots-only"],
    async (argv, stdin) => {
      calls.push({ argv, ...(stdin !== undefined ? { stdin } : {}) });
      return calls.length === 1
        ? { code: 0, stdout: '{"path":"a & b"}\n', stderr: "" }
        : { code: 0, stdout: "labelled", stderr: "" };
    },
  );
  expect(calls[0]?.argv.slice(-2)).toEqual(["42", "--bots-only"]);
  expect(calls[1]?.argv.slice(-1)).toEqual(["42"]);
  expect(calls[1]?.stdin).toBe('{"path":"a & b"}\n');
  expect(result.stdout).toBe("labelled");
});

test("orphan recovery keeps both files intact if destination already exists", () => {
  const root = temp();
  const source = join(root, "old & one's.json");
  const dest = join(root, "live.json");
  writeFileSync(source, "parked decisions");
  writeFileSync(dest, "live decisions");
  expect(() => recoverState(source, dest)).toThrow();
  expect(readFileSync(source, "utf8")).toBe("parked decisions");
  expect(readFileSync(dest, "utf8")).toBe("live decisions");
});

test("orphan recovery publishes without clobber and only then removes the source", () => {
  const root = temp();
  const source = join(root, "old.json");
  const dest = join(root, "new.json");
  writeFileSync(source, "parked decisions");
  recoverState(source, dest);
  expect(existsSync(source)).toBe(false);
  expect(readFileSync(dest, "utf8")).toBe("parked decisions");
});

test("the log probe refuses directories and does not create absent logs", () => {
  const root = temp();
  const absent = join(root, "missing.log");
  expect(() => checkLog(root)).toThrow();
  expect(() => checkLog(absent)).toThrow();
  expect(existsSync(absent)).toBe(false);
  const log = join(root, "drive.log");
  writeFileSync(log, "existing\n");
  checkLog(log);
  expect(readFileSync(log, "utf8")).toBe("existing\n");
});

test("computed HEAD is supplied as one argument and the mutation exit survives", async () => {
  const calls: string[][] = [];
  const result = await runAtHead(
    "claim-held",
    ["42", "--key", "a & b", "--kind", "finding"],
    undefined,
    async (argv) => {
      calls.push(argv);
      return calls.length === 1
        ? { code: 0, stdout: `${"a".repeat(40)}\n`, stderr: "" }
        : { code: 4, stdout: "", stderr: "not held" };
    },
  );
  expect(calls[0]).toEqual(["git", "rev-parse", "--verify", "HEAD"]);
  expect(calls[1]?.slice(-7)).toEqual([
    "42",
    "--key",
    "a & b",
    "--kind",
    "finding",
    "--pushed-sha",
    "a".repeat(40),
  ]);
  expect(result.code).toBe(4);
});

test("a failed HEAD read never dispatches a held mutation", async () => {
  let calls = 0;
  await expect(
    runAtHead("stamp-held", ["42"], undefined, async () => {
      calls++;
      return { code: 1, stdout: "", stderr: "unreadable HEAD" };
    }),
  ).rejects.toMatchObject({ code: 1 });
  expect(calls).toBe(1);
});

test("the emitted recovery program preserves shell-sensitive paths", () => {
  const root = temp();
  const source = join(root, "orphan's $decision & é.json");
  const destination = join(root, "live's $decision & é.json");
  writeFileSync(source, "parked decisions");
  const command = recoveryCommand(source, destination);
  expect(command.startsWith('bun -e "')).toBe(true);
  const program = command.slice('bun -e "'.length, -1);
  expect(program).not.toMatch(/[$`"\\]/);
  expect(program).not.toContain(source);
  const result = Bun.spawnSync([process.execPath, "-e", program], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expectSpawnExit(result, 0);
  expect(existsSync(source)).toBe(false);
  expect(readFileSync(destination, "utf8")).toBe("parked decisions");
});
