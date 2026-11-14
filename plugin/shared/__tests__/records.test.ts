/**
 * The records layer's first step: one envelope every record carries, one
 * codec for a file and a hidden marker on the forge, a registry of every
 * kind, and the two records that carry the envelope first (the drive ledger
 * and the follow-up marker) still reading the forms written before it.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import {
  FOLLOWUP_KIND,
  FOLLOWUP_VERSION,
  markerRun,
} from "../../dispatch/lib/followup-marker.ts";
import { SCHEMA_VERSION } from "../../dispatch/lib/state.ts";
import {
  LEDGER_KIND,
  LEDGER_VERSION,
  type Ledger,
  parseLedger,
  renderLedger,
} from "../../skills/drive-pr/scripts/lib/state/ledger.ts";
import {
  commentSafe,
  decode,
  decodeMarker,
  type Envelope,
  encode,
  encodeMarker,
  readEnvelope,
} from "../records/envelope.ts";
import {
  ADMISSION_KIND,
  GUARD_VERSION,
  HEARTBEAT_KIND,
  LAUNCH_KIND,
} from "../orca-guard.ts";
import { NOT_RECORDS, RECORD_KINDS, recordKind } from "../records/registry.ts";
import { digest, localWriter, readWriter } from "../records/writer.ts";

const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const AT = "2026-11-04T09:30:00.000Z";

function envelope(over: Partial<Envelope> = {}): Envelope {
  return {
    kind: "dispatch-followup",
    v: 1,
    key: "12",
    writer: { login: "dispatch-bot", host: digest("host-a"), pid: 4242 },
    at: AT,
    ...over,
  };
}

describe("the envelope codec", () => {
  it("round-trips a record through a file on disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "records-"));
    temporary.push(dir);
    const file = join(dir, "record.json");
    const payload = { run: "tick", record: "20261104T093000Z-aaaaaaaa" };
    writeFileSync(file, encode(envelope({ generation: 3 }), payload));
    const read = decode(readFileSync(file, "utf8"), "dispatch-followup");
    expect(read).toEqual({
      ok: true,
      value: { envelope: envelope({ generation: 3 }), payload },
    });
  });

  it("round-trips the same bytes inside a hidden marker", () => {
    const payload = { run: "manual", outcome: "done" };
    const body = `<!-- jig-dispatch-followup -->\n${encodeMarker("jig-dispatch-followup-data", envelope(), payload)}\nvisible line`;
    expect(body.split("\n")[1]).toBe("<!-- jig-dispatch-followup-data");
    expect(body.split("\n")[2]).toBe(encode(envelope(), payload));
    expect(
      decodeMarker(body.replaceAll("\n", "\r\n"), "jig-dispatch-followup-data"),
    ).toEqual({ ok: true, value: { envelope: envelope(), payload } });
  });

  it("escapes every < and > so a payload cannot close the comment", () => {
    const payload = { run: "manual", outcome: "--> <!-- <script>" };
    const text = encode(envelope(), payload);
    expect(text).not.toContain("<");
    expect(text).not.toContain(">");
    expect(text).toContain("\\u003c");
    expect(commentSafe('{"a":"<>"}')).toBe('{"a":"\\u003c\\u003e"}');
    const body = encodeMarker(
      "jig-dispatch-followup-data",
      envelope(),
      payload,
    );
    expect(body.indexOf("-->")).toBe(body.length - 3);
    const read = decodeMarker(body, "jig-dispatch-followup-data");
    expect(read.ok && read.value.payload).toEqual(payload);
  });

  it("refuses a version newer than the registry's, naming both", () => {
    const text = encode(envelope(), { run: "tick" }).replace('"v":1', '"v":3');
    const read = decode(text);
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.failure.code).toBe("newer-version");
    expect(read.failure.reason).toContain("version 3 is newer than 2");
  });

  it("refuses an envelope outside the strict form, as a value", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ ...envelope(), kind: "no-such-kind" }, "unregistered-kind"],
      [{ ...envelope(), v: 1.5 }, "bad-version"],
      [{ ...envelope(), v: "1" }, "bad-version"],
      [{ ...envelope(), key: "12; rm -rf /" }, "bad-key"],
      [{ ...envelope(), writer: { login: "x" } }, "bad-writer"],
      [{ ...envelope(), at: "yesterday" }, "bad-time"],
      [{ ...envelope(), at: "2026-02-30T00:00:00Z" }, "bad-time"],
      [{ ...envelope(), at: "2026-04-31T00:00:00Z" }, "bad-time"],
      [{ ...envelope(), at: "2025-02-29T00:00:00Z" }, "bad-time"],
      [{ ...envelope(), at: "2026-11-12T24:00:00Z" }, "bad-time"],
      [{ ...envelope(), at: "2026-11-12T10:60:00Z" }, "bad-time"],
      [{ ...envelope(), at: "2026-11-12T10:00:00+24:00" }, "bad-time"],
      [{ ...envelope(), at: "2026-11-04T09:30:00.1234567890Z" }, "bad-time"],
      [{ ...envelope(), generation: -1 }, "bad-generation"],
      [{ ledgerVersion: 1 }, "no-envelope"],
    ];
    for (const [value, code] of cases) {
      const read = readEnvelope(value);
      expect(read.ok ? "ok" : read.failure.code).toBe(code);
    }
    expect(decode("{not json").ok ? "ok" : "failed").toBe("failed");
    const other = readEnvelope(envelope(), "drive-ledger");
    expect(other.ok ? "ok" : other.failure.code).toBe("unexpected-kind");
    const plain = readEnvelope({ ...envelope(), kind: "dispatch-receipt" });
    expect(plain.ok ? "ok" : plain.failure.code).toBe("unenveloped-kind");
  });

  it("reads and writes times in a browser without Temporal", async () => {
    const script = `
      delete globalThis.Temporal;
      const { encode, readEnvelope } = await import(${JSON.stringify(
        join(import.meta.dir, "../records/envelope.ts"),
      )});
      const e = { kind: "dispatch-followup", v: 1, key: "12",
        writer: { login: "x", host: "sha256:0123456789abcdef", pid: 1 },
        at: "2024-02-29T10:00:00.000+01:00" };
      if (!readEnvelope(e).ok) throw new Error("refused a valid time");
      if (readEnvelope({ ...e, at: "2026-02-30T00:00:00Z" }).ok)
        throw new Error("accepted February 30");
      encode(e, {});
    `;
    const child = Bun.spawnSync(["bun", "-e", script], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expectSpawnExit(child, 0, "envelope without Temporal");
  });

  it("rejects impossible dates and key terminators in both readers and writers", () => {
    for (const at of [
      "2026-02-29T00:00:00Z",
      "2024-04-31T10:00:00+02:00",
      "2026-01-01T24:00:00Z",
      `${AT}\n`,
    ]) {
      expect(readEnvelope(envelope({ at })).ok).toBe(false);
      expect(() => encode(envelope({ at }), {})).toThrow(/strict form/);
    }
    for (const kind of ["drive-ledger", "dispatch-followup"]) {
      for (const ending of ["\n", "\r", "\u2028", "\u2029"]) {
        const value = envelope({ kind, key: `12${ending}` });
        expect(readEnvelope(value).ok).toBe(false);
        expect(() => encode(value, {})).toThrow(/strict form/);
      }
    }
    for (const at of [
      "2024-02-29T23:59:59Z",
      "2026-02-28T23:59:59.123456+02:30",
      "2000-02-29T00:00:00-05:00",
    ]) {
      expect(readEnvelope(envelope({ at })).ok).toBe(true);
    }
  });

  it("keeps a writer from writing what a reader refuses", () => {
    expect(() => encode(envelope({ key: "PR 12" }), {})).toThrow(/strict form/);
    expect(() => encode(envelope(), { kind: "smuggled" })).toThrow(
      /envelope's field kind/,
    );
    expect(() => encodeMarker("Not A Name", envelope(), {})).toThrow(
      /not a marker name/,
    );
  });

  it("reads a payload as data: an instruction-shaped field is carried, never acted on", () => {
    const payload = { run: "tick", record: "$(touch /tmp/x)" };
    const read = decode(encode(envelope(), payload));
    expect(read.ok && read.value.payload).toEqual(payload);
  });
});

describe("the writer", () => {
  it("names the host and boot as digests on the forge and as they are on the machine", () => {
    const local = localWriter("machine", "someone");
    const pub = localWriter("forge", "someone");
    expect(local.login).toBe("someone");
    expect(pub.host).toBe(digest(local.host));
    expect(pub.host).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(pub.pid).toBe(process.pid);
    expect(localWriter("tracker").login).toBeUndefined();
  });

  it("drops the fields this version does not know and refuses a malformed one", () => {
    expect(readWriter({ host: "h", newer: 1 })).toEqual({ host: "h" });
    expect(readWriter({ host: "h", pid: 0 })).toBeNull();
    expect(readWriter({ host: "" })).toBeNull();
  });
});

describe("the registry", () => {
  it("names each kind once, with a medium, an owner and a version", () => {
    const names = RECORD_KINDS.map((k) => k.name);
    expect(new Set(names).size).toBe(names.length);
    for (const kind of RECORD_KINDS) {
      expect(kind.name).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(["machine", "tree", "forge", "tracker"]).toContain(kind.medium);
      expect(kind.owner).not.toBe("");
      expect(Number.isInteger(kind.version) && kind.version >= 0).toBe(true);
      expect(recordKind(kind.name)).toBe(kind);
    }
  });

  it("gives every kind that carries the envelope an anchored key shape and a version", () => {
    const enveloped = RECORD_KINDS.filter((k) => k.key !== undefined);
    expect(enveloped.map((k) => k.name).sort()).toEqual([
      "dispatch-followup",
      "dispatch-launch-claim",
      "drive-answer",
      "drive-ledger",
      "drive-merge-ready",
      "drive-takeover-claim",
      "orca-guard-admission",
      "orca-guard-heartbeat",
      "orca-guard-launch",
      "tracker-claim-marker",
    ]);
    for (const kind of enveloped) {
      expect(kind.key?.source.startsWith("^")).toBe(true);
      expect(kind.key?.source.endsWith("$")).toBe(true);
      expect(kind.key?.flags).toBe("");
      expect(kind.version).toBeGreaterThan(0);
    }
  });

  it("claims each marker, family and table once", () => {
    const claimed = [
      ...RECORD_KINDS.flatMap((k) => [
        ...(k.markers ?? []).map((m) => `marker ${m}`),
        ...(k.stateFamily === undefined ? [] : [`family ${k.stateFamily}`]),
        ...(k.table === undefined ? [] : [`table ${k.table}`]),
      ]),
      ...NOT_RECORDS.map((r) => `marker ${r.marker}`),
    ];
    expect(new Set(claimed).size).toBe(claimed.length);
    expect(recordKind("no-such-kind")).toBeUndefined();
  });

  it("states the versions the code writes", () => {
    const stopped = ledger();
    stopped.driver.personStop = { at: AT, reason: "maintenance" };
    const rendered = renderLedger(stopped);
    expect("body" in rendered).toBe(true);
    if ("body" in rendered)
      expect(dataOf(rendered.body)).toMatchObject({
        v: recordKind(LEDGER_KIND)?.version,
      });
    expect(recordKind(LEDGER_KIND)?.version ?? 0).toBeGreaterThanOrEqual(
      LEDGER_VERSION,
    );
    expect(recordKind(FOLLOWUP_KIND)?.version).toBe(FOLLOWUP_VERSION);
    for (const kind of [ADMISSION_KIND, LAUNCH_KIND, HEARTBEAT_KIND])
      expect(recordKind(kind)?.version).toBe(GUARD_VERSION);
    const tables = RECORD_KINDS.filter(
      (k) => k.table !== undefined && k.at.includes("/dispatch/"),
    );
    expect(tables.length).toBeGreaterThan(0);
    for (const kind of tables) expect(kind.version).toBe(SCHEMA_VERSION);
  });
});

function ledger(over: Partial<Ledger> = {}): Ledger {
  return {
    ledgerVersion: 1,
    generation: 4,
    pr: 12,
    round: 2,
    attempts: 1,
    attemptsHead: "abc1234",
    deadlineRetries: 0,
    phase: "awaiting-bots",
    lastCountedHead: "abc1234",
    verifiedSha: "",
    readyMarkedRound: 0,
    parked: [],
    held: [],
    quotaPark: null,
    takeovers: [],
    claims: [],
    decisions: [],
    events: [],
    rulings: [],
    driver: {
      actor: "wt-0123456789abcdef",
      clone: "0123456789abcdef",
      heartbeat: AT,
      state: "running",
    },
    narrative: ["round 2: waiting on the reviewers"],
    cut: [],
    ...over,
  };
}

/** The JSON a ledger's data block holds. */
function dataOf(body: string): Record<string, unknown> {
  const start = body.indexOf("<!-- drive-pr-ledger-data\n");
  const json = body.slice(start).split("\n")[1] ?? "";
  return JSON.parse(json) as Record<string, unknown>;
}

