import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expectSpawnExit } from "../../../lib/test-helpers/expect-spawn-exit.ts";
import { scriptArgv } from "../../../lib/test-helpers/script-argv.ts";
import type { ParkedDecision } from "../../shared/decisions/park.ts";
import { parkNotice } from "../../dispatch/lib/notices.ts";
import type { DrivenPr } from "../../dispatch/lib/types.ts";
import { ledgerBody } from "../../skills/drive-pr/__tests__/ledger-forge-fixtures.ts";
import type { AskAnswer } from "../lib/answer.ts";
import { readParkThread } from "../lib/park-reading.ts";
import { reading, PAST_DEADLINE } from "../lib/reading.ts";
import type { AskContext } from "../lib/station.ts";
import {
  type SendWorld,
  sendWorld,
  parkedLedger,
  pullRequest,
  comment,
  REPO,
  PARK_KEY,
} from "../../send/__tests__/send-fixtures.ts";

let w: SendWorld | undefined;
afterEach(() => {
  w?.close();
  w = undefined;
});
const decision: ParkedDecision = {
  schema: "parked-decision/v1",
  class: "scope",
  call: {
    id: "a",
    question: "Keep the flag?",
    recommended: "a",
    why: "It keeps compatibility",
    options: [
      {
        id: "a",
        name: "Keep",
        summary: "Retain the flag",
        pay: ["Support both"],
      },
      {
        id: "b",
        name: "Remove",
        summary: "Delete the flag",
        pay: ["Break old clients"],
      },
    ],
  },
  steps: [],
  alreadyDone: "Read the clients",
};
function setup(answers: unknown[] = []): SendWorld {
  w = sendWorld();
  const ledger = parkedLedger(12);
  const item = ledger.parked[0];
  if (item === undefined) throw new Error("missing fixture park");
  item.class = "scope";
  item.decision = decision;
  pullRequest(w, 12, [], [comment(701, ledgerBody(ledger)), ...answers]);
  return w;
}
function reply(world: SendWorld, body: string): void {
  writeFileSync(
    join(world.dir, `thread-${PARK_KEY}.json`),
    JSON.stringify({
      data: {
        node: {
          comments: {
            pageInfo: { hasNextPage: false },
            nodes: [
              {
                body,
                createdAt: "2026-11-02T10:00:00Z",
                lastEditedAt: null,
                url: "https://example.test/thread-reply",
                author: { login: "maintainer" },
                authorAssociation: "MEMBER",
              },
            ],
          },
        },
      },
    }),
  );
}
async function ask(world: SendWorld): Promise<AskAnswer> {
  const r = await world.ask([`drive@${REPO}#12`, "--json", "--thread"]);
  expectSpawnExit(r, 0);
  return JSON.parse(r.stdout) as AskAnswer;
}

