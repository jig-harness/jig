/**
 * `jig send … answer` in its structured forms, through the `jig` command
 * against a fake forge: `--approve` and `--choose` checked against the park
 * and bound to the digest the person read, `--note` beside them, a person
 * answering again, and `--all --approve` over the open items whose class
 * the acts table lists as Decide, bound to the set the dry run listed.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
  expectSpawnExit,
  expectSpawnExitNot,
} from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { decodeMarker } from "../../shared/records/envelope.ts";
import {
  comment,
  digestOf,
  framedLedger,
  framedPark,
  ledgerOn,
  parkedLedger,
  PARK_KEY,
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

/** Pull request 12, parked on one framed `scope` question, with `comments` after the ledger. */
function scopePark(w: SendWorld, comments: unknown[] = []): void {
  pullRequest(
    w,
    12,
    [],
    [ledgerOn(701, framedLedger(12, [framedPark(KEY, "scope")])), ...comments],
  );
}

/** The bodies of the comments the send posted. */
function posted(w: SendWorld): string[] {
  return w
    .writes()
    .map((args) => (args.find((a) => a.startsWith("body=")) ?? "").slice(5));
}

describe("a structured answer's usage", () => {
  it("refuses an answer naming no option, two forms, a note without a form, and a malformed digest before it reads", async () => {
    const w = world();
    for (const [args, says] of [
      [["answer", KEY], "names no option"],
      [["answer", KEY, "--approve", "--choose", "Keep"], "one of"],
      [["answer", KEY, "keep it", "--approve"], "one of"],
      [["answer", KEY, "keep it", "--note", "later"], "--note"],
      [["answer", KEY, "--choose", ""], "names no option"],
      [["answer", KEY, "--approve", "--decision", "nothex"], "--decision"],
      [["answer", "--all"], "--all --approve"],
      [["answer", KEY, "--all", "--approve"], "no key"],
      [["answer", "--all", "--approve", "--note", "x"], "--note"],
      [["answer", KEY, "--approve", "--decision-set", SCOPE], "--all"],
      [["hold", "--approve"], "only answer"],
    ] as const) {
      const r = await w.send([ADDRESS, ...args]);
      expectSpawnExit(r, 2);
      expect(r.stderr).toContain(says);
    }
    expect(w.calls()).toEqual([]);
  });
});

describe("--approve and --choose", () => {
  it("prints the park's digest, the chosen option in full and the command to send, and writes nothing", async () => {
    const w = world();
    scopePark(w);
    const r = await w.send([ADDRESS, "answer", KEY, "--approve", "--dry-run"]);
    expectSpawnExit(r, 0);
    expect(r.stdout).toContain(`decision   ${SCOPE}`);
    expect(r.stdout).toContain("Keep (the recommended option)");
    expect(r.stdout).toContain("Changes: The flag stays for one more release.");
    expect(r.stdout).toContain("Costs: One more release of the old path.");
    expect(r.stdout).toContain(`answer ${KEY}: approve [${SCOPE}]`);
    expect(r.stdout).toContain(
      `jig send ${ADDRESS} answer ${KEY} --approve --decision ${SCOPE}`,
    );
    expect(w.writes()).toEqual([]);
  });

  it("refuses a real send that names no digest, or one that is no longer the park's, writing nothing", async () => {
    const w = world();
    scopePark(w);
    const none = await w.send([ADDRESS, "answer", KEY, "--approve"]);
    expectSpawnExit(none, 1);
    expect(none.stderr).toContain("--dry-run");
    expect(none.stderr).toContain("--decision");
    const old = await w.send([
      ADDRESS,
      "answer",
      KEY,
      "--approve",
      "--decision",
      "0123456789ab",
    ]);
    expectSpawnExit(old, 1);
    expect(old.stderr).toContain("0123456789ab is not the decision digest");
    const dry = await w.send([
      ADDRESS,
      "answer",
      KEY,
      "--approve",
      "--decision",
      "0123456789ab",
      "--dry-run",
    ]);
    expectSpawnExit(dry, 1);
    expect(w.writes()).toEqual([]);
  });

  it("writes the choice as the park spells it, the digest, the note and the record's payload", async () => {
    const w = world();
    scopePark(w);
    const r = await w.send([
      ADDRESS,
      "answer",
      KEY,
      "--choose",
      "remove.",
      "--note",
      "only after the migration merges",
      "--decision",
      SCOPE,
    ]);
    expectSpawnExit(r, 0);
    const [body] = posted(w);
    expect(body?.split("\n").slice(0, 2)).toEqual([
      `answer ${KEY}: choose Remove [${SCOPE}]`,
      `note ${KEY}: only after the migration merges`,
    ]);
    const read = decodeMarker(body ?? "", "jig-send-answer", "drive-answer");
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.envelope.v).toBe(1);
    expect(read.value.payload).toEqual({
      pr: 12,
      decision: SCOPE,
      choice: { option: "Remove", form: "choose" },
    });
  });

  it("refuses an option the park does not offer, and a structured form on a park with no options, naming what it offers", async () => {
    const w = world();
    scopePark(w);
    const none = await w.send([
      ADDRESS,
      "answer",
      KEY,
      "--choose",
      "Rename",
      "--decision",
      SCOPE,
    ]);
    expectSpawnExit(none, 1);
    expect(none.stderr).toContain("Rename names no option");
    expect(none.stderr).toContain("Keep, Remove");
    pullRequest(w, 12, [], [ledgerOn(701, parkedLedger(12))]);
    const unframed = await w.send([
      ADDRESS,
      "answer",
      PARK_KEY,
      "--approve",
      "--dry-run",
    ]);
    expectSpawnExit(unframed, 1);
    expect(unframed.stderr).toContain("no framed decision");
    expect(w.writes()).toEqual([]);
  });

  it("binds a park from before digests by time alone, and refuses a --decision there", async () => {
    const w = world();
    pullRequest(
      w,
      12,
      [],
      [ledgerOn(701, framedLedger(12, [framedPark(KEY, "scope", false)]))],
    );
    const named = await w.send([
      ADDRESS,
      "answer",
      KEY,
      "--approve",
      "--decision",
      SCOPE,
    ]);
    expectSpawnExit(named, 1);
    expect(named.stderr).toContain("bound by time alone");
    const r = await w.send([ADDRESS, "answer", KEY, "--approve"]);
    expectSpawnExit(r, 0);
    expect(posted(w)[0]?.split("\n")[0]).toBe(`answer ${KEY}: approve`);
  });
});

