/**
 * A world for `jig send`: `jig ask`'s world (a fake `gh` that answers the
 * conditional reads from files and logs every write it takes, a checkout of
 * the test repository, a home of its own), with the repository's
 * configuration on its default branch, the forge login, and a stand-in for
 * the drive's own listing that names a live driver of pull request 12 in a
 * working tree under the world's root. Nothing a send writes leaves the
 * world: labels and comments go to the fake's log, directives to that
 * tree's mailbox.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type AskWorld,
  askWorld,
  comment,
  pullDoc,
  REPO,
} from "../../ask/__tests__/ask-fixtures.ts";
import { ledgerBody } from "../../skills/drive-pr/__tests__/ledger-forge-fixtures.ts";
import { stoppedLedger } from "../../dispatch/__tests__/fixtures.ts";
import type { Ledger } from "../../skills/drive-pr/scripts/lib/state/ledger.ts";

export { comment, REPO };

/** The parked question pull request 12's ledger holds. */
export const PARK_KEY = "PRRT_park1";
const PARKED_AT = "2026-11-01T09:00:00.000Z";

export interface SendWorld extends AskWorld {
  /** The working tree the stand-in listing says holds the drive. */
  tree: string;
  send(args: string[], cwd?: string): ReturnType<AskWorld["jig"]>;
  /** The repository's `.config/jig.yaml` on its default branch. */
  config(text: string): void;
  /** Make the stand-in listing name a live driver of `pr` at `generation`. */
  liveDriver(pr: number, generation: number): void;
  stoppedDriver(pr: number): void;
}

const base64 = (text: string) => Buffer.from(text, "utf8").toString("base64");

export function sendWorld(): SendWorld {
  const w = askWorld();
  const tree = join(w.root, "tree");
  mkdirSync(tree, { recursive: true });
  w.api("user", { login: "maintainer" });
  const listing = join(w.root, "fake-drives.ts");
  const rows = join(w.root, "drive-rows.json");
  writeFileSync(rows, JSON.stringify({ rows: [] }));
  writeFileSync(
    listing,
    `process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(rows)}, "utf8"));\n`,
  );
  w.env.JIG_ASK_DRIVES_SCRIPT = listing;
  const world: SendWorld = {
    ...w,
    tree,
    send: (args, cwd) => w.jig(["send", ...args], cwd),
    config: (text) =>
      w.api(`repos/${REPO}/contents/.config/jig.yaml`, {
        encoding: "base64",
        content: base64(text),
      }),
    stoppedDriver: (pr) =>
      writeFileSync(
        rows,
        JSON.stringify({
          rows: [
            {
              kind: "pr",
              key: String(pr),
              state: "empty",
              diag: { worktree: tree },
            },
          ],
        }),
      ),
    liveDriver: (pr, generation) =>
      writeFileSync(
        rows,
        JSON.stringify({
          rows: [
            {
              kind: "pr",
              key: String(pr),
              state: "live",
              host: "this-host",
              diag: {
                worktree: tree,
                generation,
                mailbox: join(tree, ".context", "drive-mailbox"),
                started: "2026-11-06T08:00:00.000Z",
              },
            },
          ],
        }),
      ),
  };
  world.config("dispatch:\n  labels:\n    enabled: true\n");
  return world;
}

/** A ledger stopped parked on one question. */
export function parkedLedger(pr: number): Ledger {
  return stoppedLedger(pr, 8, {
    parked: [
      {
        key: PARK_KEY,
        kind: "thread",
        reason: "Keep the old flag for one release?",
        round: 2,
        at: PARKED_AT,
      },
    ],
  });
}

/** A ledger whose driver runs now. */
export function runningLedger(pr: number): Ledger {
  return stoppedLedger(pr, undefined, {
    driver: {
      actor: "wt-0123456789abcdef",
      clone: "clone-a",
      heartbeat: new Date().toISOString(),
      state: "running",
    },
  });
}

/** Pull request `pr`, open, with `labels`, and its comments. */
export function pullRequest(
  w: SendWorld,
  pr: number,
  labels: string[],
  comments: unknown[],
): void {
  w.api(
    `repos/${REPO}/pulls/${pr}`,
    pullDoc(pr, { labels: labels.map((name) => ({ name })) }),
  );
  w.api(`repos/${REPO}/issues/${pr}/comments`, comments);
}

export const ledgerOn = (id: number, ledger: Ledger) =>
  comment(id, ledgerBody(ledger));