describe("the drive ledger carries the envelope", () => {
  it("writes the envelope beside ledgerVersion, and reads it back", () => {
    const rendered = renderLedger(ledger(), undefined, {
      login: "drive-bot",
      host: digest("host-a"),
    });
    if ("error" in rendered) throw new Error(rendered.error);
    const data = dataOf(rendered.body);
    expect(data).toMatchObject({
      kind: "drive-ledger",
      v: 1,
      key: "12",
      writer: { login: "drive-bot", host: digest("host-a") },
      at: AT,
      generation: 4,
      ledgerVersion: 1,
      pr: 12,
    });
    expect(parseLedger(rendered.body)).toEqual({
      kind: "ledger",
      ledger: ledger(),
    });
  });

  it("still reads a ledger written before the envelope: ledgerVersion 1, no kind", () => {
    const rendered = renderLedger(ledger());
    if ("error" in rendered) throw new Error(rendered.error);
    const legacy = rendered.body.replace(/^\{.*\}$/m, JSON.stringify(ledger()));
    expect(dataOf(legacy).kind).toBeUndefined();
    expect(parseLedger(legacy)).toEqual({ kind: "ledger", ledger: ledger() });
  });

  it("reads a newer envelope version as a ledger it does not read, and a foreign key as damage", () => {
    const rendered = renderLedger(ledger());
    if ("error" in rendered) throw new Error(rendered.error);
    expect(parseLedger(rendered.body.replace('"v":1', '"v":3'))).toEqual({
      kind: "unknown-version",
      version: 3,
    });
    expect(parseLedger(rendered.body.replace('"v":1', '"v":2'))?.kind).toBe(
      "malformed",
    );
    const moved = parseLedger(
      rendered.body.replace('"key":"12"', '"key":"13"'),
    );
    expect(moved?.kind).toBe("malformed");
  });
});

