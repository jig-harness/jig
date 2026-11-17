/**
 * The launch guard record: the files gc and Jig's plugin for Orca leave each
 * other. The plugin's files are written here the way a dependency-free Node
 * writer would (plain JSON, a temporary file renamed into place), so the
 * tests hold gc's reader to the contract the README states, not to this
 * module's own writer.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileLockPath } from "../file-lock.ts";
import {
  expectSpawnExit,
  expectSpawnExited,
} from "../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  encodeIdentity,
  ownIdentity,
  type ProcessIdentity,
} from "../liveness.ts";
import {
  ADMISSION_KIND,
  ADMISSION_VERSION,
  admit,
  incarnationOf,
  guardKey,
  guardRoot,
  guardState,
  HEARTBEAT_FRESH_MS,
  LAUNCH_RETENTION_MS,
  LAUNCH_SETTLING_MS,
  launchVeto,
  releaseAbsent,
  releaseSuperseded,
  repositoryOwner,
  supersedes,
  staleAdmissions,
  sweepLaunches,
} from "../orca-guard.ts";

const MODULE = resolve(import.meta.dir, "../orca-guard.ts");
const PATH = "/home/someone/orca/workspaces/app/topic";
const REPO = "/home/someone/dev/app";
const DAY_MS = 86_400_000;

const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "orca-guard-"));
  temporary.push(dir);
  return dir;
}

/** Write `record` at `file` as the plugin does: a temporary file in the same directory, renamed into place. */
function pluginWrite(file: string, record: unknown): void {
  const dir = resolve(file, "..");
  mkdirSync(dir, { recursive: true });
  const staged = join(dir, `.write.${process.pid}.${Math.random()}.tmp`);
  writeFileSync(staged, JSON.stringify(record));
  renameSync(staged, file);
}

function launchMarker(root: string, at: Date, over: object = {}): string {
  const key = guardKey(PATH);
  const file = join(root, "launches", `${key}.json`);
  pluginWrite(file, {
    kind: "orca-guard-launch",
    v: 1,
    key,
    writer: { host: hostname(), pid: process.pid },
    at: at.toISOString(),
    path: PATH,
    workspaceId: "ws-1",
    agent: "claude",
    ...over,
  });
  return file;
}

function heartbeat(root: string, at: Date, over: object = {}): void {
  pluginWrite(join(root, "heartbeat.json"), {
    kind: "orca-guard-heartbeat",
    v: 1,
    key: "heartbeat",
    writer: { host: hostname(), pid: process.pid },
    at: at.toISOString(),
    pid: process.pid,
    pluginVersion: "0.4.0",
    ...over,
  });
}

