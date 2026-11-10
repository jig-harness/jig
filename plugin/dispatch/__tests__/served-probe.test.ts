import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { failed, ok } from "../../shared/outcome.ts";
import { probe, type ProbeForge } from "../lib/change-probe.ts";
import { readMachineConfig } from "../lib/machine-config.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});
it("wakes served pickups on an issue update and remembers it on the next unchanged probe", async () => {
  const dir = mkdtempSync(join(tmpdir(), "served-probe-"));
  dirs.push(dir);
  const file = join(dir, "dispatch.yaml");
  writeFileSync(
    file,
    JSON.stringify({
      serve: [
        { name: "person", forge: ["person"], tracker: { github: "person" } },
      ],
      repositories: [{ path: "/tmp/repo", stages: ["pickup"] }],
    }),
  );
  const config = readMachineConfig(file);
  expect(config.ok).toBe(true);
  if (!config.ok || config.value === null) return;
  const machine = config.value;
  const clock = { at: Date.parse("2026-11-09T12:00:00Z"), now: () => clock.at };
  const updatedAt = new Date(clock.at).toISOString();
  const calls: string[][] = [];
  let down = false;
  const forge: ProbeForge = {
    slug: async () => ok("acme/web"),
    search: async () =>
      ok({
        changed: [],
        open: [],
        unseen: [],
        calls: 1,
        cost: 1,
        remaining: 4999,
      }),
    issues: async (slugs, since) => {
      calls.push([...slugs, since]);
      if (down) return failed("unreadable", "issue listing unavailable");
      return ok({
        changed: [{ slug: "acme/web", number: 7, updatedAt }],
        calls: 1,
      });
    },
  };
  const wakes: string[] = [];
  const run = () =>
    probe(machine, true, {
      dir: join(dir, "state"),
      clock,
      forge,
      wake: async (path) => {
        wakes.push(path);
        return ok("woke");
      },
    });
  const first = await run();
  expect(first.ok && first.value.changes[0]?.what).toEqual([
    `#7 updated ${updatedAt}`,
  ]);
  expect(wakes).toEqual(["/tmp/repo"]);
  expect(calls).toHaveLength(1);
  clock.at += 60_000;
  const second = await run();
  expect(second.ok && second.value.changes).toEqual([]);
  expect(wakes).toHaveLength(1);
  down = true;
  const failure = await run();
  expect(failure.ok).toBe(false);
  expect(wakes).toHaveLength(1);
  const before = calls.length;
  await probe({ ...machine, serve: [] }, false, {
    dir: join(dir, "state"),
    clock,
    forge,
    wake: async () => ok("unused"),
  });
  await probe(
    {
      ...machine,
      repositories: machine.repositories.map((r) => ({
        ...r,
        stages: ["rearm"],
      })),
    },
    false,
    { dir: join(dir, "state"), clock, forge, wake: async () => ok("unused") },
  );
  expect(calls).toHaveLength(before);
});

it("drops pull requests from the issue endpoint and refuses partial or malformed answers", async () => {
  const { readIssuePages } = await import("../lib/change-probe-issues.ts");
  const at = "2026-11-09T12:00:00Z";
  const read = readIssuePages(
    JSON.stringify([
      [
        { number: 7, updated_at: at },
        { number: 8, pull_request: {} },
      ],
      [{ number: 9, updated_at: at }],
    ]),
    "acme/web",
  );
  expect(read.ok && read.value).toEqual({
    calls: 2,
    changed: [
      { slug: "acme/web", number: 7, updatedAt: at },
      { slug: "acme/web", number: 9, updatedAt: at },
    ],
  });
  for (const answer of [
    "not json",
    "{}",
    '[{"number":7}]',
    '[[{"number":7,"updated_at":"tomorrow"}]]',
    '[[{"number":-7,"updated_at":"2026-11-09T12:00:00Z"}]]',
  ])
    expect(readIssuePages(answer, "acme/web").ok).toBe(false);
});