describe("answering again", () => {
  it("shows the person's earlier answer first and sends the new one, which replaces it", async () => {
    const w = world();
    scopePark(w, [
      comment(
        702,
        `answer ${KEY}: choose Remove [${SCOPE}]`,
        "maintainer",
        "MEMBER",
        "2026-11-02T10:00:00Z",
      ),
    ]);
    const r = await w.send([
      ADDRESS,
      "answer",
      KEY,
      "--approve",
      "--decision",
      SCOPE,
    ]);
    expectSpawnExit(r, 0);
    expect(r.stdout).toContain("earlier    your answer");
    expect(r.stdout).toContain("chose Remove");
    expect(r.stdout.indexOf("earlier")).toBeLessThan(
      r.stdout.indexOf("record"),
    );
    expect(r.stdout).toContain("replaces it");
    expect(posted(w)[0]?.split("\n")[0]).toBe(
      `answer ${KEY}: approve [${SCOPE}]`,
    );
  });

  it("names another person's answer, and that a differing answer leaves the item disputed", async () => {
    const w = world();
    scopePark(w, [
      comment(
        702,
        `answer ${KEY}: choose Remove [${SCOPE}]`,
        "owner",
        "OWNER",
        "2026-11-02T10:00:00Z",
      ),
    ]);
    const r = await w.send([
      ADDRESS,
      "answer",
      KEY,
      "--approve",
      "--decision",
      SCOPE,
      "--dry-run",
    ]);
    expectSpawnExit(r, 0);
    expect(r.stdout).toContain("owner's answer");
    expect(r.stdout).toContain("disputed");
    expect(w.writes()).toEqual([]);
  });
});

