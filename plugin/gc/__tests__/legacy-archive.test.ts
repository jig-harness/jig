import { createHash } from "node:crypto";
/**
 * The one-time archive of a worktree older than marking: the stamp of when
 * marking began, a copy verified against its source within a size bound,
 * and the archive's expiry with the receipts.
 */
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  renameSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { receiptsKind } from "../kinds/receipts.ts";
import {
  archiveIgnored,
  archivePaths,
  fingerprint,
  markingSince,
  measure,
  verify,
  worktreeCreatedAt,
} from "../legacy-archive.ts";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "gc-legacy-archive-"));
  roots.push(root);
  return root;
}
function worktree(): string {
  const root = scratch();
  mkdirSync(join(root, ".context", "facet-move"), { recursive: true });
  writeFileSync(join(root, ".context", "facet-move", "record.json"), "{}\n");
  writeFileSync(join(root, ".context", "msg.txt"), "a person's note\n");
  symlinkSync("msg.txt", join(root, ".context", "alias"));
  return root;
}
const PATHS = [".context/facet-move/", ".context/msg.txt", ".context/alias"];

describe("the one-time archive", () => {
  test("the marking stamp is written once and read back unchanged", () => {
    const root = join(scratch(), "state");
    const first = markingSince(root);
    expect(first.ok).toBe(true);
    const again = markingSince(root);
    expect(again).toEqual(first);
    writeFileSync(join(root, "marking-since"), "not an instant\n");
    expect(markingSince(root)).toMatchObject({
      ok: false,
      failure: { code: "unreadable" },
    });
  });

  test("a worktree's creation time is its commondir file's", () => {
    const admin = scratch();
    writeFileSync(join(admin, "commondir"), "../..\n");
    const then = new Date(Date.UTC(2026, 0, 2));
    utimesSync(join(admin, "commondir"), then, then);
    expect(worktreeCreatedAt(admin)).toEqual({
      ok: true,
      value: then.getTime(),
    });
    expect(worktreeCreatedAt(scratch())).toMatchObject({ ok: false });
  });

  test("the copy keeps each path in place, links as links, and names itself", () => {
    const root = worktree();
    const state = scratch();
    const archived = archiveIgnored(
      root,
      PATHS,
      { root: state, maxBytes: 1024 },
      Date.now() + 30_000,
    );
    if (!archived.ok) throw new Error(archived.failure.reason);
    const { path } = archived.value;
    expect(archivePaths(state)).toEqual([path]);
    expect(
      readFileSync(join(path, "content", ".context", "msg.txt"), "utf8"),
    ).toBe("a person's note\n");
    expect(
      readFileSync(
        join(path, "content", ".context", "facet-move", "record.json"),
        "utf8",
      ),
    ).toBe("{}\n");
    const alias = join(path, "content", ".context", "alias");
    expect(lstatSync(alias).isSymbolicLink()).toBe(true);
    expect(readlinkSync(alias)).toBe("msg.txt");
    const manifest = JSON.parse(
      readFileSync(join(path, "archive.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(manifest).toMatchObject({ worktree: root, paths: PATHS });
    // The worktree is left as it was.
    expect(existsSync(join(root, ".context", "msg.txt"))).toBe(true);
  });

  test("content past the bound is refused and leaves no archive", () => {
    const root = worktree();
    const state = scratch();
    expect(
      archiveIgnored(
        root,
        PATHS,
        { root: state, maxBytes: 4 },
        Date.now() + 30_000,
      ),
    ).toMatchObject({ ok: false, failure: { code: "oversized" } });
    expect(archivePaths(state)).toEqual([]);
  });

  test("a path that vanished fails the copy and leaves no archive", () => {
    const root = worktree();
    const state = scratch();
    expect(
      archiveIgnored(
        root,
        [...PATHS, ".context/gone.md"],
        { root: state, maxBytes: 1024 },
        Date.now() + 30_000,
      ),
    ).toMatchObject({ ok: false, failure: { code: "unreadable" } });
    expect(readdirSync(state)).toEqual([]);
  });

  test("content that grows past the bound after it was measured is refused", () => {
    const root = worktree();
    writeFileSync(join(root, ".context", "msg.txt"), "x".repeat(2048));
    expect(fingerprint(root, PATHS, Date.now() + 30_000, 1024)).toMatchObject({
      ok: false,
      failure: { code: "oversized" },
    });
    const read = fingerprint(root, PATHS, Date.now() + 30_000, 1 << 20);
    if (!read.ok) throw new Error(read.failure.reason);
    expect(read.value.bytes).toBeGreaterThanOrEqual(2048);
  });

  test("a file larger than the bound is rejected through bounded reads, and a multi-chunk file hashes whole", () => {
    const root = worktree();
    const paths = [...PATHS, ".context/big.bin"];
    const big = Buffer.alloc(200 * 1024, 7);
    writeFileSync(join(root, ".context", "big.bin"), big);
    expect(
      fingerprint(root, paths, Date.now() + 30_000, 64 * 1024),
    ).toMatchObject({
      ok: false,
      failure: { code: "oversized" },
    });
    const read = fingerprint(root, paths, Date.now() + 30_000, 1 << 20);
    if (!read.ok) throw new Error(read.failure.reason);
    const expected = createHash("sha256").update(big).digest("hex");
    expect(read.value.entries.get(".context/big.bin")).toBe(`file ${expected}`);
    expect(fingerprint(root, paths, Date.now() - 1, 1 << 20)).toMatchObject({
      ok: false,
      failure: { code: "timed-out" },
    });
  });

  test("an oversized file is rejected without being read whole", () => {
    const root = worktree();
    const paths = [...PATHS, ".context/sparse.bin"];
    const sparse = join(root, ".context", "sparse.bin");
    writeFileSync(sparse, "");
    truncateSync(sparse, 1 << 30);
    const before = process.memoryUsage().arrayBuffers;
    expect(
      fingerprint(root, paths, Date.now() + 30_000, 64 * 1024),
    ).toMatchObject({ ok: false, failure: { code: "oversized" } });
    // A whole-file read would hold the 1 GiB; a bounded one holds a chunk.
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(16 << 20);
  });

  test("the deadline is checked between the chunks of one file", () => {
    const root = worktree();
    const paths = [...PATHS, ".context/big.bin"];
    writeFileSync(
      join(root, ".context", "big.bin"),
      Buffer.alloc(300 * 1024, 7),
    );
    let calls = 0;
    const now = spyOn(Date, "now").mockImplementation(() => 1000 * calls++);
    try {
      expect(fingerprint(root, paths, 5000, 1 << 20)).toMatchObject({
        ok: false,
        failure: { code: "timed-out" },
      });
    } finally {
      now.mockRestore();
    }
  });

  describe("verification refuses a copy or a worktree that no longer matches", () => {
    // A copy made by hand, then one mutation, then verify() against the first read.
    function prepared() {
      const root = worktree();
      const state = scratch();
      const deadline = Date.now() + 30_000;
      const before = fingerprint(root, PATHS, deadline, 1 << 20);
      if (!before.ok) throw new Error(before.failure.reason);
      for (const entry of PATHS)
        cpSync(
          join(root, entry.replace(/\/$/, "")),
          join(state, "content", entry.replace(/\/$/, "")),
          { recursive: true, verbatimSymlinks: true },
        );
      const check = () =>
        verify(state, root, PATHS, before.value.entries, 1 << 20, deadline);
      return { root, state, check };
    }
    test("an unchanged copy verifies", () => {
      expect(prepared().check()).toMatchObject({ ok: true });
    });
    test("a same-length rewrite of the copy", () => {
      const { state, check } = prepared();
      writeFileSync(
        join(state, "content", ".context", "msg.txt"),
        "b person's note\n",
      );
      expect(check()).toMatchObject({
        ok: false,
        failure: { code: "archive-failed" },
      });
    });
    test("a same-length rewrite of the worktree while it was copied", () => {
      const { root, check } = prepared();
      writeFileSync(join(root, ".context", "msg.txt"), "b person's note\n");
      expect(check()).toMatchObject({
        ok: false,
        failure: { code: "archive-failed" },
      });
    });
    test("a changed symlink target in the copy", () => {
      const { state, check } = prepared();
      const alias = join(state, "content", ".context", "alias");
      rmSync(alias);
      symlinkSync("msg.tx_", alias);
      expect(check()).toMatchObject({
        ok: false,
        failure: { code: "archive-failed" },
      });
    });
    test("an equal-sized rename in the worktree", () => {
      const { root, check } = prepared();
      renameSync(
        join(root, ".context", "facet-move", "record.json"),
        join(root, ".context", "facet-move", "record.jsoo"),
      );
      expect(check()).toMatchObject({
        ok: false,
        failure: { code: "archive-failed" },
      });
    });
  });

  test("measuring stops once the bound is passed or the deadline is", () => {
    const root = worktree();
    const all = measure(root, PATHS, 1024, Date.now() + 30_000);
    expect(all).toMatchObject({ ok: true, value: { entries: 4 } });
    expect(measure(root, PATHS, 0, Date.now() + 30_000)).toMatchObject({
      ok: true,
      value: { entries: 2 },
    });
    expect(measure(root, PATHS, 1024, Date.now() - 1)).toMatchObject({
      ok: false,
      failure: { code: "timed-out" },
    });
  });

  test("an archive expires with the receipts, by its manifest or its day", async () => {
    const root = worktree();
    const state = scratch();
    const archived = archiveIgnored(
      root,
      PATHS,
      { root: state, maxBytes: 1024 },
      Date.now() + 30_000,
    );
    if (!archived.ok) throw new Error(archived.failure.reason);
    const kind = receiptsKind(1, state);
    const listed = await kind.inventory();
    if (!listed.ok) throw new Error(listed.failure.reason);
    expect(listed.value.map((resource) => resource.id)).toEqual([
      archived.value.path,
    ]);
    const resource = { id: archived.value.path };
    expect(await kind.prove(resource)).toMatchObject({ state: "live" });
    const manifest = join(archived.value.path, "archive.json");
    const record = JSON.parse(readFileSync(manifest, "utf8")) as Record<
      string,
      unknown
    >;
    record.createdAt = new Date(Date.now() - 2 * 86_400_000).toISOString();
    writeFileSync(manifest, JSON.stringify(record));
    expect(await kind.prove(resource)).toMatchObject({ state: "dead" });
    expect(await kind.collect(resource)).toMatchObject({
      outcome: "collected",
    });
    expect(existsSync(archived.value.path)).toBe(false);
    // A copy cut short before its manifest is dated by its day directory.
    const cut = join(state, "archives", "2026-01-01", "cut-short");
    mkdirSync(cut, { recursive: true });
    await kind.inventory();
    expect(await kind.prove({ id: cut })).toMatchObject({ state: "dead" });
  });
});

describe("the marking boundary", () => {
  test("a run with no worktree to prove still records when marking began", async () => {
    const { worktreesKind } = await import("../kinds/worktrees.ts");
    const repository = scratch();
    const state = scratch();
    expectSpawnExit(
      Bun.spawnSync(["git", "init", "-q", repository], {
        stdout: "pipe",
        stderr: "pipe",
      }),
      0,
    );
    const kind = worktreesKind(
      repository,
      [join(repository, "none")],
      "declaration",
      7,
      undefined,
      undefined,
      { root: state, maxBytes: 1024 },
    );
    await kind.inventory();
    expect(existsSync(join(state, "marking-since"))).toBe(true);
  });
});
