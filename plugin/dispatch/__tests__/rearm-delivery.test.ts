/** Shared admission and acknowledgment for explicit rearm requests. */
import { expect, it } from "bun:test";
import { resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { fakeForge } from "../../skills/drive-pr/__tests__/ledger-forge-fixtures.ts";

const SHARED = resolve(import.meta.dir, "../lib/shared-launches.ts");
const FORGE = resolve(import.meta.dir, "../../shared/records/shared-forge.ts");

async function probe(body: string): Promise<unknown> {
  const forge = fakeForge([], { login: "drive-bot" });
  const script = `
const { launchClaimer, settleOwnClaims, foreignHold } = await import(${JSON.stringify(SHARED)});
const { forgeShared } = await import(${JSON.stringify(FORGE)});
const records = forgeShared({ login: "drive-bot" });
const ctx = { records, slug: "{owner}/{repo}", host: "sha256:aaaaaaaaaaaaaaaa", owner: true, login: "drive-bot", root: ${JSON.stringify(forge.dir)}, rule: { retries: 1, delayMs: 1 } };
const at = "2026-11-07T00:00:00.000Z";
const record = { version: 1, id: "20261107T000000Z-aaaaaaaa", token: "t", action: "rearm", repo: ctx.slug, repoPath: ${JSON.stringify(forge.repo)}, pr: 999, account: "a", vendor: "claude", configDir: "/c", wallBackoffMs: 1, replaces: null, facts: "generation 1, exit 1, heartbeat x", createdAt: at, workspace: null, attempts: [{ at, outcome: "sent", detail: "accepted" }], item: null, agentId: null, model: null, effort: null, released: false, command: null, marker: null, rearmLabel: "jig:rearm" };
const target = { repo: ctx.slug, pr: 999 };
const pr = { number: 999, url: "", title: "", head: "feature", class: "re-armable", why: "request", evidence: { rearm: true } };
console.log(JSON.stringify(await (async () => { ${body} })()));`;
  const proc = Bun.spawn([process.execPath, "-e", script], {
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
  expectSpawnExit({ stdout, stderr, exitCode }, 0);
  return JSON.parse(stdout.trim().split("\n").at(-1) ?? "null");
}

it("admits an explicit rearm past ended refusals from either host while preserving automatic refusal holds", async () => {
  expect(
    await probe(`
const answers = [];
for (const host of [ctx.host, "sha256:bbbbbbbbbbbbbbbb"]) {
  for (const exit of [11, 13, 20]) {
    const prior = await launchClaimer({ ...ctx, host }).claim({ ...record, id: "20261107T000000Z-bbbbbbbb" });
    if (!("claim" in prior)) throw new Error(JSON.stringify(prior));
    await records.end(target, "drive", prior.claim, { state: "ended", at, exit, outcome: null });
    const automatic = await launchClaimer(ctx).claim({ ...record, rearmLabel: null });
    answers.push("refused" in automatic);
    const next = await launchClaimer(ctx).claim(record);
    answers.push("claim" in next);
    if ("claim" in next) await records.release(target, next.claim);
    await records.release(target, prior.claim);
  }
}
return answers;
`),
  ).toEqual(Array(12).fill(true));
});

it("keeps the shared claim open until the delivered request is acknowledged", async () => {
  expect(
    await probe(`
const claimed = await launchClaimer(ctx).claim(record);
const read = { record, state: { kind: "ended", exit: { at, code: 1, signal: null }, process: null }, result: null };
let claims = new Map([[999, await records.list(target, "drive")]]);
await settleOwnClaims(ctx, claims, [], [read], new Map(), at);
const pending = await records.list(target, "drive");
const hold = foreignHold(pr, pending, "other-host");
const pendingAdmission = await launchClaimer({ ...ctx, host: "other-host" }).claim({ ...record, id: "20261107T000000Z-cccccccc" });
record.rearmConsumed = true;
claims = new Map([[999, pending]]);
await settleOwnClaims(ctx, claims, [], [read], new Map(), at);
const acknowledged = await records.list(target, "drive");
return { pending: hold.kind, held: "refused" in pendingAdmission, ended: acknowledged.value[0].says.value.end?.state };
`),
  ).toEqual({ pending: "held", held: true, ended: "ended" });
});

it("leaves delivered rearm acknowledgments pending when the tick has no time left", async () => {
  expect(
    await probe(`
const { applyDrives } = await import(${JSON.stringify(resolve(import.meta.dir, "../lib/actions/drive.ts"))});
const { writeRecord, readRecord } = await import(${JSON.stringify(resolve(import.meta.dir, "../lib/launches.ts"))});
writeRecord(record, ctx.root);
const state = {
  machine: { intervalMs: 300000, runtimeTimeoutMs: 1000, workspaceTimeoutMs: 1000 },
  startedAt: Date.now() - 7 * 3600000,
  records: [{ record, state: { kind: "ended", exit: { at, code: 1, signal: null }, process: null }, result: null }],
  root: ctx.root,
};
const report = { actions: [], launches: [] };
await applyDrives(state, { slug: ctx.slug }, report, {}, {});
return { waits: report.launches.map(r => r.detail.includes("timer allows")), consumed: readRecord(record.id, ctx.root)?.rearmConsumed === true };
`),
  ).toEqual({ waits: [true], consumed: false });
});
