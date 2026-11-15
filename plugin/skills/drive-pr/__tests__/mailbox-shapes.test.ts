import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matches } from "../../../shared/shapes.ts";
import {
  MAILBOX_MESSAGE_SHAPE,
  MAILBOX_OUTBOX_SHAPE,
} from "../scripts/lib/state/mailbox-shapes.ts";
import {
  appendDirective,
  appendNote,
  parseInboxMessage,
  parseOutboxRecord,
} from "../scripts/lib/state/mailbox.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
const base = {
  id: "m1",
  ts: "2026-01-01T00:00:00.000Z",
  from: "person",
  pr: "12",
};

test("the mailbox writer's note and directive shapes read through the shared description", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jig-mailbox-shapes-"));
  dirs.push(dir);
  const messages = [
    await appendNote(dir, "12", "person", "context"),
    await appendDirective(dir, "12", "person", "hold-push"),
    await appendDirective(dir, "12", "person", "pause", { body: "why" }),
    await appendDirective(dir, "12", "person", "stop"),
    await appendDirective(dir, "12", "person", "stop", { generation: 2 }),
    await appendDirective(dir, "12", "person", "stop", {
      generation: 2,
      now: true,
    }),
    await appendDirective(dir, "12", "person", "resume", { target: "stop" }),
  ];
  for (const message of messages) {
    const json: unknown = JSON.parse(JSON.stringify(message));
    expect(matches(MAILBOX_MESSAGE_SHAPE, json)).toBe(true);
    expect(parseInboxMessage(json)).toEqual(message);
  }
});

test("a shared directive description refuses impossible command fields", () => {
  const malformed = [
    { command: "resume" },
    { command: "resume", target: "resume" },
    { command: "pause", target: "stop" },
    { command: "pause", generation: 2 },
    { command: "stop", now: true },
    { command: "stop", generation: 0 },
    { command: "stop", generation: Number.MAX_SAFE_INTEGER + 1 },
    { command: "stop", generation: 1, now: false },
    { command: "unknown" },
  ];
  for (const fields of malformed) {
    const message = { ...base, kind: "directive", ...fields };
    expect(matches(MAILBOX_MESSAGE_SHAPE, message)).toBe(false);
    expect(parseInboxMessage(message)).toBeNull();
  }
});

test("outbox descriptions keep completed answers and driver acknowledgements distinct", () => {
  const good = [
    { ...base, status: "received" },
    { ...base, status: "done", response: "answer" },
    { ...base, status: "ack", generation: 1 },
  ];
  const bad = [
    { ...base, status: "received", response: "answer" },
    { ...base, status: "done" },
    { ...base, status: "done", response: "" },
    { ...base, status: "ack" },
    { ...base, status: "ack", generation: 1, response: "answer" },
  ];
  for (const line of good) {
    expect(matches(MAILBOX_OUTBOX_SHAPE, line)).toBe(true);
    expect(parseOutboxRecord(line)).not.toBeNull();
  }
  for (const line of bad) {
    expect(matches(MAILBOX_OUTBOX_SHAPE, line)).toBe(false);
    expect(parseOutboxRecord(line)).toBeNull();
  }
});
