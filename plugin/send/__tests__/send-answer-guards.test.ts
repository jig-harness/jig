/**
 * The guards around a structured answer `jig send` writes: a free answer
 * whose words the readers would count as a choice is refused, so no choice
 * goes unbound to its framing; another person's answer, stale or not, is
 * shown and keeps an item out of `--all`; an item added since the `--all`
 * dry run refuses the send; a post that fails part-way reports what was
 * sent and what was not; the printed command keeps `--as`; and a person's
 * second send, read through the readers' parser, replaces the first.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { parkAnswers } from "../../skills/drive-pr/scripts/lib/driver/park-answers.ts";
import {
  comment,
  digestOf,
  framedLedger,
  framedPark,
  ledgerOn,
  pullRequest,
  REPO,
  type SendWorld,
  sendWorld,
} from "./send-fixtures.ts";

let current: SendWorld | null = null;
afterEach(() => {
  current?.close();
  current = null;
});

function world(): SendWorld {
  current = sendWorld();
  return current;
}

const ADDRESS = `drive@${REPO}#12`;
const KEY = "F_scope";
const SCOPE = digestOf("scope");
const NEXT = digestOf("next-item");

function parked(
  w: SendWorld,
  items = [framedPark(KEY, "scope")],
  more: unknown[] = [],
) {
  pullRequest(w, 12, [], [ledgerOn(701, framedLedger(12, items)), ...more]);
}

function posted(w: SendWorld): string[] {
  return w
    .writes()
    .map((args) => (args.find((a) => a.startsWith("body=")) ?? "").slice(5));
}

const token = (stdout: string) =>
  /--decision-set ([0-9a-f]{12})/.exec(stdout)?.[1] ?? "";

describe("a free answer the readers would count as a choice", () => {
  it("is refused on a framed park, pointing to --approve or --choose with --decision, and other words still go", async () => {
    const w = world();
    parked(w);
    for (const words of [
      ["Approve."],
      ["choose", "remove"],
      [`approve [${SCOPE}]`],
    ]) {
      const r = await w.send([ADDRESS, "answer", KEY, ...words]);
      expectSpawnExit(r, 1);
      expect(r.stderr).toContain("--approve or --choose");
      expect(r.stderr).toContain("--decision");
    }
    expect(w.writes()).toEqual([]);
    const free = await w.send([
      ADDRESS,
      "answer",
      KEY,
      "keep it, but rename it",
    ]);
    expectSpawnExit(free, 0);
    expect(posted(w)[0]?.split("\n")[0]).toBe(
      `answer ${KEY}: keep it, but rename it`,
    );
  });
});

describe("another person's answers", () => {
  /** owner's stale approval, then reviewer's current free answer. */
  const mixed = [
    comment(
      702,
      `answer ${KEY}: approve [0123456789ab]`,
      "owner",
      "OWNER",
      "2026-11-02T10:00:00Z",
    ),
    comment(
      703,
      `answer ${KEY}: keep it, but rename it`,
      "reviewer",
      "MEMBER",
      "2026-11-02T11:00:00Z",
    ),
  ];

  it("shows a stale answer beside a free one, and says the stale one keeps the item waiting", async () => {
    const w = world();
    parked(w, [framedPark(KEY, "scope")], mixed);
    const r = await w.send([ADDRESS, "answer", KEY, "--approve", "--dry-run"]);
    expectSpawnExit(r, 0);
    expect(r.stdout).toContain("earlier    owner's answer");
    expect(r.stdout).toContain("(stale");
    expect(r.stdout).toContain("earlier    reviewer's answer");
    expect(r.stdout).toContain(
      "free answer: answer F_scope: keep it, but rename it",
    );
    expect(r.stdout).toContain("owner's stale answer keeps the item waiting");
  });

  it("keeps an item someone else answered out of --all, stale or not", async () => {
    const w = world();
    parked(
      w,
      [framedPark(KEY, "scope"), framedPark("F_next", "next-item")],
      mixed,
    );
    const r = await w.send([
      ADDRESS,
      "answer",
      "--all",
      "--approve",
      "--dry-run",
    ]);
    expectSpawnExit(r, 0);
    expect(r.stdout).toMatch(/F_scope \(scope\): .*another person answered/);
    expect(r.stdout).toContain(`F_next (next-item) [${NEXT}]`);
  });
});

