/**
 * The shared records on the forge (`records/shared-forge.ts`) against the
 * drive's fake forge (`ledger-forge-fixtures.ts`), each forge call in a
 * subprocess of its own: a drive's launch claimed on the attempt after the
 * latest, a current claim with no end holding the launch for every host, a
 * rival on the same attempt winning by its earlier comment, a takeover
 * claiming past a wedged driver's claim, the read-back answering a listing
 * that lags, a launch's end written onto its own claim, and the follow-up
 * marker as the follow-up stage's shared record. The read-back's answer is
 * read here directly too.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  type FakeForge,
  fakeForge,
  forgeComment,
} from "../../skills/drive-pr/__tests__/ledger-forge-fixtures.ts";
import { failed, ok } from "../outcome.ts";
import {
  claimBody,
  type ListedClaim,
  standing,
} from "../records/forge-claims.ts";
import {
  endedClaim,
  FOLLOWUP_CLAIM,
  LAUNCH_CLAIM,
  launchClaim,
  manualClaim,
} from "../records/launch-claims.ts";
import type { LaunchDraft, LaunchEnd } from "../records/shared.ts";
import { answerOf } from "../records/shared-forge.ts";

const PLUGIN = join(import.meta.dir, "..", "..");
const SHARED = join(PLUGIN, "shared", "records", "shared-forge.ts");

const WRITER = { host: "sha256:0123456789abcdef" };
const HOST_A = "sha256:aaaaaaaaaaaaaaaa";
const HOST_B = "sha256:bbbbbbbbbbbbbbbb";
const RECORD_A = "20261105T090000Z-aaaaaaaa";
const RECORD_B = "20261105T100000Z-bbbbbbbb";
const FACTS = "generation 3, exit 16, heartbeat 2026-11-05T08:00:00.000Z";

/** A drive's launch on PR 999, by host `host` under launch record `record`. */
function drive(
  host: string,
  record: string,
  action: "rearm" | "takeover" = "rearm",
): LaunchDraft {
  return {
    stage: "drive",
    pr: 999,
    run: "tick",
    action,
    record,
    host,
    owner: true,
    facts: FACTS,
    writer: WRITER,
  };
}

/** A launch claim comment, as another host posted it, its end written when it has one. */
function launchComment(
  id: number,
  draft: LaunchDraft,
  attempt: number,
  end: LaunchEnd | null = null,
  login = "other-bot",
  association = "MEMBER",
) {
  const posted = launchClaim(draft, attempt, "2026-11-05T09:00:00.000Z");
  const record = {
    key: posted.key,
    generation: attempt,
    at: posted.at ?? "",
    writer: WRITER,
    payload: posted.payload,
    legacy: false,
  };
  const body = claimBody(
    LAUNCH_CLAIM,
    end === null ? posted : endedClaim("drive", record, 999, end, WRITER),
  );
  return forgeComment(id, body, login, association);
}