describe("the follow-up marker carries the envelope", () => {
  const post = { pr: 9, writer: { host: digest("host-a") }, at: AT };
  const id = "20261104T093000Z-aaaaaaaa";

  it("writes its record from the second line and reads it back", async () => {
    const { manualMarker, tickMarker } = await import(
      "../../dispatch/lib/followup-marker.ts"
    );
    const tick = tickMarker(id, post);
    expect(tick.split("\n")[1]).toBe("<!-- jig-dispatch-followup-data");
    expect(tick.split("\n").at(-1)).toBe(
      `jig dispatch follow-up · record: ${id}`,
    );
    expect(markerRun(tick, 9)).toEqual({ kind: "tick", record: id });
    expect(markerRun(manualMarker(true, post), 9)).toEqual({
      kind: "manual",
      done: true,
    });
    expect(markerRun(tick, 10)).toEqual({
      kind: "unreadable",
      reason: "its record names pull request #9",
    });
  });

  it("still reads the line form written before the envelope", () => {
    const marker = "<!-- jig-dispatch-followup -->";
    expect(
      markerRun(`${marker}\njig dispatch follow-up · record: ${id}`, 9),
    ).toEqual({ kind: "tick", record: id });
    expect(
      markerRun(
        `${marker}\njig dispatch follow-up · run: manual · outcome: running`,
        9,
      ),
    ).toEqual({ kind: "manual", done: false });
    expect(markerRun(`${marker}\nsomething else`, 9).kind).toBe("unreadable");
  });
});
