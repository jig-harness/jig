/**
 * `jig send` through the `jig` command, against a fake forge, a stand-in
 * for the drive's listing and a home of its own: `--dry-run` prints the
 * repository, the login, the record and its reader and writes nothing; a
 * request the station cannot take is refused before any write; a session
 * the line started is refused a person's commands; a mailbox verb appends a
 * directive to the tree that holds the drive here, and is refused, naming
 * the host, for a drive another host holds; and a real send ends with what
 * it wrote.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { claimBody } from "../../shared/records/forge-claims.ts";
import {
  LAUNCH_CLAIM,
  launchClaim,
} from "../../shared/records/launch-claims.ts";
import { localWriter } from "../../shared/records/writer.ts";
import {
  comment,
  ledgerOn,
  PARK_KEY,
  parkedLedger,
  pullRequest,
  REPO,
  runningLedger,
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

function inbox(w: SendWorld): Array<Record<string, unknown>> {
  const file = join(w.tree, ".context", "drive-mailbox", "inbox.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("jig send --dry-run", () => {
  it("prints the repository, the login, the record and its reader for each label verb, and writes nothing", async () => {
    const w = world();
    pullRequest(w, 12, [], []);
    pullRequest(w, 13, ["jig:hold"], []);
    for (const [args, record, reader] of [
      [
        [ADDRESS, "hold"],
        "the label jig:hold, added to pull request 12",
        "keeps every stage off",
      ],
      [
        [`drive@${REPO}#13`, "release"],
        "the label jig:hold, removed from pull request 13",
        "starts the stages",
      ],
      [
        [ADDRESS, "drive"],
        "the label jig:drive, added to pull request 12",
        "arms a drive on it",
      ],
      [
        [`followup@${REPO}`, "12", "hold"],
        "the label jig:hold, added to pull request 12",
        "keeps every stage off",
      ],
    ] as const) {
      const r = await w.send([...args, "--dry-run"]);
      expectSpawnExit(r, 0);
      expect(r.stdout).toContain(`repository ${REPO}`);
      expect(r.stdout).toContain("writes as  maintainer");
      expect(r.stdout).toContain(record);
      expect(r.stdout).toContain(reader);
      expect(r.stdout).toContain("dry run: nothing was written.");
    }
    expect(w.writes()).toEqual([]);
    for (const call of w.calls()) expect(call).toMatch(/^api -i /);
  });

  it("prints an answer in full, says who can read it, and writes nothing", async () => {
    const w = world();
    pullRequest(w, 12, [], [ledgerOn(701, parkedLedger(12))]);
    const r = await w.send([
      ADDRESS,
      "answer",
      PARK_KEY,
      "keep it for one release",
      "--dry-run",
    ]);
    expectSpawnExit(r, 0);
    expect(r.stdout).toContain(`answer ${PARK_KEY}: keep it for one release`);
    expect(r.stdout).toContain("readable by whoever can read the pull request");
    expect(r.stdout).toContain("the re-arm");
    expect(w.writes()).toEqual([]);
  });

  it("prints a mailbox directive and the driver generation it reaches, and leaves the mailbox as it was", async () => {
    const w = world();
    pullRequest(w, 12, [], [ledgerOn(701, runningLedger(12))]);
    w.liveDriver(12, 3);
    for (const [args, reader] of [
      [["pause"], "driver generation 3, which waits"],
      [["hold-push"], "driver generation 3's guarded push"],
      [["stop"], "driver generation 3, which stops"],
    ] as const) {
      const r = await w.send([ADDRESS, ...args, "--dry-run"]);
      expectSpawnExit(r, 0);
      expect(r.stdout).toContain(`repository ${REPO}`);
      expect(r.stdout).toContain("writes as  maintainer");
      expect(r.stdout).toContain(`in the mailbox of ${w.tree}`);
      expect(r.stdout).toContain(reader);
    }
    expect(inbox(w)).toEqual([]);
  });
});

describe("jig send refuses before it writes", () => {
  it("an answer to a key that is not parked, and to one already answered", async () => {
    const w = world();
    pullRequest(w, 12, [], [ledgerOn(701, parkedLedger(12))]);
    const unknown = await w.send([ADDRESS, "answer", "PRRT_other", "yes"]);
    expectSpawnExit(unknown, 1);
    expect(unknown.stderr).toContain(
      `PRRT_other is not a parked question of pull request 12; its parked questions are ${PARK_KEY}`,
    );
    pullRequest(
      w,
      12,
      [],
      [
        ledgerOn(701, parkedLedger(12)),
        comment(
          702,
          `answer ${PARK_KEY}: drop it`,
          "owner",
          "OWNER",
          "2026-11-02T10:00:00Z",
        ),
      ],
    );
    const answered = await w.send([ADDRESS, "answer", PARK_KEY, "keep it"]);
    expectSpawnExit(answered, 1);
    expect(answered.stderr).toContain("already answered");
    expect(w.writes()).toEqual([]);
  });

  it("a drive on a pull request with a ledger, a second hold, and a release with no hold", async () => {
    const w = world();
    pullRequest(w, 12, ["jig:hold"], [ledgerOn(701, parkedLedger(12))]);
    const drive = await w.send([ADDRESS, "drive"]);
    expectSpawnExit(drive, 1);
    expect(drive.stderr).toContain("already has a drive ledger");
    const hold = await w.send([ADDRESS, "hold"]);
    expectSpawnExit(hold, 1);
    expect(hold.stderr).toContain("already carries jig:hold");
    pullRequest(w, 13, [], []);
    const release = await w.send([`drive@${REPO}#13`, "release"]);
    expectSpawnExit(release, 1);
    expect(release.stderr).toContain("there is no hold to release");
    expect(w.writes()).toEqual([]);
  });

  it("a label verb where the repository has its dispatch labels off, naming the setting", async () => {
    const w = world();
    w.config("dispatch:\n  identity: factory-bot\n");
    pullRequest(w, 12, [], []);
    const r = await w.send([ADDRESS, "hold"]);
    expectSpawnExit(r, 1);
    expect(r.stderr).toContain("dispatch.labels.enabled is not true");
    expect(w.writes()).toEqual([]);
  });

  it("every send on a machine whose dispatch file says send: false, and --as for another login", async () => {
    const w = world();
    pullRequest(w, 12, [], []);
    const as = await w.send([ADDRESS, "hold", "--as", "someone-else"]);
    expectSpawnExit(as, 1);
    expect(as.stderr).toContain("this machine is signed in as maintainer");
    mkdirSync(join(w.home, ".jig"), { recursive: true });
    writeFileSync(join(w.home, ".jig", "dispatch.yaml"), "send: false\n");
    const off = await w.send([ADDRESS, "hold", "--dry-run"]);
    expectSpawnExit(off, 1);
    expect(off.stderr).toContain("send: false in its dispatch file");
    expect(w.writes()).toEqual([]);
  });

  it("an unknown verb, or one the station does not take, as a usage error listing the station's verbs", async () => {
    const w = world();
    const unknown = await w.send([ADDRESS, "merge"]);
    expectSpawnExit(unknown, 2);
    expect(unknown.stderr).toContain(
      "drive takes drive, hold, release, answer <key> <text>",
    );
    const wrong = await w.send([`followup@${REPO}#12`, "pause"]);
    expectSpawnExit(wrong, 2);
    expect(wrong.stderr).toContain("followup takes hold, release");
    const twoLines = await w.send([
      ADDRESS,
      "answer",
      PARK_KEY,
      "yes\nand more",
    ]);
    expectSpawnExit(twoLines, 2);
    expect(twoLines.stderr).toContain("send one line");
    const marker = await w.send([
      ADDRESS,
      "answer",
      PARK_KEY,
      "yes <!-- x -->",
    ]);
    expectSpawnExit(marker, 2);
    expect(marker.stderr).toContain("hidden marker");
    expect(w.calls()).toEqual([]);
  });
});

describe("jig send in a session the line started", () => {
  it("refuses a person's commands, saying they are a person's, and still takes a mailbox verb", async () => {
    const w = world();
    w.env.JIG_LAUNCH = "20261106T080000Z-abcdef12";
    pullRequest(w, 12, [], [ledgerOn(701, parkedLedger(12))]);
    for (const args of [
      [ADDRESS, "drive"],
      [ADDRESS, "hold"],
      [ADDRESS, "release"],
      [ADDRESS, "answer", PARK_KEY, "yes"],
      [`pickup@${REPO}#14`, "assign"],
    ]) {
      const r = await w.send([...args, "--dry-run"]);
      expectSpawnExit(r, 1);
      expect(r.stderr).toContain("is a person's command");
      expect(r.stderr).toContain("JIG_LAUNCH=20261106T080000Z-abcdef12");
    }
    w.liveDriver(12, 3);
    const pause = await w.send([ADDRESS, "pause", "--dry-run"]);
    expectSpawnExit(pause, 0);
    expect(w.writes()).toEqual([]);
  });
});

describe("jig send to a drive's mailbox", () => {
  it("appends a stop addressed to the driver generation, and a pause the tree keeps until resumed", async () => {
    const w = world();
    pullRequest(w, 12, [], [ledgerOn(701, runningLedger(12))]);
    w.liveDriver(12, 3);
    const stop = await w.send([ADDRESS, "stop"]);
    expectSpawnExit(stop, 0);
    expect(stop.stdout).toContain(
      `sent       ${join(w.tree, ".context", "drive-mailbox", "inbox.jsonl")}`,
    );
    const pause = await w.send([ADDRESS, "pause"]);
    expectSpawnExit(pause, 0);
    expect(inbox(w)).toMatchObject([
      {
        kind: "directive",
        pr: "12",
        from: "maintainer",
        command: "stop",
        generation: 3,
      },
      { kind: "directive", pr: "12", from: "maintainer", command: "pause" },
    ]);
    expect(inbox(w)[1]).not.toHaveProperty("generation");
    const stopAgain = await w.send([ADDRESS, "stop"]);
    expectSpawnExit(stopAgain, 1);
    expect(stopAgain.stderr).toContain("is already in the mailbox");
    const again = await w.send([ADDRESS, "pause"]);
    expectSpawnExit(again, 1);
    expect(again.stderr).toContain("a pause directive is already in force");
    const resume = await w.send([ADDRESS, "resume", "pause"]);
    expectSpawnExit(resume, 0);
    expect(inbox(w).at(-1)).toMatchObject({
      command: "resume",
      target: "pause",
    });
  });

  it("refuses a drive another host holds, naming the host, and one no driver here holds", async () => {
    const w = world();
    const draft = {
      stage: "drive" as const,
      pr: 12,
      run: "tick" as const,
      action: "rearm" as const,
      record: "20261105T100000Z-abcdef12",
      host: "hostdigest01",
      owner: true,
      facts: "stopped 16",
      writer: localWriter("forge", "maintainer"),
    };
    pullRequest(
      w,
      12,
      [],
      [
        ledgerOn(701, runningLedger(12)),
        comment(702, claimBody(LAUNCH_CLAIM, launchClaim(draft, 1))),
      ],
    );
    const elsewhere = await w.send([ADDRESS, "pause"]);
    expectSpawnExit(elsewhere, 1);
    expect(elsewhere.stderr).toContain(
      "runs on host hostdigest01, not on this machine",
    );
    pullRequest(w, 13, [], [ledgerOn(711, parkedLedger(13))]);
    const nobody = await w.send([`drive@${REPO}#13`, "hold-push"]);
    expectSpawnExit(nobody, 1);
    expect(nobody.stderr).toContain("no driver on this machine holds");
    expect(inbox(w)).toEqual([]);
  });
});

describe("jig send writes through the record's owner", () => {
  it("adds and removes the hold label in one forge call each, and ends with the link", async () => {
    const w = world();
    pullRequest(w, 12, [], []);
    const hold = await w.send([ADDRESS, "hold"]);
    expectSpawnExit(hold, 0);
    expect(hold.stdout).toContain(
      `sent       https://github.com/${REPO}/pull/12`,
    );
    expect(hold.stdout).toContain("next       the dispatcher's next tick");
    pullRequest(w, 12, ["jig:hold"], []);
    const release = await w.send([ADDRESS, "release"]);
    expectSpawnExit(release, 0);
    expect(w.writes()).toEqual([
      ["pr", "edit", "12", "--repo", REPO, "--add-label", "jig:hold"],
      ["pr", "edit", "12", "--repo", REPO, "--remove-label", "jig:hold"],
    ]);
  });

  it("posts an answer as one line with its record, and ends with the comment's link", async () => {
    const w = world();
    pullRequest(w, 12, [], [ledgerOn(701, parkedLedger(12))]);
    const r = await w.send([ADDRESS, "answer", PARK_KEY, "keep", "it"]);
    expectSpawnExit(r, 0);
    expect(r.stdout).toContain(
      `sent       https://github.com/${REPO}/pull/12#issuecomment-901`,
    );
    const [post] = w.writes();
    const body = (post ?? []).find((a) => a.startsWith("body=")) ?? "";
    expect(body.split("\n")[0]).toBe(`body=answer ${PARK_KEY}: keep it`);
    expect(body).toContain("<!-- jig-send-answer\n");
    expect(body).toContain('"kind":"drive-answer"');
    expect(body).toContain('"login":"maintainer"');
  });
});
