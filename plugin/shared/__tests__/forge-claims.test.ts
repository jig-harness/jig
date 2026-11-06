/**
 * The forge-claims module (`records/forge-claims.ts`) against the drive's
 * fake forge (`ledger-forge-fixtures.ts`), each forge call in a subprocess of
 * its own: the races the drive scripts for its ledger, run against a claim
 * (two posts at once, a listing that lags behind the post, a twin of the
 * caller's claim, an update that fails while another claim lands), an
 * untrusted claim, the takeover's lapse window and the re-check before an
 * act. The rule itself and the earlier forms of each kind are read here
 * directly.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  FOLLOWUP_CLAIM,
  manualMarker,
  markerRun,
  tickMarker,
} from "../../dispatch/lib/followup-marker.ts";
import {
  type FakeForge,
  fakeForge,
  forgeComment,
} from "../../skills/drive-pr/__tests__/ledger-forge-fixtures.ts";
import {
  MERGE_READY,
  OPENER,
} from "../../skills/drive-pr/scripts/lib/announce.ts";
import {
  CLAIM_MARKER,
  parseClaim,
  renderClaim,
  TAKEOVER_CLAIM,
} from "../../skills/drive-pr/scripts/lib/state/ledger.ts";
import { ok } from "../outcome.ts";
import {
  arbitrate,
  claimBody,
  type ListedClaim,
  readClaim,
  standing,
} from "../records/forge-claims.ts";

const PLUGIN = join(import.meta.dir, "..", "..");
const MODULES = {
  m: join(PLUGIN, "shared", "records", "forge-claims.ts"),
  l: join(PLUGIN, "skills", "drive-pr", "scripts", "lib", "state", "ledger.ts"),
  f: join(PLUGIN, "shared", "records", "launch-claims.ts"),
  a: join(PLUGIN, "skills", "drive-pr", "scripts", "lib", "announce.ts"),
  s: join(PLUGIN, "shared", "records", "shared-forge.ts"),
};

/** What a probe prints: its body's return value, as JSON. */
type Probed = Record<string, unknown>;

/**
 * Run `body` (an async function body with the module as `m`, the takeover
 * claim's ledger as `l`, the follow-up marker's kind as `f` and the shared
 * records on the forge as `s` in scope, beside the helpers below) in a
 * subprocess on the fake forge, and read what it returns.
 */
