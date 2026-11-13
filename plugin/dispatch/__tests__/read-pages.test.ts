/**
 * dispatch: the page size a repository's paged read answered at is kept for
 * the next tick, stands for a day from when it was found, and is removed
 * once the read answers at its full page.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keepPage, keptPage, PAGE_KEPT_MS } from "../lib/read-pages.ts";
import { closeStateDb } from "../lib/state.ts";

const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) {
    closeStateDb(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

function root(): string {
  const dir = mkdtempSync(join(tmpdir(), "jig-dispatch-read-pages-"));
  roots.push(dir);
  return dir;
}

const REPO = "/checkouts/heavy";
const T0 = Date.parse("2026-11-13T03:00:00Z");

describe("a kept page size", () => {
  it("is the full page where none was kept", () => {
    expect(keptPage(REPO, "pull-requests", 50, T0, root())).toBe(50);
  });

  it("begins the next read where the last one answered, for that repository only", () => {
    const dir = root();
    keepPage(REPO, "pull-requests", 6, 50, T0, dir);
    expect(keptPage(REPO, "pull-requests", 50, T0 + 60_000, dir)).toBe(6);
    expect(keptPage("/checkouts/light", "pull-requests", 50, T0, dir)).toBe(50);
  });

  it("stands for a day from when it was found, not from when it was last confirmed", () => {
    const dir = root();
    keepPage(REPO, "pull-requests", 6, 50, T0, dir);
    keepPage(REPO, "pull-requests", 6, 50, T0 + PAGE_KEPT_MS / 2, dir);
    expect(keptPage(REPO, "pull-requests", 50, T0 + PAGE_KEPT_MS, dir)).toBe(
      50,
    );
    // Found again after it lapsed: it stands from then.
    keepPage(REPO, "pull-requests", 6, 50, T0 + PAGE_KEPT_MS, dir);
    expect(
      keptPage(REPO, "pull-requests", 50, T0 + PAGE_KEPT_MS + 1, dir),
    ).toBe(6);
  });

  it("moves to a new size from now, and goes when the read answers at its full page", () => {
    const dir = root();
    keepPage(REPO, "pull-requests", 12, 50, T0, dir);
    keepPage(REPO, "pull-requests", 6, 50, T0 + 1, dir);
    expect(keptPage(REPO, "pull-requests", 50, T0 + 2, dir)).toBe(6);
    keepPage(REPO, "pull-requests", 50, 50, T0 + 3, dir);
    expect(keptPage(REPO, "pull-requests", 50, T0 + 4, dir)).toBe(50);
  });
});
