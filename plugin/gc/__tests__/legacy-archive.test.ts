/**
 * The one-time archive of a worktree older than marking: the stamp of when
 * marking began, a copy verified against its source within a size bound,
 * and the archive's expiry with the receipts.
 */
import { describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { receiptsKind } from "../kinds/receipts.ts";
import {
  archiveIgnored,
  archivePaths,
  markingSince,
  measure,
  worktreeCreatedAt,
} from "../legacy-archive.ts";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "gc-legacy-archive-"));
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
