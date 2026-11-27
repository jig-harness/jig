import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { stateStorageNeeds } from "../../dispatch/lib/state-storage-need.ts";
import { admissionTokenCheck } from "../fixture-health.ts";
import {
  exclusiveGcLock,
  sharedGcLock,
  unprovenAdmissionTokens,
} from "../gc-lock.ts";
import { encodeIdentity, ownIdentity, thisHost } from "../liveness.ts";

const lockModule = join(import.meta.dir, "../gc-lock.ts");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "gc-admission-"));
  roots.push(dir);
  return dir;
}
/** Runs `code` in a process that exits, leaving whatever it took behind. */
function exitedAfter(code: string): number {
  const child = Bun.spawnSync([process.execPath, "-e", code], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expectSpawnExit(child, 0);
  return child.pid;
}
/** A reader token that a creator took and never gave back. */
function abandonedToken(dir: string, kind = "scratch"): string {
  exitedAfter(
    `const { sharedGcLock } = await import(${JSON.stringify(lockModule)}); sharedGcLock(${JSON.stringify(kind)}, ${JSON.stringify(dir)});`,
  );
  const [name] = readdirSync(join(dir, kind));
  return join(dir, kind, name as string);
}
function plant(dir: string, kind: string, name: string, text: string): string {
  mkdirSync(join(dir, kind), { recursive: true });
  const path = join(dir, kind, name);
  writeFileSync(path, text);
  return path;
}
const collected = async (dir: string, kind = "scratch") => {
  let ran = false;
  await exclusiveGcLock(
    kind,
    async () => {
      ran = true;
    },
    dir,
  );
  return ran;
};
const refused = (dir: string, kind = "scratch") =>
  exclusiveGcLock(kind, async () => undefined, dir).then(
    () => "",
    (error: Error) => error.message,
  );
const aFewMinutesLater = () => Date.now() + 11 * 60_000;

test("a token whose recorded process no longer exists is removed and the page is collected", async () => {
  const dir = root();
  const token = abandonedToken(dir);
  expect(await collected(dir)).toBe(true);
  expect(existsSync(token)).toBe(false);
  expect(readdirSync(join(dir, "scratch"))).toEqual([]);
});

test.skipIf(thisHost().bootId === "")(
  "a token recorded on another boot is removed although its pid answers",
  async () => {
    const dir = root();
    const token = plant(
      dir,
      "scratch",
      `reader-${process.pid}-earlier-boot`,
      encodeIdentity({ ...ownIdentity(), bootId: "not-this-boot" }),
    );
    expect(await collected(dir)).toBe(true);
    expect(existsSync(token)).toBe(false);
  },
);

test("a token with no record blocks collection, is kept and is reported once it has stood", async () => {
  const dir = root();
  const token = plant(dir, "scratch", "reader-unrecorded", "");
  expect(await refused(dir)).toContain("a creator holds the lock");
  expect(existsSync(token)).toBe(true);
  expect(unprovenAdmissionTokens(dir, Date.now())).toEqual([]);
  expect(unprovenAdmissionTokens(dir, aFewMinutesLater())).toEqual([
    { path: token, why: `${token}: it names no holder to judge` },
  ]);
});

test("a token of a live process blocks collection and is never reported", async () => {
  const dir = root();
  const release = sharedGcLock("scratch", dir);
  try {
    expect(await refused(dir)).toContain("a creator holds the lock");
    expect(readdirSync(join(dir, "scratch"))).toHaveLength(1);
    expect(unprovenAdmissionTokens(dir, aFewMinutesLater())).toEqual([]);
  } finally {
    release();
  }
});

test("a token of another host blocks collection, is kept and is reported", async () => {
  const dir = root();
  const token = plant(
    dir,
    "scratch",
    `reader-${process.pid}-elsewhere`,
    encodeIdentity({
      ...ownIdentity(),
      hostId: "f".repeat(32),
      host: "another-host",
    }),
  );
  expect(await refused(dir)).toContain("a creator holds the lock");
  expect(existsSync(token)).toBe(true);
  expect(
    unprovenAdmissionTokens(dir, aFewMinutesLater()).map((t) => t.path),
  ).toEqual([token]);
});

test("a token in an earlier form that names no host is kept and reported at once", async () => {
  const dir = root();
  const pid = exitedAfter("0");
  const token = plant(dir, "scratch", `reader-${pid}-earlier`, "");
  expect(await refused(dir)).toContain(`stale admission token ${token}`);
  expect(existsSync(token)).toBe(true);
  expect(unprovenAdmissionTokens(dir, Date.now())).toHaveLength(1);
});

test("a token that gc removes and one it keeps are told apart in the same run", async () => {
  const dir = root();
  const gone = abandonedToken(dir);
  const unrecorded = plant(dir, "scratch", "reader-unrecorded", "");
  expect(await refused(dir)).toContain("a creator holds the lock");
  expect(existsSync(gone)).toBe(false);
  expect(existsSync(unrecorded)).toBe(true);
});

test("a scratch collector killed inside its lock is taken over, and a live writer is not", async () => {
  const dir = root();
  exitedAfter(
    `const { exclusiveGcLock } = await import(${JSON.stringify(lockModule)}); await exclusiveGcLock("scratch", async () => process.exit(0), ${JSON.stringify(dir)});`,
  );
  const writer = join(dir, "scratch", "writer");
  expect(existsSync(writer)).toBe(true);
  expect(await collected(dir)).toBe(true);
  expect(existsSync(writer)).toBe(false);

  writeFileSync(writer, encodeIdentity(ownIdentity()));
  expect(await refused(dir)).toContain("another collection holds");
  expect(existsSync(writer)).toBe(true);
});

test("a dead collector's writer of another kind is kept and reported", async () => {
  const dir = root();
  exitedAfter(
    `const { exclusiveGcLock } = await import(${JSON.stringify(lockModule)}); await exclusiveGcLock("receipts", async () => process.exit(0), ${JSON.stringify(dir)});`,
  );
  const writer = join(dir, "receipts", "writer");
  expect(await refused(dir, "receipts")).toContain(
    "names a process that has exited",
  );
  expect(existsSync(writer)).toBe(true);
  expect(unprovenAdmissionTokens(dir, Date.now()).map((t) => t.path)).toEqual([
    writer,
  ]);
});

test("the doctor check passes with no token and names the tokens a person must inspect", () => {
  expect(admissionTokenCheck(() => [])).toMatchObject({
    id: "gc:admission-tokens",
    status: "pass",
  });
  const tokens = ["a", "b", "c", "d"].map((name) => ({
    path: `/locks/scratch/reader-${name}`,
    why: `/locks/scratch/reader-${name}: it names no holder to judge`,
  }));
  const check = admissionTokenCheck(() => tokens);
  expect(check.status).toBe("fail");
  expect(check.detail).toContain("4 admission token(s)");
  expect(check.detail).toContain("/locks/scratch/reader-a");
  expect(check.detail).toContain("/locks/scratch/reader-c");
  expect(check.detail).not.toContain("reader-d");
  expect(check.detail).toContain("1 more");
  expect(check.fix).toContain("Inspect each token's holder");
});

test("a token gc cannot judge raises one state-storage need while it stands", () => {
  const check = admissionTokenCheck(() => [
    { path: "/locks/scratch/reader-x", why: "/locks/scratch/reader-x: unread" },
  ]);
  const first = stateStorageNeeds([check], [], "2026-01-01T00:00:00.000Z");
  expect(first).toHaveLength(1);
  expect(first[0]).toMatchObject({
    cause: "state-storage",
    repo: "host",
    target: "gc:admission-tokens",
  });
  expect(first[0]?.reason).toContain("/locks/scratch/reader-x");
  const later = stateStorageNeeds([check], first, "2026-01-02T00:00:00.000Z");
  expect(later[0]?.since).toBe("2026-01-01T00:00:00.000Z");
  expect(
    stateStorageNeeds([admissionTokenCheck(() => [])], first, "now"),
  ).toEqual([]);
});

test("a token's age counts only from its last write", () => {
  const dir = root();
  const token = plant(dir, "scratch", "reader-unrecorded", "");
  const old = new Date(Date.now() - 3_600_000);
  utimesSync(token, old, old);
  expect(unprovenAdmissionTokens(dir, Date.now())).toHaveLength(1);
});