/** A record file's JSON. */
function read(file: string) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/** A process identity whose process has exited. */
function deadHolder(): ProcessIdentity {
  const child = Bun.spawnSync([process.execPath, "-e", "0"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  expectSpawnExit(child, 0);
  return {
    ...ownIdentity(),
    pid: child.pid,
    start: "Thu Jan  1 00:00:00 1970",
  };
}

describe("the guard's place and key", () => {
  it("lives under the home directory's Jig state, whatever the platform", () => {
    expect(guardRoot("/home/someone")).toBe(
      join("/home/someone", ".local", "state", "jig", "orca-guard"),
    );
  });

  it("keys a worktree by the SHA-256 of its path exactly as given", () => {
    expect(guardKey(PATH)).toBe(
      createHash("sha256").update(PATH).digest("hex"),
    );
    expect(guardKey(PATH)).toMatch(/^[0-9a-f]{64}$/);
    expect(guardKey(`${PATH}/`)).not.toBe(guardKey(PATH));
  });
});

describe("the heartbeat", () => {
  const now = Date.parse("2026-11-05T12:00:00.000Z");

  it("is unguarded when the plugin wrote none", () => {
    expect(guardState(scratch(), now)).toEqual({
      guarded: false,
      reason: "unguarded: the Orca plugin has written no heartbeat",
    });
  });

  it("is guarded while its at is within the freshness window", () => {
    const root = scratch();
    heartbeat(root, new Date(now - HEARTBEAT_FRESH_MS));
    expect(guardState(root, now)).toMatchObject({ guarded: true });
  });

  it("is unguarded once it is staler than the window", () => {
    const root = scratch();
    heartbeat(root, new Date(now - HEARTBEAT_FRESH_MS - 1000));
    expect(guardState(root, now)).toEqual({
      guarded: false,
      reason: "unguarded: the Orca plugin's heartbeat is 181 s old",
    });
  });

  it("is unguarded when it does not parse or names an unknown version", () => {
    const root = scratch();
    writeFileSync(join(root, "heartbeat.json"), '{"kind":"orca-guard-heart');
    expect(guardState(root, now).guarded).toBe(false);
    heartbeat(root, new Date(now), { v: 2 });
    expect(guardState(root, now).guarded).toBe(false);
  });

  it("is unguarded without the kind's own fields", () => {
    const root = scratch();
    heartbeat(root, new Date(now), { pid: undefined });
    expect(guardState(root, now).guarded).toBe(false);
    heartbeat(root, new Date(now), { pluginVersion: undefined });
    expect(guardState(root, now).guarded).toBe(false);
  });

  it("is unguarded for a pid that is not a positive safe integer", () => {
    const root = scratch();
    for (const pid of [0, -4, 2 ** 53, 1.5]) {
      heartbeat(root, new Date(now), { pid });
      expect(guardState(root, now).guarded).toBe(false);
    }
  });

  it("compares the raw age to the window, not the rounded one", () => {
    const root = scratch();
    heartbeat(root, new Date(now - HEARTBEAT_FRESH_MS - 499));
    expect(guardState(root, now).guarded).toBe(false);
    heartbeat(root, new Date(now - HEARTBEAT_FRESH_MS));
    expect(guardState(root, now).guarded).toBe(true);
  });
});

describe("the admission", () => {
  it("writes the envelope, the path, the repository and the holder, and release deletes it", () => {
    const root = scratch();
    const now = Temporal.Instant.from(
      "2026-11-05T12:00:00.000Z",
    ).epochMilliseconds;
    const holder = ownIdentity();
    const admission = admit(PATH, REPO, root, now, holder);
    if (!admission.ok) throw new Error(admission.failure.reason);
    const file = join(root, "admissions", `${guardKey(PATH)}.json`);
    expect(admission.value.file).toBe(file);
    const record = JSON.parse(readFileSync(file, "utf8"));
    expect(Object.keys(record)).toEqual([
      "kind",
      "v",
      "key",
      "writer",
      "at",
      "path",
      "repository",
      "holder",
    ]);
    expect(record).toMatchObject({
      kind: ADMISSION_KIND,
      v: ADMISSION_VERSION,
      key: guardKey(PATH),
      writer: { host: holder.host, pid: holder.pid },
      at: "2026-11-05T12:00:00.000Z",
      path: PATH,
      repository: REPO,
      holder: { ...holder },
    });
    expect(readdirSync(join(root, "admissions"))).toEqual([
      `${guardKey(PATH)}.json`,
    ]);
    admission.value.release();
    expect(existsSync(file)).toBe(false);
  });

  it("refuses while a live holder's admission stands, and replaces a dead holder's", () => {
    const root = scratch();
    const first = admit(PATH, REPO, root);
    expect(first.ok).toBe(true);
    const second = admit(PATH, REPO, root);
    expect(second.ok ? null : second.failure.code).toBe("held");
    if (first.ok) first.value.release();

    const stale = admit(PATH, REPO, root, undefined, deadHolder());
    expect(stale.ok).toBe(true);
    const taken = admit(PATH, REPO, root);
    if (!taken.ok) throw new Error(taken.failure.reason);
    // The stale holder's release leaves the admission that replaced it.
    if (stale.ok) stale.value.release();
    expect(existsSync(taken.value.file)).toBe(true);
    taken.value.release();
    expect(existsSync(taken.value.file)).toBe(false);
  });

  it("refuses, and leaves in place, an admission that does not parse or names an unknown version", () => {
    const root = scratch();
    const file = join(root, "admissions", `${guardKey(PATH)}.json`);
    mkdirSync(join(root, "admissions"), { recursive: true });
    for (const text of [
      '{"kind":"orca-guard-adm',
      JSON.stringify({
        kind: "orca-guard-admission",
        v: ADMISSION_VERSION + 1,
        key: guardKey(PATH),
        writer: { host: "h" },
        at: new Date().toISOString(),
      }),
    ]) {
      writeFileSync(file, text);
      const refused = admit(PATH, REPO, root);
      expect(refused.ok ? null : refused.failure).toMatchObject({
        code: "unreadable",
        reason: expect.stringContaining("remove it after inspection"),
      });
      expect(readFileSync(file, "utf8")).toBe(text);
    }
  });

  it("leaves a dead holder's admission whose path or key does not bind to its slot", () => {
    const root = scratch();
    const file = join(root, "admissions", `${guardKey(PATH)}.json`);
    const dead = admit(PATH, REPO, root, undefined, deadHolder());
    if (!dead.ok) throw new Error(dead.failure.reason);
    const good = JSON.parse(readFileSync(file, "utf8"));
    for (const damaged of [
      { ...good, path: undefined },
      { ...good, path: `${PATH}-other` },
      { ...good, key: guardKey(`${PATH}-other`) },
    ]) {
      const text = JSON.stringify(damaged);
      writeFileSync(file, text);
      const refused = admit(PATH, REPO, root);
      expect(refused.ok ? null : refused.failure.code).toBe("unreadable");
      expect(readFileSync(file, "utf8")).toBe(text);
    }
  });

  it.each([
    ["an empty slot", false],
    ["a dead holder's admission", true],
  ])(
    "admits exactly one of several collectors racing for %s",
    async (_name, seeded) => {
      const root = scratch();
      if (seeded) admit(PATH, REPO, root, undefined, deadHolder());
      const signals = scratch();
      const script = join(signals, "contender.ts");
      writeFileSync(
        script,
        `import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { admit } from ${JSON.stringify(MODULE)};
const [root, signals, index] = process.argv.slice(2);
const until = (name: string) => {
  const deadline = Date.now() + 30_000;
  while (!existsSync(join(signals, name)))
    if (Date.now() > deadline) process.exit(3);
    else Bun.sleepSync(5);
};
until("go");
const admission = admit(${JSON.stringify(PATH)}, ${JSON.stringify(REPO)}, root);
writeFileSync(join(signals, "result-" + index + ".json"), JSON.stringify(admission.ok ? { ok: true } : { ok: false, code: admission.failure.code }));
until("done");
if (admission.ok) admission.value.release();
`,
      );
      const count = 6;
      const children = Array.from({ length: count }, (_, i) =>
        Bun.spawn([process.execPath, script, root, signals, String(i)], {
          stdout: "pipe",
          stderr: "pipe",
        }),
      );
      writeFileSync(join(signals, "go"), "");
      const deadline = Date.now() + 30_000;
      const results = () =>
        readdirSync(signals).filter((name) => name.startsWith("result-"));
      while (results().length < count && Date.now() < deadline)
        await Bun.sleep(20);
      writeFileSync(join(signals, "done"), "");
      for (const child of children) await expectSpawnExited(child, 0);
      const answers = results().map((name) =>
        JSON.parse(readFileSync(join(signals, name), "utf8")),
      );
      expect(answers).toHaveLength(count);
      expect(answers.filter((a) => a.ok)).toHaveLength(1);
      expect(answers.filter((a) => !a.ok).map((a) => a.code)).toEqual(
        Array(count - 1).fill("held"),
      );
      expect(readdirSync(join(root, "admissions"))).toEqual([]);
    },
    60_000,
  );
});

describe("the submitted mark", () => {
  it("is written over the admission, keeping when and by whom it was written, and release still deletes it", () => {
    const root = scratch();
    const admitted = Temporal.Instant.from(
      "2026-11-05T12:00:00.000Z",
    ).epochMilliseconds;
    const admission = admit(PATH, REPO, root, admitted);
    if (!admission.ok) throw new Error(admission.failure.reason);
    expect(admission.value.submitted).toBeNull();
    const before = read(admission.value.file);
    const marked = admission.value.submit(admitted + 5_000);
    expect(marked).toEqual({ ok: true, value: true });
    expect(admission.value.submitted).toBe("2026-11-05T12:00:05.000Z");
    const after = read(admission.value.file);
    expect(after).toEqual({ ...before, submitted: "2026-11-05T12:00:05.000Z" });
    expect(readdirSync(join(root, "admissions"))).toEqual([
      `${guardKey(PATH)}.json`,
    ]);
    admission.value.release();
    expect(existsSync(admission.value.file)).toBe(false);
  });

  it("is refused, and nothing is marked, once the admission is no longer this one", () => {
    const root = scratch();
    const admission = admit(PATH, REPO, root);
    if (!admission.ok) throw new Error(admission.failure.reason);
    const other = JSON.stringify({
      ...read(admission.value.file),
      at: "2026-11-05T13:00:00.000Z",
    });
    writeFileSync(admission.value.file, other);
    const marked = admission.value.submit();
    expect(marked.ok ? null : marked.failure.code).toBe("held");
    expect(admission.value.submitted).toBeNull();
    expect(readFileSync(admission.value.file, "utf8")).toBe(other);
  });

  it("is carried into the admission that takes over a dead holder's, which an unsubmitted one is not", () => {
    const root = scratch();
    const stale = admit(PATH, REPO, root, undefined, deadHolder());
    if (!stale.ok) throw new Error(stale.failure.reason);
    const taken = admit(PATH, REPO, root);
    if (!taken.ok) throw new Error(taken.failure.reason);
    expect(taken.value.submitted).toBeNull();
    expect(read(taken.value.file).submitted).toBeUndefined();
    taken.value.release();

    const crashed = admit(PATH, REPO, root, undefined, deadHolder());
    if (!crashed.ok) throw new Error(crashed.failure.reason);
    if (!crashed.value.submit(Date.parse("2026-11-05T12:00:00.000Z")).ok)
      throw new Error("the mark was not written");
    const next = admit(PATH, REPO, root);
    if (!next.ok) throw new Error(next.failure.reason);
    expect(next.value.submitted).toBe("2026-11-05T12:00:00.000Z");
    expect(read(next.value.file)).toMatchObject({
      submitted: "2026-11-05T12:00:00.000Z",
      holder: { pid: process.pid },
    });
    next.value.release();
  });

  it("that is not a time makes the admission one gc cannot read", () => {
    const root = scratch();
    const dead = admit(PATH, REPO, root, undefined, deadHolder());
    if (!dead.ok) throw new Error(dead.failure.reason);
    const text = JSON.stringify({ ...read(dead.value.file), submitted: 7 });
    writeFileSync(dead.value.file, text);
    const refused = admit(PATH, REPO, root);
    expect(refused.ok ? null : refused.failure.code).toBe("unreadable");
    expect(staleAdmissions(root)).toEqual([]);
    expect(readFileSync(dead.value.file, "utf8")).toBe(text);
  });
});

describe("a dead holder's admission on a worktree that is gone", () => {
  const OTHER = `${PATH}-other`;

  it("is listed with its path and mark; a live holder's is not", () => {
    const root = scratch();
    const dead = admit(PATH, REPO, root, undefined, deadHolder());
    if (!dead.ok) throw new Error(dead.failure.reason);
    dead.value.submit(Date.parse("2026-11-05T12:00:00.000Z"));
    const live = admit(OTHER, REPO, root);
    if (!live.ok) throw new Error(live.failure.reason);
    live.value.submit();
    expect(staleAdmissions(root)).toEqual([
      {
        file: dead.value.file,
        path: PATH,
        submitted: "2026-11-05T12:00:00.000Z",
        repository: REPO,
        incarnation: null,
      },
    ]);
    live.value.release();
    expect(staleAdmissions(scratch())).toEqual([]);
  });

  it("is deleted only while the worktree is absent, and a live holder's never", () => {
    const root = scratch();
    const dead = admit(PATH, REPO, root, undefined, deadHolder());
    if (!dead.ok) throw new Error(dead.failure.reason);
    dead.value.submit();
    const present = releaseAbsent(PATH, REPO, () => false, root);
    expect(present.ok ? null : present.failure.code).toBe("present");
    expect(existsSync(dead.value.file)).toBe(true);
    expect(releaseAbsent(PATH, REPO, () => true, root)).toEqual({
      ok: true,
      value: true,
    });
    expect(existsSync(dead.value.file)).toBe(false);
    expect(readdirSync(join(root, "admissions"))).toEqual([]);

    const live = admit(PATH, REPO, root);
    if (!live.ok) throw new Error(live.failure.reason);
    live.value.submit();
    const held = releaseAbsent(PATH, REPO, () => true, root);
    expect(held.ok ? null : held.failure.code).toBe("held");
    expect(existsSync(live.value.file)).toBe(true);
    live.value.release();
  });
});

describe("the repository an admission names", () => {
  it("is the repository's path with its links resolved", () => {
    const dir = scratch();
    const link = join(dir, "link");
    symlinkSync(dir, link);
    expect(repositoryOwner(link)).toBe(realpathSync.native(dir));
    expect(repositoryOwner(join(dir, "missing", "..", "gone"))).toBe(
      join(dir, "gone"),
    );
  });

  it("is the only one whose collection releases a dead holder's admission on a gone worktree", () => {
    const root = scratch();
    const dead = admit(PATH, REPO, root, undefined, deadHolder());
    if (!dead.ok) throw new Error(dead.failure.reason);
    dead.value.submit();
    const other = releaseAbsent(PATH, `${REPO}-other`, () => true, root);
    expect(other.ok ? null : other.failure).toMatchObject({
      code: "present",
      reason: expect.stringContaining("not"),
    });
    expect(existsSync(dead.value.file)).toBe(true);
    expect(releaseAbsent(PATH, REPO, () => true, root).ok).toBe(true);
    expect(existsSync(dead.value.file)).toBe(false);
  });

  it("is required of a version 2 admission", () => {
    const root = scratch();
    const dead = admit(PATH, REPO, root, undefined, deadHolder());
    if (!dead.ok) throw new Error(dead.failure.reason);
    const text = JSON.stringify({ ...read(dead.value.file), repository: "" });
    writeFileSync(dead.value.file, text);
    const refused = admit(PATH, REPO, root);
    expect(refused.ok ? null : refused.failure.code).toBe("unreadable");
    expect(staleAdmissions(root)).toEqual([]);
    expect(readFileSync(dead.value.file, "utf8")).toBe(text);
  });
});

describe("a version 1 admission, written before admissions named their repository", () => {
  /** A dead holder's admission as an earlier release wrote it. */
  function writeV1(root: string, submitted?: string): string {
    const file = join(root, "admissions", `${guardKey(PATH)}.json`);
    const holder = deadHolder();
    pluginWrite(file, {
      kind: ADMISSION_KIND,
      v: 1,
      key: guardKey(PATH),
      writer: { host: holder.host, pid: holder.pid },
      at: "2026-11-05T12:00:00.000Z",
      path: PATH,
      holder: JSON.parse(encodeIdentity(holder)),
      ...(submitted === undefined ? {} : { submitted }),
    });
    return file;
  }

  it("reads, naming no repository and no incarnation, and no collection's list releases it", () => {
    const root = scratch();
    const file = writeV1(root, "2026-11-05T12:01:00.000Z");
    expect(staleAdmissions(root)).toEqual([
      {
        file,
        path: PATH,
        submitted: "2026-11-05T12:01:00.000Z",
        repository: null,
        incarnation: null,
      },
    ]);
    const kept = releaseAbsent(PATH, REPO, () => true, root);
    expect(kept.ok ? null : kept.failure.code).toBe("present");
    expect(existsSync(file)).toBe(true);
  });

  it("is taken over by a collection of its worktree, keeping its mark, as version 2", () => {
    const root = scratch();
    writeV1(root, "2026-11-05T12:01:00.000Z");
    const taken = admit(PATH, REPO, root);
    if (!taken.ok) throw new Error(taken.failure.reason);
    expect(taken.value.submitted).toBe("2026-11-05T12:01:00.000Z");
    expect(read(taken.value.file)).toMatchObject({
      v: ADMISSION_VERSION,
      repository: REPO,
      submitted: "2026-11-05T12:01:00.000Z",
    });
    taken.value.release();
  });
});

describe("the incarnation an admission names", () => {
  /** A worktree directory at a path of its own, and a guard root. */
  function worktree(): { tree: string; root: string } {
    const dir = scratch();
    const tree = join(dir, "topic");
    mkdirSync(tree);
    return { tree, root: join(dir, "guard") };
  }

  /** The worktree removed and made again at the same path. */
  function remake(tree: string): void {
    const before = incarnationOf(tree);
    // A filesystem may stamp the new directory with the same birth time (or
    // none): remake until one is born strictly later, within a deadline.
    const deadline = performance.now() + 5000;
    do {
      rmSync(tree, { recursive: true });
      mkdirSync(tree);
      if (supersedes(incarnationOf(tree), before)) return;
      Bun.sleepSync(5);
    } while (performance.now() < deadline);
    throw new Error(`no later incarnation was born at ${tree}: ${before}`);
  }

  it("is superseded only by one born strictly later, whatever the inode says", () => {
    expect(supersedes("7:200", "7:100")).toBe(true);
    expect(supersedes("8:200", "7:100")).toBe(true);
    expect(supersedes("8:100", "7:100")).toBe(false);
    expect(supersedes("8:50", "7:100")).toBe(false);
    expect(supersedes("8:200", "7:0")).toBe(false);
    expect(supersedes("8:0", "7:100")).toBe(false);
    expect(supersedes(null, "7:100")).toBe(false);
    expect(supersedes("8:200", null)).toBe(false);
    expect(supersedes("8:200", "not an incarnation")).toBe(false);
  });

  it("is what stands at the worktree's path when gc admits it, and none where nothing does", () => {
    const { tree, root } = worktree();
    const admitted = admit(tree, REPO, root);
    if (!admitted.ok) throw new Error(admitted.failure.reason);
    expect(read(admitted.value.file).incarnation).toBe(incarnationOf(tree));
    expect(incarnationOf(tree)).toEqual(expect.any(String));
    expect(incarnationOf(join(tree, "missing"))).toBeNull();
    admitted.value.release();
  });

  it("releases a dead holder's admission once another worktree is made at its path, and only then", () => {
    const { tree, root } = worktree();
    const dead = admit(tree, REPO, root, undefined, deadHolder());
    if (!dead.ok) throw new Error(dead.failure.reason);
    dead.value.submit();
    const same = releaseSuperseded(tree, root);
    expect(same.ok ? null : same.failure.code).toBe("present");
    expect(existsSync(dead.value.file)).toBe(true);
    remake(tree);
    expect(releaseSuperseded(tree, root)).toEqual({ ok: true, value: true });
    expect(existsSync(dead.value.file)).toBe(false);
  });

  it("keeps an admission that names no incarnation, and a live holder's", () => {
    const { tree, root } = worktree();
    const dead = admit(tree, REPO, root, undefined, deadHolder());
    if (!dead.ok) throw new Error(dead.failure.reason);
    const { incarnation: _, ...unnamed } = read(dead.value.file);
    writeFileSync(dead.value.file, JSON.stringify(unnamed));
    remake(tree);
    const kept = releaseSuperseded(tree, root);
    expect(kept.ok ? null : kept.failure.code).toBe("present");
    expect(existsSync(dead.value.file)).toBe(true);
    rmSync(dead.value.file);

    const live = admit(tree, REPO, root);
    if (!live.ok) throw new Error(live.failure.reason);
    remake(tree);
    const held = releaseSuperseded(tree, root);
    expect(held.ok ? null : held.failure.code).toBe("held");
    expect(existsSync(live.value.file)).toBe(true);
    live.value.release();
  });

  it("decides whether a taken-over admission's mark still holds: not once the worktree was made again", () => {
    const { tree, root } = worktree();
    const crashed = admit(tree, REPO, root, undefined, deadHolder());
    if (!crashed.ok) throw new Error(crashed.failure.reason);
    crashed.value.submit(
      Temporal.Instant.from("2026-11-05T12:00:00.000Z").epochMilliseconds,
    );
    remake(tree);
    const next = admit(tree, REPO, root);
    if (!next.ok) throw new Error(next.failure.reason);
    expect(next.value.submitted).toBeNull();
    expect(read(next.value.file)).toMatchObject({
      incarnation: incarnationOf(tree),
    });
    expect(read(next.value.file).submitted).toBeUndefined();
    next.value.release();
  });
});

describe("a taken-over admission's carried mark", () => {
  it("keeps the incarnation it was written for, even when the new one cannot be read", () => {
    const dir = scratch();
    const tree = join(dir, "topic");
    const root = join(dir, "guard");
    mkdirSync(tree);
    const crashed = admit(tree, REPO, root, undefined, deadHolder());
    if (!crashed.ok) throw new Error(crashed.failure.reason);
    crashed.value.submit();
    const was = incarnationOf(tree);
    rmSync(tree, { recursive: true });
    const next = admit(tree, REPO, root);
    if (!next.ok) throw new Error(next.failure.reason);
    expect(next.value.submitted).not.toBeNull();
    expect(read(next.value.file).incarnation).toBe(was);
    next.value.release();
  });
});

describe("the reclaim lock of a stale admission", () => {
  function lockFor(file: string): string {
    return fileLockPath(file, dirname(file), "reclaim");
  }

  /** A lock file's content as the shared file lock writes it, for `identity`. */
  function lockOf(identity: ProcessIdentity): string {
    return `${identity.pid}\ntoken\n${encodeIdentity(identity)}\n`;
  }

  it("is taken over when its collector is dead, and kept while it is live", () => {
    const root = scratch();
    const dead = admit(PATH, REPO, root, undefined, deadHolder());
    if (!dead.ok) throw new Error(dead.failure.reason);
    dead.value.submit();
    const lock = lockFor(dead.value.file);
    writeFileSync(lock, lockOf(deadHolder()));
    expect(releaseAbsent(PATH, REPO, () => true, root)).toEqual({
      ok: true,
      value: true,
    });
    expect(existsSync(dead.value.file)).toBe(false);
    expect(existsSync(lock)).toBe(false);

    const again = admit(PATH, REPO, root, undefined, deadHolder());
    if (!again.ok) throw new Error(again.failure.reason);
    writeFileSync(lock, lockOf(ownIdentity()));
    const held = releaseAbsent(PATH, REPO, () => true, root);
    expect(held.ok ? null : held.failure.code).toBe("held");
    expect(existsSync(again.value.file)).toBe(true);
    expect(existsSync(lock)).toBe(true);
  });
});

describe("launch markers", () => {
  const admittedAt = "2026-11-05T12:00:00.000Z";
  it("keep the worktree when a field of the kind is missing, however old", () => {
    const root = scratch();
    launchMarker(root, new Date(Date.parse(admittedAt) - DAY_MS), {
      agent: undefined,
    });
    const admission = { key: guardKey(PATH), at: admittedAt };
    expect(launchVeto(admission, root, Date.parse(admittedAt))).toContain(
      "does not read",
    );
  });

  it("still count under the name a sweep set them aside by", () => {
    const root = scratch();
    const file = launchMarker(root, new Date(Date.parse(admittedAt) + 1000));
    const aside = join(
      root,
      "launches",
      `.${guardKey(PATH)}.json.sweep.1.abc.tmp`,
    );
    renameSync(file, aside);
    const admission = { key: guardKey(PATH), at: admittedAt };
    expect(launchVeto(admission, root, Date.parse(admittedAt))).toContain(
      "after gc's admission",
    );
  });

  const admitted = Date.parse(admittedAt);
  const admission = { key: guardKey(PATH), at: admittedAt };

  it("keep the worktree when the markers cannot be listed", () => {
    const root = scratch();
    mkdirSync(join(root, "launches"));
    chmodSync(join(root, "launches"), 0o100);
    try {
      if (process.getuid?.() !== 0)
        expect(launchVeto(admission, root, admitted)).toContain(
          "cannot be listed",
        );
    } finally {
      chmodSync(join(root, "launches"), 0o700);
    }
  });

  it("keep nothing when the plugin wrote none", () => {
    expect(launchVeto(admission, scratch(), admitted)).toBeNull();
  });

  it("keep the worktree for a launch after the admission, however long ago", () => {
    const root = scratch();
    launchMarker(root, new Date(admitted + 1000));
    expect(launchVeto(admission, root, admitted + 10 * 60_000)).toContain(
      "after gc's admission",
    );
  });

  it("keep it for a launch within the settling window before the admission", () => {
    const root = scratch();
    launchMarker(root, new Date(admitted - 30_000));
    expect(launchVeto(admission, root, admitted + 1000)).toContain(
      "within the 120 s settling window",
    );
  });

  it("let collection go for a launch older than the settling window", () => {
    const root = scratch();
    launchMarker(root, new Date(admitted - LAUNCH_SETTLING_MS - 1000));
    expect(launchVeto(admission, root, admitted + 1000)).toBeNull();
  });

  it("keep it for a marker that does not parse or names an unknown version", () => {
    const root = scratch();
    const file = launchMarker(root, new Date(admitted - DAY_MS / 2));
    writeFileSync(file, '{"kind":"orca-guard-la');
    expect(launchVeto(admission, root, admitted)).toContain("does not read");
    launchMarker(root, new Date(admitted - DAY_MS / 2), { v: 2 });
    expect(launchVeto(admission, root, admitted)).toContain("version 2");
  });

  it("are never read half-written while several plugin processes rewrite one", async () => {
    const root = scratch();
    const script = join(scratch(), "writer.mjs");
    writeFileSync(
      script,
      `import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
const [dir, key, path] = process.argv.slice(2);
mkdirSync(dir, { recursive: true });
for (let i = 0; i < 200; i++) {
  const staged = join(dir, "." + key + ".json." + process.pid + "." + i + ".tmp");
  const record = { kind: "orca-guard-launch", v: 1, key, writer: { host: hostname(), pid: process.pid }, at: new Date().toISOString(), path, workspaceId: "ws-" + i, agent: "claude", padding: "x".repeat(4096) };
  writeFileSync(staged, JSON.stringify(record));
  for (let attempt = 0; ; attempt++) {
    try { renameSync(staged, join(dir, key + ".json")); break; }
    catch (error) { if (attempt > 200 || !["EPERM", "EACCES", "EBUSY"].includes(error.code)) throw error; }
  }
}
`,
    );
    const children = Array.from({ length: 4 }, () =>
      Bun.spawn(
        [
          process.execPath,
          script,
          join(root, "launches"),
          guardKey(PATH),
          PATH,
        ],
        { stdout: "pipe", stderr: "pipe" },
      ),
    );
    const torn: string[] = [];
    let running = true;
    void Promise.all(children.map((c) => c.exited)).then(() => {
      running = false;
    });
    const live = { key: guardKey(PATH), at: new Date(0).toISOString() };
    while (running) {
      const veto = launchVeto(live, root);
      if (veto?.includes("does not read")) torn.push(veto);
      await Bun.sleep(0);
    }
    for (const child of children) await expectSpawnExited(child, 0);
    expect(torn).toEqual([]);
    expect(launchVeto(live, root)).toContain("after gc's admission");
  }, 60_000);

  it("older than a day are swept, with the plugin's abandoned temporary files", () => {
    const root = scratch();
    const now = Date.now();
    const dir = join(root, "launches");
    const oldFile = launchMarker(
      root,
      new Date(now - LAUNCH_RETENTION_MS - 1000),
    );
    const otherKey = guardKey(`${PATH}-2`);
    const fresh = join(dir, `${otherKey}.json`);
    pluginWrite(fresh, {
      kind: "orca-guard-launch",
      v: 1,
      key: otherKey,
      writer: { host: hostname() },
      at: new Date(now - 1000).toISOString(),
      path: `${PATH}-2`,
      workspaceId: "ws-2",
      agent: "codex",
    });
    const brokenKey = guardKey(`${PATH}-3`);
    const broken = join(dir, `${brokenKey}.json`);
    writeFileSync(broken, "{");
    const staged = join(dir, ".abandoned.tmp");
    writeFileSync(staged, "{");
    const then = new Date(now - 2 * DAY_MS);
    utimesSync(broken, then, then);
    utimesSync(staged, then, then);
    expect(sweepLaunches(root, now).sort()).toEqual(
      [`${guardKey(PATH)}.json`, `${brokenKey}.json`, ".abandoned.tmp"].sort(),
    );
    expect(existsSync(oldFile)).toBe(false);
    expect(readdirSync(dir)).toEqual([`${otherKey}.json`]);
  });
});
