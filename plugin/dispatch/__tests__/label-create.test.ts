/**
 * dispatch --apply and a dispatch label the repository does not have yet,
 * through real ticks: a write refused for it creates the label as `jig
 * dispatch labels` does and writes again in the same tick; a create the
 * forge refuses is one row of the failure ledger for the repository, so a
 * person is told once for the repository, never once per pull request.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { DEFAULT_LABELS, labelSet } from "../lib/labels.ts";
import { statePath } from "../lib/state.ts";
import type { TickReceipt } from "../receipts.ts";
import {
  HEAD_SHA,
  ledgerComment,
  openPr,
  SLUG,
  stoppedLedger,
  type World,
  world,
} from "./fixtures.ts";
import { account, dispatchState, machineFile } from "./launch-fixtures.ts";
import { withOrigin } from "./pickup-fixtures.ts";

const LABELS = `issue_tracker:
  adapter: github
  github:
    repository: ${SLUG}
dispatch:
  labels: { enabled: true }
`;

const CONVERGED = labelSet({ ...DEFAULT_LABELS, enabled: true }).find(
  (l) => l.name === "jig:converged",
);

let current: World | null = null;
afterEach(() => {
  current?.close();
  current = null;
});

/** Two converged pull requests in a repository whose labels lack `jig:converged`, and every marker label present. */
function fixture(): World {
  const w = world();
  current = w;
  w.setConfig(LABELS);
  withOrigin(w);
  machineFile(w, [account(w, "a", "a@example.com")], {}, ["rearm", "notify"]);
  w.setPrs("open", [openPr(7, "feature/7"), openPr(8, "feature/8")]);
  for (const pr of [7, 8])
    w.setComments(pr, [
      ledgerComment(
        pr * 100 + 1,
        stoppedLedger(pr, 0, { verifiedSha: HEAD_SHA }),
      ),
    ]);
  writeFileSync(
    join(w.dir, "labels-repo.json"),
    JSON.stringify(["manual-ops", "automation"]),
  );
  return w;
}

async function tick(w: World): Promise<TickReceipt> {
  const r = await w.dispatch(["--apply", "--json"]);
  expectSpawnExit(r, 0);
  return JSON.parse(r.stdout) as TickReceipt;
}

/** Every `gh` call the ticks made since the last call, `pr edit` and `label create` only. */
function writes(w: World): string[] {
  const path = join(w.dir, "gh-calls.log");
  const lines = existsSync(path)
    ? readFileSync(path, "utf8").trim().split("\n")
    : [];
  writeFileSync(path, "");
  return lines.filter(
    (l) => l.startsWith("pr edit ") || l.startsWith("label create "),
  );
}

/** The failure ledger's rows, as the tick left them. */
function rows(w: World): Array<{ key: string; target: string; count: number }> {
  const path = statePath(dispatchState(w));
  if (!existsSync(path)) return [];
  const db = new Database(path);
  try {
    return db
      .query("SELECT key, target, count FROM failures ORDER BY key")
      .all() as Array<{ key: string; target: string; count: number }>;
  } finally {
    db.close();
  }
}

/** Every action's next try moved into the past, as if its wait had passed. */
function waited(w: World): void {
  const db = new Database(statePath(dispatchState(w)));
  try {
    db.query("UPDATE failures SET next_at_ms = 0").run();
  } finally {
    db.close();
  }
}

const repo = (r: TickReceipt) => r.repos[0];

describe("jig dispatch creates a dispatch label a write misses", () => {
  it("creates the missing label once and writes every pull request's label in the same tick", async () => {
    const w = fixture();
    writes(w);
    const r = await tick(w);
    expect(repo(r)?.labels?.writes).toMatchObject([
      { target: "PR #7", add: ["jig:converged"], outcome: "written" },
      { target: "PR #8", add: ["jig:converged"], outcome: "written" },
    ]);
    const calls = writes(w);
    expect(calls.filter((c) => c.startsWith("label create "))).toHaveLength(1);
    expect(calls[1]).toStartWith(
      `label create jig:converged --repo ${SLUG} --color ${CONVERGED?.color}`,
    );
    const labels = JSON.parse(
      readFileSync(join(w.dir, "labels-repo.json"), "utf8"),
    ) as Array<{ name: string; description: string } | string>;
    expect(labels).toContainEqual(
      expect.objectContaining({
        name: "jig:converged",
        description: CONVERGED?.description,
      }),
    );
    expect(rows(w)).toEqual([]);
  }, 60_000);

  it("raises one need for the repository when the create is refused, not one per pull request", async () => {
    const w = fixture();
    writeFileSync(join(w.dir, "label-create-fail"), "");
    writes(w);

    const first = await tick(w);
    expect(repo(first)?.labels?.writes).toMatchObject([
      { target: "PR #7", outcome: "failed" },
      { target: "PR #8", outcome: "failed" },
    ]);
    expect(repo(first)?.labels?.writes[1]?.detail).toContain(
      "the dispatch label 'jig:converged' does not exist",
    );
    expect(writes(w).filter((c) => c.startsWith("label create "))).toHaveLength(
      1,
    );
    expect(rows(w)).toEqual([
      { key: "label create jig:converged", target: SLUG, count: 1 },
    ]);

    // While the create backs off, the writes that add the label wait without asking the forge.
    await tick(w);
    writes(w);
    const backing = await tick(w);
    expect(repo(backing)?.labels?.writes).toMatchObject([
      { target: "PR #7", outcome: "waits" },
      { target: "PR #8", outcome: "waits" },
    ]);
    expect(writes(w)).toEqual([]);

    waited(w);
    await tick(w);
    expect(rows(w)).toEqual([
      { key: "label create jig:converged", target: SLUG, count: 3 },
    ]);
    const told = await tick(w);
    const failing = (repo(told)?.notifications ?? []).filter(
      (n) => n.cause === "action-failing",
    );
    expect(failing).toMatchObject([{ target: SLUG, outcome: "sent" }]);
  }, 180_000);

  it("writes the label when another writer created it first, and books no failure on its create", async () => {
    const w = fixture();
    writeFileSync(join(w.dir, "label-create-raced"), "");
    writes(w);
    const r = await tick(w);
    expect(repo(r)?.labels?.writes).toMatchObject([
      { target: "PR #7", add: ["jig:converged"], outcome: "written" },
      { target: "PR #8", add: ["jig:converged"], outcome: "written" },
    ]);
    expect(writes(w).filter((c) => c.startsWith("label create "))).toHaveLength(
      1,
    );
    expect(rows(w)).toEqual([]);
  }, 60_000);

  it("clears a refused create's row once a person created the label and the write succeeds", async () => {
    const w = fixture();
    writeFileSync(join(w.dir, "label-create-fail"), "");
    await tick(w);
    expect(rows(w).map((row) => row.key)).toEqual([
      "label create jig:converged",
    ]);
    const have = JSON.parse(
      readFileSync(join(w.dir, "labels-repo.json"), "utf8"),
    ) as unknown[];
    writeFileSync(
      join(w.dir, "labels-repo.json"),
      JSON.stringify([...have, "jig:converged"]),
    );
    waited(w);
    const r = await tick(w);
    expect(repo(r)?.labels?.writes).toMatchObject([
      { target: "PR #7", outcome: "written" },
      { target: "PR #8", outcome: "written" },
    ]);
    expect(rows(w)).toEqual([]);
  }, 120_000);
});