async function probe(forge: FakeForge, body: string): Promise<Probed> {
  const imports = Object.entries(MODULES)
    .map(
      ([name, path]) =>
        `const ${name} = await import(${JSON.stringify(path)});`,
    )
    .join(" ");
  const code = `${imports}
const fs = await import("node:fs");
const pr = { repo: "{owner}/{repo}", number: 999 };
const writer = { host: "sha256:0123456789abcdef" };
const fast = { retries: 2, delayMs: 20 };
const at = (minutes = 0) => new Date(Date.now() - minutes * 60_000).toISOString();
const takeover = (clone, generation, minutes = 0) => ({ key: l.takeoverKey(generation), generation, writer, at: at(minutes), payload: { actor: "wt-bbbbbbbbbbbbbbbb", clone }, text: "a claim" });
const brief = (s) => ({ verdict: s.verdict, winner: s.winner?.id ?? null, own: s.own?.id ?? null, reason: s.reason });
const comments = () => JSON.parse(fs.readFileSync(process.env.LEDGER_FAKE_DIR + "/comments.json", "utf8"));
const add = (c) => fs.writeFileSync(process.env.LEDGER_FAKE_DIR + "/comments.json", JSON.stringify([...comments(), c]));
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
  return JSON.parse(stdout.trim().split("\n").at(-1) ?? "null") as Probed;
}

/** A takeover claim's comment body, made `minutes` ago. */
function claimText(clone: string, generation: number, minutes = 0): string {
  return renderClaim({
    actor: "wt-cccccccccccccccc",
    clone,
    generation,
    at: new Date(Date.now() - minutes * 60_000).toISOString(),
  });
}

/** How many times the fake forge listed the comments. */
function listings(forge: FakeForge): number {
  return Number(readFileSync(join(forge.dir, "list-count"), "utf8"));
}

const POST = { pr: 999, writer: { host: "sha256:0123456789abcdef" } };

describe("posting a claim and reading it back", () => {
  it("race-on-post: of two claims posted at once on one key, the lower comment id wins", async () => {
    const forge = fakeForge([], { login: "drive-bot" });
    // The rival's post lands first, with the lower id.
    writeFileSync(
      join(forge.dir, "race-on-claim"),
      JSON.stringify(forgeComment(50, claimText("clone-c", 3), "other-bot")),
    );
    const out = await probe(
      forge,
      `const r = await m.post(pr, l.TAKEOVER_CLAIM, takeover("clone-b", 3), { self: "drive-bot", rule: fast });
const rival = await m.check(pr, l.TAKEOVER_CLAIM, l.takeoverKey(3), 50, { generation: 3 });
return { own: r.value.id, mine: brief(r.value.standing.value), theirs: brief(rival.value) };`,
    );
    expect(out).toEqual({
      own: 101,
      mine: { verdict: "lost-to", winner: 50, own: 101, reason: "" },
      theirs: { verdict: "holds", winner: 50, own: 50, reason: "" },
    });
  });

  it("hide-ids: a read-back that lags behind the post reads again and finds the claim", async () => {
    const forge = fakeForge([], { login: "drive-bot" });
    writeFileSync(
      join(forge.dir, "hide-ids"),
      JSON.stringify({ ids: [101], until: 2 }),
    );
    const out = await probe(
      forge,
      `const r = await m.post(pr, l.TAKEOVER_CLAIM, takeover("clone-b", 3), { self: "drive-bot", rule: fast });
return brief(r.value.standing.value);`,
    );
    expect(out).toEqual({
      verdict: "holds",
      winner: 101,
      own: 101,
      reason: "",
    });
    expect(listings(forge)).toBe(2);
  });

  it("hide-ids: a read-back that never finds the claim reports it lost, after its bounded reads", async () => {
    const forge = fakeForge([], { login: "drive-bot" });
    writeFileSync(
      join(forge.dir, "hide-ids"),
      JSON.stringify({ ids: [101], until: 99 }),
    );
    const out = await probe(
      forge,
      `const r = await m.post(pr, l.TAKEOVER_CLAIM, takeover("clone-b", 3), { self: "drive-bot", rule: fast });
return brief(r.value.standing.value);`,
    );
    expect(out).toEqual({
      verdict: "lost",
      winner: null,
      own: null,
      reason: "the listing does not show comment 101",
    });
    // The first read and the rule's two more.
    expect(listings(forge)).toBe(3);
  });

  it("hide-ids: a read-back with a non-finite retry count or a negative delay still ends after its bounded reads", async () => {
    const forge = fakeForge([], { login: "drive-bot" });
    writeFileSync(
      join(forge.dir, "hide-ids"),
      JSON.stringify({ ids: [101], until: 99 }),
    );
    const out = await probe(
      forge,
      `const r = await m.post(pr, l.TAKEOVER_CLAIM, takeover("clone-b", 3), { self: "drive-bot", rule: { retries: Infinity, delayMs: -5 } });
return brief(r.value.standing.value);`,
    );
    expect(out).toMatchObject({ verdict: "lost", own: null });
  }, 60_000);

  it("hide-ids: a read-back that hides the claim but shows an earlier rival reports the loss at once", async () => {
    const forge = fakeForge([], { login: "drive-bot" });
    writeFileSync(
      join(forge.dir, "race-on-claim"),
      JSON.stringify(forgeComment(50, claimText("clone-c", 3), "other-bot")),
    );
    writeFileSync(
      join(forge.dir, "hide-ids"),
      JSON.stringify({ ids: [101], until: 99 }),
    );
    const out = await probe(
      forge,
      `const r = await m.post(pr, l.TAKEOVER_CLAIM, takeover("clone-b", 3), { self: "drive-bot", rule: fast });
return brief(r.value.standing.value);`,
    );
    expect(out).toMatchObject({ verdict: "lost-to", winner: 50, own: null });
    expect(listings(forge)).toBe(1);
  });

  it("twin-on-list: a twin of the claim (same key, generation and time, another writer) is told apart by its comment id", async () => {
    const forge = fakeForge([], { login: "drive-bot" });
    // A concurrent writer's twin, on the listing after the post, with the lower id.
    const out = await probe(
      forge,
      `const draft = takeover("clone-b", 3);
const twin = { ...draft, payload: { ...draft.payload, clone: "clone-c" } };
const comment = (id, body, login) => ({ id, body, user: { login }, author_association: "MEMBER", updated_at: "2026-10-01T11:00:00Z" });
const own = { ...comment(101, m.claimBody(l.TAKEOVER_CLAIM, draft), "drive-bot") };
fs.writeFileSync(process.env.LEDGER_FAKE_DIR + "/twin.json", JSON.stringify([comment(60, m.claimBody(l.TAKEOVER_CLAIM, twin), "other-bot"), own]));
fs.writeFileSync(process.env.LEDGER_FAKE_DIR + "/write-on-list", JSON.stringify({ n: 1, path: process.env.LEDGER_FAKE_DIR + "/comments.json", text: fs.readFileSync(process.env.LEDGER_FAKE_DIR + "/twin.json", "utf8") }));
const r = await m.post(pr, l.TAKEOVER_CLAIM, draft, { self: "drive-bot", rule: fast });
const later = await m.check(pr, l.TAKEOVER_CLAIM, l.takeoverKey(3), 60, { generation: 3 });
return { mine: brief(r.value.standing.value), twin: brief(later.value) };`,
    );
    expect(out).toEqual({
      mine: { verdict: "lost-to", winner: 60, own: 101, reason: "" },
      twin: { verdict: "holds", winner: 60, own: 60, reason: "" },
    });
  });

  it("fail-patch: an update that fails while an earlier claim lands leaves the claim to the re-check, which reports it lost", async () => {
    const forge = fakeForge([], { login: "drive-bot" });
    writeFileSync(
      join(forge.dir, "fail-patch"),
      JSON.stringify(forgeComment(50, manualMarker(false, POST), "maintainer")),
    );
    const out = await probe(
      forge,
      `const draft = f.manualClaim(false, { pr: 999, writer });
const r = await m.post(pr, f.FOLLOWUP_CLAIM, draft, { self: "drive-bot", rule: fast });
const shared = s.forgeShared({ login: "drive-bot" });
const ended = await shared.end({ repo: pr.repo, pr: 999 }, "followup", r.value.id, { state: "ended", at: at(), exit: null, outcome: "done" });
const edited = ended.ok ? "" : ended.failure.reason;
const after = await m.check(pr, f.FOLLOWUP_CLAIM, f.FOLLOWUP_KEY, r.value.id, { self: "drive-bot" });
return { posted: brief(r.value.standing.value), edited, after: brief(after.value) };`,
    );
    expect(out).toMatchObject({
      posted: { verdict: "holds", winner: 101, own: 101 },
      after: { verdict: "lost-to", winner: 50, own: 101 },
    });
    expect(String(out.edited)).toContain("update failed");
  });

  it("ignores an earlier claim from an author the forge does not vouch for, and lists it as untrusted", async () => {
    const forge = fakeForge(
      [forgeComment(50, claimText("clone-c", 3), "passer-by", "NONE")],
      { login: "drive-bot" },
    );
    const out = await probe(
      forge,
      `const r = await m.post(pr, l.TAKEOVER_CLAIM, takeover("clone-b", 3), { self: "drive-bot", rule: fast });
const s = r.value.standing.value;
return { ...brief(s), untrusted: s.listing.filter((c) => !c.trusted).map((c) => c.id) };`,
    );
    expect(out).toEqual({
      verdict: "holds",
      winner: 101,
      own: 101,
      reason: "",
      untrusted: [50],
    });
  });

  it("counts the caller's own login as trusted, whatever its association", async () => {
    const forge = fakeForge(
      [forgeComment(50, claimText("clone-c", 3), "drive-bot", "NONE")],
      { login: "drive-bot" },
    );
    const out = await probe(
      forge,
      `const trusted = (r) => r.value.filter((c) => c.trusted).map((c) => c.id);
const r = await m.list(pr, l.TAKEOVER_CLAIM, "drive-bot");
const anon = await m.list(pr, l.TAKEOVER_CLAIM);
return { self: trusted(r), anonymous: trusted(anon) };`,
    );
    expect(out).toEqual({ self: [50], anonymous: [] });
  });

  it("lets a claim made past the lapse window replace a winner whose owner never acted", async () => {
    const forge = fakeForge(
      [
        forgeComment(50, claimText("clone-c", 3, 300), "other-bot"),
        forgeComment(60, claimText("clone-d", 4, 10), "other-bot"),
      ],
      { login: "drive-bot" },
    );
    const out = await probe(
      forge,
      `const rule = { ...fast, ...l.claimRule() };
const lapsed = await m.post(pr, l.TAKEOVER_CLAIM, takeover("clone-b", 3), { self: "drive-bot", rule });
const fresh = await m.post(pr, l.TAKEOVER_CLAIM, takeover("clone-b", 4), { self: "drive-bot", rule });
return { lapsed: brief(lapsed.value.standing.value), fresh: brief(fresh.value.standing.value) };`,
    );
    expect(out).toEqual({
      lapsed: { verdict: "holds", winner: 101, own: 101, reason: "" },
      fresh: { verdict: "lost-to", winner: 60, own: 102, reason: "" },
    });
  });

  it("refuses to call a claim won when the read-back cannot be read, and still names the comment posted", async () => {
    const forge = fakeForge([], { login: "drive-bot" });
    writeFileSync(join(forge.dir, "fail-list-after"), "0");
    const out = await probe(
      forge,
      `const r = await m.post(pr, l.TAKEOVER_CLAIM, takeover("clone-b", 3), { self: "drive-bot", rule: fast });
return { id: r.value.id, standing: r.value.standing.failure };`,
    );
    expect(out).toMatchObject({
      id: 101,
      standing: { code: "unreadable" },
    });
    expect(JSON.stringify(out)).toContain("the comments could not be read");
  });
});

describe("re-checking a claim before an act, and withdrawing it", () => {
  it("answers lost once an earlier trusted claim appears, and holds before", async () => {
    const forge = fakeForge([], { login: "drive-bot" });
    const out = await probe(
      forge,
      `const draft = f.manualClaim(false, { pr: 999, writer });
const r = await m.post(pr, f.FOLLOWUP_CLAIM, draft, { self: "drive-bot", rule: fast });
const before = await m.check(pr, f.FOLLOWUP_CLAIM, f.FOLLOWUP_KEY, r.value.id, { self: "drive-bot" });
add({ id: 50, body: m.claimBody(f.FOLLOWUP_CLAIM, f.manualClaim(false, { pr: 999, writer })), user: { login: "maintainer" }, author_association: "MEMBER" });
const after = await m.check(pr, f.FOLLOWUP_CLAIM, f.FOLLOWUP_KEY, r.value.id, { self: "drive-bot" });
return { before: brief(before.value), after: brief(after.value) };`,
    );
    expect(out).toEqual({
      before: { verdict: "holds", winner: 101, own: 101, reason: "" },
      after: { verdict: "lost-to", winner: 50, own: 101, reason: "" },
    });
  });

  it("withdraws the caller's own claim, after which a check no longer lists it", async () => {
    const forge = fakeForge([], { login: "drive-bot" });
    const out = await probe(
      forge,
      `const r = await m.post(pr, f.FOLLOWUP_CLAIM, f.manualClaim(false, { pr: 999, writer }), { self: "drive-bot", rule: fast });
const gone = await m.withdraw(pr, r.value.id);
const after = await m.check(pr, f.FOLLOWUP_CLAIM, f.FOLLOWUP_KEY, r.value.id, { self: "drive-bot" });
return { gone: gone.ok, after: brief(after.value), left: comments().length };`,
    );
    expect(out).toMatchObject({
      gone: true,
      after: { verdict: "lost", own: null },
      left: 0,
    });
  });
});

/** A trusted follow-up marker as the module lists one. */
function listedMarker(id: number, readable: boolean): ListedClaim {
  return {
    id,
    login: "maintainer",
    association: "MEMBER",
    createdAt: "2026-11-04T09:30:00Z",
    trusted: true,
    record: readable
      ? ok({
          key: "followup",
          at: "2026-11-04T09:30:00Z",
          payload: { pr: 9, run: "manual", outcome: "running" },
          legacy: false,
        })
      : { ok: false, failure: { code: "unreadable", reason: "damaged" } },
  };
}

describe("the rule", () => {
  it("lets the earliest comment win per key and generation, and a later one past the lapse window replace it", () => {
    const at = (minutes: number) =>
      new Date(
        Date.parse("2026-11-04T12:00:00Z") + minutes * 60_000,
      ).toISOString();
    const claims = [
      { id: 30, key: "takeover:4", generation: 4, at: at(0) },
      { id: 20, key: "takeover:4", generation: 4, at: at(0) },
      { id: 40, key: "takeover:5", generation: 5, at: at(0) },
      { id: 50, key: "takeover:4", generation: 4, at: at(300) },
    ];
    expect(arbitrate(claims).map((c) => c.id)).toEqual([20, 40]);
    expect(
      arbitrate(claims, { lapseMs: 240 * 60_000 }).map((c) => c.id),
    ).toEqual([40, 50]);
  });

  it("holds an unreadable trusted marker of a one-key kind against every later claim", () => {
    const listing = [listedMarker(5, false), listedMarker(7, true)];
    const s = standing(FOLLOWUP_CLAIM, listing, {
      id: 7,
      key: "followup",
      at: "2026-11-04T09:30:00Z",
    });
    expect(s.verdict).toBe("lost-to");
    expect(s.winner?.id).toBe(5);
    expect(s.winner?.unreadable).toBe("damaged");
  });
});

describe("the forms each kind was written in before", () => {
  it("reads a takeover claim written before claims carried the envelope", () => {
    const legacy = [
      CLAIM_MARKER,
      "**Drive claim** · `drive-pr-takeover-claim` · an older driver's claim.",
      "",
      "<!-- drive-pr-takeover-claim-data",
      JSON.stringify({
        actor: "wt-cccccccccccccccc",
        clone: "clone-c",
        generation: 4,
        at: "2026-10-01T12:00:00.000Z",
      }),
      "-->",
      "",
    ].join("\n");
    expect(parseClaim(legacy)).toEqual({
      actor: "wt-cccccccccccccccc",
      clone: "clone-c",
      generation: 4,
      at: "2026-10-01T12:00:00.000Z",
    });
    const read = readClaim(TAKEOVER_CLAIM, legacy);
    expect(read?.ok && read.value).toMatchObject({
      key: "takeover:4",
      legacy: true,
    });
  });

  it("writes a takeover claim an older driver still reads: the claim's own fields at the top level", () => {
    const body = claimText("clone-b", 4);
    const data = body.split("\n")[2] ?? "";
    expect(JSON.parse(data)).toMatchObject({
      kind: "drive-takeover-claim",
      v: 1,
      key: "takeover:4",
      generation: 4,
      actor: "wt-cccccccccccccccc",
      clone: "clone-b",
    });
  });

  it("reads a follow-up marker of version 1 and in the line form, and refuses one copied from another pull request", () => {
    const id = "20261104T093000Z-aaaaaaaa";
    const v1 = [
      "<!-- jig-dispatch-followup -->",
      "<!-- jig-dispatch-followup-data",
      JSON.stringify({
        kind: "dispatch-followup",
        v: 1,
        key: "9",
        writer: { host: "sha256:0123456789abcdef" },
        at: "2026-11-04T09:30:00.000Z",
        run: "tick",
        record: id,
      }),
      "-->",
      `jig dispatch follow-up · record: ${id}`,
    ].join("\n");
    expect(markerRun(v1, 9)).toEqual({ kind: "tick", record: id });
    expect(markerRun(v1, 10)).toEqual({
      kind: "unreadable",
      reason: "its record names pull request #9",
    });
    expect(markerRun(tickMarker(id, { ...POST, pr: 9 }), 9)).toEqual({
      kind: "tick",
      record: id,
    });
  });

  it("refuses a follow-up marker of the current version that claims another key", () => {
    const id = "20261104T093000Z-aaaaaaaa";
    const body = tickMarker(id, { ...POST, pr: 9 }).replace(
      '"key":"followup"',
      '"key":"9"',
    );
    expect(body).toContain('"key":"9"');
    expect(markerRun(body, 9).kind).toBe("unreadable");
  });

  it("refuses a merge-ready announcement whose record and head marker name different heads", () => {
    const h1 = "0123456789abcdef0123456789abcdef01234567";
    const h2 = "fedcba9876543210fedcba9876543210fedcba98";
    const body = claimBody(MERGE_READY, {
      key: `merge-ready:${h1}`,
      writer: { host: "sha256:0123456789abcdef" },
      payload: {},
      text: `done\n\n<!-- drive-pr-merge-ready: ${h1} -->`,
    });
    const read = readClaim(MERGE_READY, body);
    expect(read?.ok).toBe(true);
    const other = body.replace(
      `<!-- drive-pr-merge-ready: ${h1} -->`,
      `<!-- drive-pr-merge-ready: ${h2} -->`,
    );
    expect(readClaim(MERGE_READY, other)?.ok).toBe(false);
    const none = body.replace(`<!-- drive-pr-merge-ready: ${h1} -->`, "");
    expect(readClaim(MERGE_READY, none)?.ok).toBe(false);
  });

  it("keeps a trusted announcement whose record and head marker disagree visible, naming no head", async () => {
    const h1 = "0123456789abcdef0123456789abcdef01234567";
    const h2 = "fedcba9876543210fedcba9876543210fedcba98";
    const body = claimBody(MERGE_READY, {
      key: `merge-ready:${h1}`,
      writer: { host: "sha256:0123456789abcdef" },
      payload: {},
      text: `done\n\n<!-- drive-pr-merge-ready: ${h1} -->`,
    }).replace(
      `<!-- drive-pr-merge-ready: ${h1} -->`,
      `<!-- drive-pr-merge-ready: ${h2} -->`,
    );
    const forge = fakeForge([forgeComment(7, body)], { login: "drive-bot" });
    const out = await probe(
      forge,
      `const all = await a.announcements("999");
return { all, ids: a.announcedIds(all, ${JSON.stringify(h1)}), note: a.unreadableNote(all) };`,
    );
    expect(out.ids).toEqual([]);
    expect(
      (out.all as { id: number; head: string }[]).map((x) => [x.id, x.head]),
    ).toEqual([[7, ""]]);
    expect(out.note).toContain("comment 7");
  });

  it("reads a merge-ready announcement that only ends with its head marker, and writes one that still does", () => {
    const head = "0123456789abcdef0123456789abcdef01234567";
    const legacy = `${OPENER}\n\nThe review drive converged.\n\n<!-- drive-pr-merge-ready: ${head} -->`;
    const read = readClaim(MERGE_READY, legacy);
    expect(read?.ok && read.value.key).toBe(`merge-ready:${head}`);
    const quoted = `Quoting it: <!-- drive-pr-merge-ready: ${head} -->`;
    expect(readClaim(MERGE_READY, quoted)).toBeNull();
  });
});