/** Run `body` with the shared records on the forge as `shared`, signed in as drive-bot, and read what it returns. */
async function probe(
  forge: FakeForge,
  body: string,
): Promise<Record<string, unknown>> {
  const code = `const s = await import(${JSON.stringify(SHARED)});
const shared = s.forgeShared({ login: "drive-bot" });
const pr = { repo: "{owner}/{repo}", pr: 999 };
const writer = ${JSON.stringify(WRITER)};
const fast = { retries: 2, delayMs: 20 };
const drive = (host, record, action = "rearm") => ({ stage: "drive", pr: 999, run: "tick", action, record, host, owner: true, facts: ${JSON.stringify(FACTS)}, writer });
const brief = (a) => a.ok ? { kind: a.value.kind, id: a.value.id ?? null, attempt: a.value.attempt ?? null, by: a.value.by?.id ?? null } : { failed: a.failure.code, reason: a.failure.reason };
console.log(JSON.stringify(await (async () => { ${body} })()));`;
  const proc = Bun.spawn([process.execPath, "-e", code], {
    cwd: forge.repo,
    env: forge.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expectSpawnExit({ exitCode, stdout, stderr }, 0);
  return JSON.parse(stdout.trim().split("\n").at(-1) ?? "null");
}

/** How many times the fake forge listed the comments. */
function listings(forge: FakeForge): number {
  return Number(readFileSync(join(forge.dir, "list-count"), "utf8"));
}

const ENDED: LaunchEnd = {
  state: "ended",
  at: "2026-11-05T09:30:00.000Z",
  exit: 16,
  outcome: null,
};

describe("claiming a drive's launch", () => {
  it("claims the first launch on attempt 1, naming its host, record and facts", async () => {
    const forge = fakeForge([], { login: "drive-bot" });
    const out = await probe(
      forge,
      `const a = await shared.claim(pr, drive(${JSON.stringify(HOST_A)}, ${JSON.stringify(RECORD_A)}), fast);
const listed = await shared.list(pr, "drive");
return { answer: brief(a), says: listed.value[0].says.value };`,
    );
    expect(out.answer).toEqual({
      kind: "holds",
      id: 101,
      attempt: 1,
      by: null,
    });
    expect(out.says).toMatchObject({
      pr: 999,
      attempt: 1,
      action: "rearm",
      record: RECORD_A,
      host: HOST_A,
      owner: true,
      facts: FACTS,
      end: null,
    });
    expect(forge.comments()[0]?.body.split("\n").at(-1)).toBe(
      `jig dispatch launch · rearm · record: ${RECORD_A} · host: ${HOST_A}`,
    );
  });

  it("reports another host's current claim with no end as holding the launch, and posts nothing", async () => {
    const forge = fakeForge([launchComment(50, drive(HOST_B, RECORD_B), 1)], {
      login: "drive-bot",
    });
    const out = await probe(
      forge,
      `return brief(await shared.claim(pr, drive(${JSON.stringify(HOST_A)}, ${JSON.stringify(RECORD_A)}), fast));`,
    );
    expect(out).toEqual({ kind: "held", id: null, attempt: null, by: 50 });
    expect(forge.comments()).toHaveLength(1);
  });

  it("answers a claim made again under the same host and launch record with the claim it holds, and posts nothing", async () => {
    const forge = fakeForge([launchComment(50, drive(HOST_A, RECORD_A), 1)], {
      login: "drive-bot",
    });
    const out = await probe(
      forge,
      `return brief(await shared.claim(pr, drive(${JSON.stringify(HOST_A)}, ${JSON.stringify(RECORD_A)}), fast));`,
    );
    expect(out).toEqual({ kind: "holds", id: 50, attempt: 1, by: null });
    expect(forge.comments()).toHaveLength(1);
  });

  it("claims the next attempt once the current claim's host wrote its end", async () => {
    const forge = fakeForge(
      [launchComment(50, drive(HOST_B, RECORD_B), 1, ENDED)],
      { login: "drive-bot" },
    );
    const out = await probe(
      forge,
      `return brief(await shared.claim(pr, drive(${JSON.stringify(HOST_A)}, ${JSON.stringify(RECORD_A)}), fast));`,
    );
    expect(out).toEqual({ kind: "holds", id: 101, attempt: 2, by: null });
  });

  it("race-on-claim: of two hosts claiming one attempt at once, the earlier comment wins and the later is withdrawn", async () => {
    const forge = fakeForge([], { login: "drive-bot" });
    // Host B's claim lands between host A's read and its post, with the lower id.
    writeFileSync(
      join(forge.dir, "race-on-claim"),
      JSON.stringify(launchComment(50, drive(HOST_B, RECORD_B), 1)),
    );
    const out = await probe(
      forge,
      `const a = await shared.claim(pr, drive(${JSON.stringify(HOST_A)}, ${JSON.stringify(RECORD_A)}), fast);
const released = await shared.release(pr, a.value.id);
return { answer: brief(a), released: released.ok };`,
    );
    expect(out).toEqual({
      answer: { kind: "earlier", id: 101, attempt: null, by: 50 },
      released: true,
    });
    expect(forge.comments().map((c) => c.id)).toEqual([50]);
  });

  it("lets a takeover claim the next attempt past a wedged driver's claim that has no end", async () => {
    const forge = fakeForge([launchComment(50, drive(HOST_B, RECORD_B), 1)], {
      login: "drive-bot",
    });
    const out = await probe(
      forge,
      `return brief(await shared.claim(pr, drive(${JSON.stringify(HOST_A)}, ${JSON.stringify(RECORD_A)}, "takeover"), fast));`,
    );
    expect(out).toEqual({ kind: "holds", id: 101, attempt: 2, by: null });
  });

  it("ignores a claim from an author the forge does not vouch for", async () => {
    const forge = fakeForge(
      [launchComment(50, drive(HOST_B, RECORD_B), 1, null, "stranger", "NONE")],
      { login: "drive-bot" },
    );
    const out = await probe(
      forge,
      `return brief(await shared.claim(pr, drive(${JSON.stringify(HOST_A)}, ${JSON.stringify(RECORD_A)}), fast));`,
    );
    expect(out).toEqual({ kind: "holds", id: 101, attempt: 1, by: null });
  });

  it("claims nothing while a trusted launch claim does not read, for a person to settle", async () => {
    const damaged = forgeComment(
      50,
      "<!-- jig-dispatch-launch-claim -->\n<!-- jig-dispatch-launch-claim-data\n{not json\n-->",
      "other-bot",
    );
    const forge = fakeForge([damaged], { login: "drive-bot" });
    const out = await probe(
      forge,
      `return brief(await shared.claim(pr, drive(${JSON.stringify(HOST_A)}, ${JSON.stringify(RECORD_A)}), fast));`,
    );
    expect(out).toMatchObject({ failed: "unreadable" });
    expect(String(out.reason)).toContain("comment 50");
    expect(forge.comments()).toHaveLength(1);
  });
});

describe("a held launch's claim after a replay or a takeover", () => {
  it("republishes the change a replay acts on, with the ones it moved on from, before it launches", async () => {
    const first = { ...drive(HOST_A, RECORD_A), change: "head one" };
    const forge = fakeForge([launchComment(50, first, 1)], {
      login: "drive-bot",
    });
    const out = await probe(
      forge,
      `return brief(await shared.claim(pr, { ...drive(${JSON.stringify(HOST_A)}, ${JSON.stringify(RECORD_A)}), change: "head two", earlier: ["head one"] }, fast));`,
    );
    expect(out).toEqual({ kind: "holds", id: 50, attempt: 1, by: null });
    expect(forge.comments()).toHaveLength(1);
    const body = String(forge.comments()[0]?.body);
    expect(body).toContain("head two");
    expect(body).toContain("head one");
  });

  it("reads an earlier attempt's claim as lost once a takeover holds a later one", async () => {
    const forge = fakeForge(
      [
        launchComment(50, drive("sha256:cccccccccccccccc", RECORD_A), 1),
        launchComment(60, drive(HOST_B, RECORD_B, "takeover"), 2),
      ],
      { login: "drive-bot" },
    );
    const out = await probe(
      forge,
      `const r = await shared.check(pr, "drive", 50); return r.ok ? { verdict: r.value.verdict, winner: r.value.winner?.id ?? null } : { failed: r.failure.reason };`,
    );
    expect(out).toEqual({ verdict: "lost-to", winner: 60 });
  });

  it("reads an ended claim as no longer holding the launch", async () => {
    const forge = fakeForge(
      [launchComment(50, drive("sha256:cccccccccccccccc", RECORD_A), 1, ENDED)],
      { login: "drive-bot" },
    );
    const out = await probe(
      forge,
      `const r = await shared.check(pr, "drive", 50); return r.ok ? { verdict: r.value.verdict } : { failed: r.failure.reason };`,
    );
    expect(out).toEqual({ verdict: "lost" });
  });
});

describe("the read-back while the forge's listing lags", () => {
  it("hide-ids: reads again while the listing does not show the claim, and then holds it", async () => {
    const forge = fakeForge([], { login: "drive-bot" });
    // The read before the post and the first read-back both lag behind it.
    writeFileSync(
      join(forge.dir, "hide-ids"),
      JSON.stringify({ ids: [101], until: 3 }),
    );
    const out = await probe(
      forge,
      `return brief(await shared.claim(pr, drive(${JSON.stringify(HOST_A)}, ${JSON.stringify(RECORD_A)}), fast));`,
    );
    expect(out).toEqual({ kind: "holds", id: 101, attempt: 1, by: null });
    expect(listings(forge)).toBe(3);
  });

  it("hide-ids: answers missing once the bounded reads never list the claim", async () => {
    const forge = fakeForge([], { login: "drive-bot" });
    writeFileSync(
      join(forge.dir, "hide-ids"),
      JSON.stringify({ ids: [101], until: 99 }),
    );
    const out = await probe(
      forge,
      `return brief(await shared.claim(pr, drive(${JSON.stringify(HOST_A)}, ${JSON.stringify(RECORD_A)}), fast));`,
    );
    expect(out).toEqual({ kind: "missing", id: 101, attempt: null, by: null });
    // The read before the post, the read-back, and the rule's two more.
    expect(listings(forge)).toBe(4);
  });
});

describe("a launch's end", () => {
  it("is written onto the claim's own comment, keeping its attempt and time, and read by every host", async () => {
    const forge = fakeForge([], { login: "drive-bot" });
    const out = await probe(
      forge,
      `const a = await shared.claim(pr, drive(${JSON.stringify(HOST_A)}, ${JSON.stringify(RECORD_A)}), fast);
const before = (await shared.list(pr, "drive")).value[0].says.value.at;
const ended = await shared.end(pr, "drive", a.value.id, ${JSON.stringify(ENDED)});
const after = (await shared.list(pr, "drive")).value[0].says.value;
return { ended: ended.ok, before, after };`,
    );
    expect(out.ended).toBe(true);
    const after = out.after as Record<string, unknown>;
    expect(after).toMatchObject({ attempt: 1, end: ENDED, record: RECORD_A });
    expect(after.at).toBe(out.before);
    expect(forge.comments()[0]?.body.split("\n").at(-1)).toBe(
      `jig dispatch launch · rearm · record: ${RECORD_A} · host: ${HOST_A} · ended exit 16`,
    );
  });

  it("is refused on a comment that is no trusted claim that reads", async () => {
    const forge = fakeForge(
      [launchComment(50, drive(HOST_B, RECORD_B), 1, null, "stranger", "NONE")],
      { login: "drive-bot" },
    );
    const out = await probe(
      forge,
      `const r = await shared.end(pr, "drive", 50, ${JSON.stringify(ENDED)});
return { ok: r.ok, code: r.ok ? null : r.failure.code };`,
    );
    expect(out).toEqual({ ok: false, code: "not-own" });
  });
});

describe("the follow-up marker as the follow-up's shared record", () => {
  it("names the tick's host and record, and carries the answer its host writes onto it", async () => {
    const forge = fakeForge([], { login: "drive-bot" });
    const out = await probe(
      forge,
      `const draft = { stage: "followup", pr: 999, run: "tick", action: "followup", record: ${JSON.stringify(RECORD_A)}, host: ${JSON.stringify(HOST_A)}, owner: false, writer };
const a = await shared.claim(pr, draft, fast);
const open = (await shared.list(pr, "followup")).value[0].says.value;
await shared.end(pr, "followup", a.value.id, { state: "ended", at: "2026-11-05T10:00:00.000Z", exit: 0, outcome: "done" });
const done = (await shared.list(pr, "followup")).value[0].says.value;
return { answer: brief(a), open, done };`,
    );
    expect(out.answer).toEqual({
      kind: "holds",
      id: 101,
      attempt: 1,
      by: null,
    });
    expect(out.open).toMatchObject({
      run: "tick",
      record: RECORD_A,
      host: HOST_A,
      owner: false,
      end: null,
    });
    expect(out.done).toMatchObject({
      record: RECORD_A,
      host: HOST_A,
      end: { state: "ended", outcome: "done", at: "2026-11-05T10:00:00.000Z" },
    });
    expect(forge.comments()[0]?.body.split("\n").at(-1)).toBe(
      `jig dispatch follow-up · record: ${RECORD_A} · outcome: done`,
    );
  });

  it("reads a tick's marker written before markers named their host as naming none", async () => {
    const legacy = forgeComment(
      50,
      `<!-- jig-dispatch-followup -->\njig dispatch follow-up · record: ${RECORD_A}`,
      "drive-bot",
    );
    const forge = fakeForge([legacy], { login: "drive-bot" });
    const out = await probe(
      forge,
      `return (await shared.list(pr, "followup")).value[0].says.value;`,
    );
    expect(out).toMatchObject({
      run: "tick",
      record: RECORD_A,
      host: null,
      end: null,
      legacy: true,
    });
  });
});

/** A trusted follow-up marker as the forge-claims module lists one; `null` for one whose record does not read. */
function marker(id: number, payload: Record<string, unknown> | null) {
  return {
    id,
    login: "drive-bot",
    association: "MEMBER",
    createdAt: "2026-11-04T09:30:00.000Z",
    trusted: true,
    record:
      payload === null
        ? failed("unreadable", "its record does not read")
        : ok({
            key: "followup",
            at: "2026-11-04T09:30:00.000Z",
            payload: { pr: 9, ...payload },
            legacy: false,
          }),
  } satisfies ListedClaim;
}

/** How marker 7, just posted for the tick under record `r1` or a manual run, comes out of a read-back listing `listing`. */
function answer(listing: ListedClaim[], run: "tick" | "manual" = "tick") {
  const seen = ok(
    standing(FOLLOWUP_CLAIM, listing, {
      id: 7,
      key: "followup",
      at: "2026-11-04T09:30:00.000Z",
    }),
  );
  const draft: LaunchDraft = {
    stage: "followup",
    pr: 9,
    run,
    action: "followup",
    record: run === "tick" ? "r1" : null,
    host: null,
    owner: null,
    writer: WRITER,
  };
  return answerOf("followup", 9, 7, seen, draft, 1).kind;
}

const tick = (record: string) => ({ run: "tick", record });
const manual = (outcome: string) => ({ run: "manual", outcome });

describe("the read-back's answer", () => {
  it("is missing when the read-back lacks the posted claim, and holds when it lists it", () => {
    expect(answer([marker(9, tick("r1"))])).toBe("missing");
    expect(answer([marker(7, tick("r1")), marker(9, tick("r2"))])).toBe(
      "holds",
    );
  });

  it("names an earlier trusted claim as the winner, whatever its record says", () => {
    expect(answer([marker(5, null), marker(7, tick("r1"))])).toBe("earlier");
  });

  it("is altered when the posted claim was edited to another body", () => {
    expect(answer([marker(7, null)])).toBe("altered");
    expect(answer([marker(7, tick("r2"))])).toBe("altered");
  });

  it("keeps a manual claim marked done between the post and the read-back as done, not altered", () => {
    expect(answer([marker(7, manual("running"))], "manual")).toBe("holds");
    expect(answer([marker(7, manual("done"))], "manual")).toBe("done");
    expect(answer([marker(7, manual("done"))])).toBe("altered");
  });

  it("reads a person's marker in its own form", () => {
    const body = claimBody(
      FOLLOWUP_CLAIM,
      manualClaim(false, { pr: 9, writer: WRITER }),
    );
    expect(body.split("\n").at(-1)).toBe(
      "jig dispatch follow-up · run: manual · outcome: running",
    );
  });
});