describe("--all --approve", () => {
  /** Open Decide items, Authorize, Merge and Reply ones, a repository's own class, one before digests, and one answered. */
  function many(w: SendWorld, nextItem = framedPark("F_next", "next-item")) {
    pullRequest(
      w,
      12,
      [],
      [
        ledgerOn(
          701,
          framedLedger(12, [
            framedPark(KEY, "scope"),
            nextItem,
            framedPark("F_release", "release"),
            framedPark("F_merge", "merge"),
            framedPark("F_reply", "human-thread"),
            framedPark("F_own", "house-style"),
            framedPark("F_old", "escalated", false),
            framedPark("F_done", "scope"),
          ]),
        ),
        comment(
          702,
          `answer F_done: approve [${SCOPE}]`,
          "owner",
          "OWNER",
          "2026-11-02T10:00:00Z",
        ),
      ],
    );
  }

  const token = (stdout: string) =>
    /--decision-set ([0-9a-f]{12})/.exec(stdout)?.[1] ?? "";

  it("lists each eligible item with its digest and one set token, says why the others are left out, and writes nothing", async () => {
    const w = world();
    many(w);
    const r = await w.send([
      ADDRESS,
      "answer",
      "--all",
      "--approve",
      "--dry-run",
    ]);
    expectSpawnExit(r, 0);
    expect(r.stdout).toContain(`${KEY} (scope) [${SCOPE}]: Keep`);
    expect(r.stdout).toContain(`F_next (next-item) [${digestOf("next-item")}]`);
    expect(r.stdout).toMatch(/F_release \(release\): .*Authorize/);
    expect(r.stdout).toMatch(/F_merge \(merge\): .*to Merge/);
    expect(r.stdout).toMatch(/F_reply \(human-thread\): .*to Reply/);
    expect(r.stdout).toMatch(/F_own \(house-style\): .*does not list/);
    expect(r.stdout).toMatch(/F_old \(escalated\): .*no decision digest/);
    expect(r.stdout).toMatch(/F_done \(scope\): .*answered/);
    expect(token(r.stdout)).toMatch(/^[0-9a-f]{12}$/);
    expect(w.writes()).toEqual([]);
  });

  it("names the same set token whatever order canonically equivalent keys arrive in", async () => {
    const tokenFor = async (keys: string[]) => {
      const w = world();
      pullRequest(
        w,
        12,
        [],
        [
          ledgerOn(
            701,
            framedLedger(
              12,
              keys.map((k) => framedPark(k, "scope")),
            ),
          ),
        ],
      );
      const r = await w.send([
        ADDRESS,
        "answer",
        "--all",
        "--approve",
        "--dry-run",
      ]);
      expectSpawnExit(r, 0);
      return token(r.stdout);
    };
    const composed = "F_\u00e9";
    const decomposed = "F_e\u0301";
    const a = await tokenFor([composed, decomposed]);
    const b = await tokenFor([decomposed, composed]);
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(b).toBe(a);
  });

  it("leaves out a park whose key the answer line cannot carry, and prints no control character", async () => {
    const w = world();
    many(w, framedPark("F_\u001b[2J", "next-item"));
    const r = await w.send([
      ADDRESS,
      "answer",
      "--all",
      "--approve",
      "--dry-run",
    ]);
    expectSpawnExit(r, 0);
    expect(r.stdout.includes("\u001b")).toBe(false);
    expect(r.stdout).toContain("cannot be written in an answer line");
    expect(r.stdout).not.toMatch(/F_.*\(next-item\) \[/);
  });

  it("prints no control character in the refusal when the only eligible park has such a key", async () => {
    const w = world();
    pullRequest(
      w,
      12,
      [],
      [ledgerOn(701, framedLedger(12, [framedPark("F_\u001b[2J", "scope")]))],
    );
    const r = await w.send([ADDRESS, "answer", "--all", "--approve"]);
    expectSpawnExitNot(r, 0);
    expect(r.stderr.includes("\u001b")).toBe(false);
    expect(r.stderr).toContain("F_ [2J");
  });

  it("refuses a real send without the set token, or when the set changed since, writing nothing", async () => {
    const w = world();
    many(w);
    const dry = await w.send([
      ADDRESS,
      "answer",
      "--all",
      "--approve",
      "--dry-run",
    ]);
    const set = token(dry.stdout);
    const none = await w.send([ADDRESS, "answer", "--all", "--approve"]);
    expectSpawnExit(none, 1);
    expect(none.stderr).toContain("--decision-set");
    const reframed = framedPark("F_next", "next-item");
    reframed.digest = "fedcba987654";
    many(w, reframed);
    const changed = await w.send([
      ADDRESS,
      "answer",
      "--all",
      "--approve",
      "--decision-set",
      set,
    ]);
    expectSpawnExit(changed, 1);
    expect(changed.stderr).toContain("changed since");
    expect(w.writes()).toEqual([]);
  });

  it("writes one approval per eligible item, each with its digest", async () => {
    const w = world();
    many(w);
    const dry = await w.send([
      ADDRESS,
      "answer",
      "--all",
      "--approve",
      "--dry-run",
    ]);
    const r = await w.send([
      ADDRESS,
      "answer",
      "--all",
      "--approve",
      "--decision-set",
      token(dry.stdout),
    ]);
    expectSpawnExit(r, 0);
    expect(posted(w).map((b) => b.split("\n")[0])).toEqual([
      `answer ${KEY}: approve [${SCOPE}]`,
      `answer F_next: approve [${digestOf("next-item")}]`,
    ]);
  });
});