describe("structured answers in station readers", () => {
  it("ask and send both read an approval on a parked review thread", async () => {
    const world = setup();
    reply(world, "approve");
    const answer = await ask(world);
    expect(answer.waitsOn).toMatchObject({ person: "re-arm" });
    expect(answer.sources.records).toContainEqual({
      record: `park-answer-thread:${PARK_KEY}`,
      read: true,
    });
    expect(
      answer.thread?.some(
        (e) =>
          e.kind === "answer" &&
          /structured/.test(e.text) &&
          /Keep/.test(e.text),
      ),
    ).toBe(true);
    const sent = await world.send([
      `drive@${REPO}#12`,
      "answer",
      PARK_KEY,
      "keep it",
      "--dry-run",
    ]);
    expectSpawnExit(sent, 0);
    expect(sent.stdout).toContain("earlier    your answer");
    expect(sent.stdout).toContain("chose Keep (recommended)");
    expect(sent.stdout).toContain("this one replaces it");
    expect(world.writes()).toEqual([]);
  });
  it("labels an unknown choice free and leaves a conflicting structured/free pair disputed", async () => {
    const world = setup([
      comment(
        702,
        `answer ${PARK_KEY}: choose nowhere`,
        "maintainer",
        "MEMBER",
        "2026-11-02T10:00:00Z",
      ),
    ]);
    const free = await ask(world);
    expect(
      free.thread?.some((e) => e.kind === "answer" && /free/.test(e.text)),
    ).toBe(true);
    reply(world, "approve");
    const file = join(world.dir, `thread-${PARK_KEY}.json`);
    // A second person's approval cannot settle the first person's free answer.
    writeFileSync(
      file,
      JSON.stringify({
        data: {
          node: {
            comments: {
              pageInfo: { hasNextPage: false },
              nodes: [
                {
                  body: "approve",
                  createdAt: "2026-11-02T11:00:00Z",
                  author: { login: "owner" },
                  authorAssociation: "OWNER",
                  url: "https://example.test/owner",
                },
              ],
            },
          },
        },
      }),
    );
    const disputed = await ask(world);
    expect(disputed.waitsOn).toMatchObject({ person: "answer" });
    expect(disputed.thread?.some((e) => /disputed/.test(e.text))).toBe(true);
  });
  it("shows an answer edited after the re-arm read its retained verdict", async () => {
    const world = setup();
    const ledger = parkedLedger(12);
    ledger.parked = [];
    const edited = comment(
      702,
      `answer ${PARK_KEY}: choose Remove`,
      "maintainer",
      "MEMBER",
      "2026-11-02T10:00:00Z",
    );
    edited.updated_at = "2026-11-03T10:00:00Z";
    pullRequest(world, 12, [], [comment(701, ledgerBody(ledger)), edited]);
    const state = join(
      world.home,
      ".local",
      "state",
      "jig",
      "drive-pr",
      ledger.driver.clone,
    );
    mkdirSync(state, { recursive: true });
    writeFileSync(
      join(state, "drive-pr-12.answers.json"),
      JSON.stringify([
        {
          kind: "thread",
          key: PARK_KEY,
          reason: "Keep?",
          decision,
          answers: [
            {
              author: "maintainer",
              at: "2026-11-02T10:00:00Z",
              url: edited.html_url,
              body: `answer ${PARK_KEY}: approve`,
              bodyHash: "earlier-body-hash",
              choice: { option: "Keep", recommended: true, form: "approve" },
            },
          ],
        },
      ]),
    );
    const answer = await ask(world);
    expect(
      answer.thread?.some((e) => /edited since it was read/.test(e.text)),
    ).toBe(true);
  });
  it("reports an unread source thread while preserving its retained approval", async () => {
    const world = setup();
    const ledger = parkedLedger(12);
    ledger.parked = [];
    pullRequest(world, 12, [], [comment(701, ledgerBody(ledger))]);
    writeFileSync(
      join(world.dir, `thread-${PARK_KEY}.json`),
      JSON.stringify({ data: { node: null } }),
    );
    const state = join(
      world.home,
      ".local",
      "state",
      "jig",
      "drive-pr",
      ledger.driver.clone,
    );
    mkdirSync(state, { recursive: true });
    writeFileSync(
      join(state, "drive-pr-12.answers.json"),
      JSON.stringify([
        {
          kind: "thread",
          key: PARK_KEY,
          reason: "Keep?",
          decision,
          answers: [
            {
              author: "maintainer",
              at: "2026-11-02T10:00:00Z",
              url: "https://example.test/unread-thread-reply",
              body: "approve",
              bodyHash: "retained-body-hash",
              choice: { option: "Keep", recommended: true, form: "approve" },
            },
          ],
        },
      ]),
    );
    const answer = await ask(world);
    expect(
      answer.thread?.some(
        (e) => e.kind === "answer" && e.text.includes("chose Keep"),
      ),
    ).toBe(true);
    expect(
      answer.thread?.some((e) => e.text.includes("edited since it was read")),
    ).toBe(false);
    expect(answer.sources.records).toContainEqual({
      record: `park-answer-thread:${PARK_KEY}`,
      read: false,
      detail: "the thread comments did not read",
    });
  });

  it("records a source thread skipped after the answer deadline", async () => {
    const reads = reading(0, () => 0);
    expect(
      await readParkThread({ reading: reads } as AskContext, PARK_KEY),
    ).toBeNull();
    expect(reads.sources()).toMatchObject({
      forgeCalls: 0,
      records: [
        {
          record: `park-answer-thread:${PARK_KEY}`,
          read: false,
          detail: PAST_DEADLINE,
        },
      ],
    });
  });

  it("discards a retained verdict while its key is parked again", async () => {
    const world = setup([comment(702, `answer ${PARK_KEY}: choose Remove`)]);
    const state = join(
      world.home,
      ".local",
      "state",
      "jig",
      "drive-pr",
      "clone-a",
    );
    mkdirSync(state, { recursive: true });
    writeFileSync(
      join(state, "drive-pr-12.answers.json"),
      JSON.stringify([
        {
          kind: "thread",
          key: PARK_KEY,
          reason: "Keep?",
          decision,
          answers: [
            {
              author: "maintainer",
              at: "2026-11-01T09:30:00Z",
              url: "https://example.test/earlier",
              body: "approve",
              bodyHash: "earlier-body-hash",
              choice: { option: "Keep", recommended: true, form: "approve" },
            },
          ],
        },
      ]),
    );
    const answer = await ask(world);
    const answers = answer.thread?.filter((e) => e.kind === "answer");
    expect(answers).toHaveLength(1);
    expect(answers?.[0]?.text).toContain("chose Remove");
  });
  it("shows a note without counting it as an answer", async () => {
    const world = setup([
      comment(702, `note ${PARK_KEY}: only after the migration`),
    ]);
    const answer = await ask(world);
    expect(answer.waitsOn).toMatchObject({ person: "answer" });
    expect(answer.stateDetail).toContain("note with no answer");
    expect(
      answer.thread?.some((e) =>
        /note with no answer: only after the migration/.test(e.text),
      ),
    ).toBe(true);
  });
  it("the re-arm, tick and ask agree on every item of one mixed pull request", async () => {
    const world = setup();
    reply(world, "approve");
    const ledger = parkedLedger(12);
    const original = ledger.parked[0];
    if (original === undefined) throw new Error("missing park");
    original.decision = decision;
    original.class = "scope";
    ledger.parked.push(
      ...["free", "disputed", "waiting"].map((key) => ({
        ...original,
        key,
        kind: "finding" as const,
      })),
    );
    const comments = [
      comment(701, ledgerBody(ledger)),
      comment(702, "answer free: choose nowhere"),
      comment(703, "answer disputed: approve", "owner", "OWNER"),
      comment(704, "answer disputed: wait", "maintainer", "MEMBER"),
    ];
    pullRequest(world, 12, [], comments);
    const script = join(world.root, "compare-readers.ts");
    const rearm = resolve(
      import.meta.dir,
      "../../skills/drive-pr/scripts/lib/driver/rearm.ts",
    );
    const dispatch = resolve(
      import.meta.dir,
      "../../dispatch/lib/sources/ledgers.ts",
    );
    writeFileSync(
      script,
      `#!/usr/bin/env bun
import { parkAnswers } from ${JSON.stringify(rearm)};
import { readDrives } from ${JSON.stringify(dispatch)};
const comments = ${JSON.stringify(comments)};
const ledger = ${JSON.stringify(ledger)};
const rearm = await parkAnswers(12, ledger.parked, ${JSON.stringify(REPO)}, comments);
const tick = await readDrives(${JSON.stringify(REPO)}, "maintainer", [{number:12,title:"Change",url:"u",headRefName:"work",headRefOid:"a".repeat(40),mergeable:"MERGEABLE"}], Date.now(), null, null, async () => ({ok:true,value:comments}));
console.log(JSON.stringify({ rearm, tick }));
`,
    );
    chmodSync(script, 0o755);
    const child = Bun.spawn(scriptArgv(script), {
      cwd: world.repo,
      env: world.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const deadline = setTimeout(() => child.kill(), 60_000);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    clearTimeout(deadline);
    expectSpawnExit({ stdout, stderr, exitCode }, 0);
    const compared = JSON.parse(stdout) as {
      rearm: { answered: { key: string }[]; waiting: { key: string }[] };
      tick: DrivenPr[];
    };
    expect(compared.rearm.answered.map((p) => p.key).sort()).toEqual(
      [PARK_KEY, "free"].sort(),
    );
    expect(compared.rearm.waiting.map((p) => p.key).sort()).toEqual([
      "disputed",
      "waiting",
    ]);
    expect(compared.tick[0]?.waiting?.map((p) => p.key).sort()).toEqual([
      "disputed",
      "waiting",
    ]);
    const answer = await ask(world);
    expect(answer.stateDetail).toContain(
      `${PARK_KEY}: structured answer choosing Keep`,
    );
    expect(answer.stateDetail).toContain("free: free answer");
    expect(answer.stateDetail).toContain("disputed: disputed answers");
    expect(answer.waitsOn).toMatchObject({
      person: "answer",
      why: expect.stringContaining("finding waiting"),
    });
  });
});

it("notifies a dispute immediately and gives edits a new notice identity", () => {
  const pr = {
    number: 12,
    title: "Change",
    url: "https://example.test/pull/12",
    evidence: { generation: 2 },
    waiting: [
      {
        key: PARK_KEY,
        kind: "thread",
        lines: ["Keep the flag?"],
        disputed: [
          {
            author: "owner",
            at: "2026-11-02T10:00:00Z",
            url: "u",
            body: "approve",
            bodyHash: "aaa",
          },
          {
            author: "maintainer",
            at: "2026-11-02T11:00:00Z",
            url: "v",
            body: "wait",
            bodyHash: "bbb",
          },
        ],
      },
    ],
  } as unknown as DrivenPr;
  const first = parkNotice(REPO, pr);
  expect(first.text).toContain("Disputed");
  expect(first.text).toContain("@maintainer");
  const park = pr.waiting?.[0] as { disputed: { bodyHash: string }[] };
  const answer = park.disputed[1];
  if (answer === undefined) throw new Error("missing answer");
  answer.bodyHash = "ccc";
  expect(parkNotice(REPO, pr).key).not.toBe(first.key);
});