describe("--all --approve's binding and its writes", () => {
  it("refuses, writing nothing, when an item was parked since the dry run", async () => {
    const w = world();
    parked(w);
    const dry = await w.send([
      ADDRESS,
      "answer",
      "--all",
      "--approve",
      "--dry-run",
    ]);
    expectSpawnExit(dry, 0);
    parked(w, [framedPark(KEY, "scope"), framedPark("F_next", "next-item")]);
    const r = await w.send([
      ADDRESS,
      "answer",
      "--all",
      "--approve",
      "--decision-set",
      token(dry.stdout),
    ]);
    expectSpawnExit(r, 1);
    expect(r.stderr).toContain("changed since");
    expect(w.writes()).toEqual([]);
  });

  it("reports a post that fails part-way as a partial send: what was sent, what was not, and the dry run to run again", async () => {
    const w = world();
    parked(w, [framedPark(KEY, "scope"), framedPark("F_next", "next-item")]);
    const dry = await w.send([
      ADDRESS,
      "answer",
      "--all",
      "--approve",
      "--dry-run",
    ]);
    writeFileSync(join(w.dir, "post-fail-at"), "2");
    const r = await w.send([
      ADDRESS,
      "answer",
      "--all",
      "--approve",
      "--decision-set",
      token(dry.stdout),
    ]);
    expectSpawnExit(r, 1);
    expect(r.stdout).toContain(
      `sent       https://github.com/${REPO}/pull/12#issuecomment-901`,
    );
    expect(r.stdout).toContain("next       the re-arm");
    expect(r.stderr).toContain("partly sent");
    expect(r.stderr).toContain("F_next");
    expect(r.stderr).toContain("--dry-run again");
    expect(posted(w).map((b) => b.split("\n")[0])).toEqual([
      `answer ${KEY}: approve [${SCOPE}]`,
    ]);
  });

  it("prints the command to send with the --as the dry run was given", async () => {
    const w = world();
    parked(w);
    const one = await w.send([
      ADDRESS,
      "answer",
      KEY,
      "--approve",
      "--as",
      "maintainer",
      "--dry-run",
    ]);
    expectSpawnExit(one, 0);
    expect(one.stdout).toContain(
      `jig send ${ADDRESS} answer ${KEY} --approve --decision ${SCOPE} --as maintainer`,
    );
    const all = await w.send([
      ADDRESS,
      "answer",
      "--all",
      "--approve",
      "--as",
      "maintainer",
      "--dry-run",
    ]);
    expectSpawnExit(all, 0);
    expect(all.stdout).toMatch(
      /answer --all --approve --decision-set [0-9a-f]{12} --as maintainer/,
    );
  });
});

describe("answering again, as the readers read it", () => {
  it("counts a person's second send, not their first", async () => {
    const w = world();
    parked(w);
    expectSpawnExit(
      await w.send([
        ADDRESS,
        "answer",
        KEY,
        "--choose",
        "Remove",
        "--decision",
        SCOPE,
      ]),
      0,
    );
    expectSpawnExit(
      await w.send([ADDRESS, "answer", KEY, "--approve", "--decision", SCOPE]),
      0,
    );
    const [first, second] = posted(w);
    const listed = (id: number, body: string, at: string) => ({
      body,
      user: { login: "maintainer" },
      author_association: "MEMBER",
      created_at: at,
      updated_at: at,
      html_url: `https://github.com/${REPO}/pull/12#issuecomment-${id}`,
    });
    const found = await parkAnswers(12, [framedPark(KEY, "scope")], REPO, [
      listed(1, first ?? "", "2026-11-02T10:00:00Z"),
      listed(2, second ?? "", "2026-11-02T11:00:00Z"),
    ]);
    if ("unreadable" in found) throw new Error(found.unreadable);
    expect(found.disputed).toEqual([]);
    const answers = found.answered[0]?.answers ?? [];
    expect(answers).toHaveLength(1);
    expect(answers[0]?.choice).toMatchObject({
      option: "Keep",
      form: "approve",
      digest: SCOPE,
    });
  });
});
