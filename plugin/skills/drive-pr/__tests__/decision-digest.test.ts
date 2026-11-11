import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  answerPublicationLag,
  publicationLedgerDiagnostic,
} from "../scripts/lib/driver/answer-publication.ts";
import {
  readPendingVerdicts,
  writePendingVerdicts,
} from "../scripts/lib/state/pass-handoff.ts";
import { parkNotice } from "../../../dispatch/lib/notices.ts";
import type { DrivenPr } from "../../../dispatch/lib/types.ts";
import { readPark } from "../../../dispatch/lib/sources/park-reading.ts";
import { stoppedLedger } from "../../../dispatch/__tests__/fixtures.ts";
import { decisionOf } from "../../../dispatch/lib/line-decision.ts";
import { decisionDigest } from "../../../shared/decisions/digest.ts";
import type { ParkedDecision } from "../../../shared/decisions/park.ts";
import { parseAnswerComment } from "../scripts/lib/answer-forms.ts";
import { parkAnswers } from "../scripts/lib/driver/park-answers.ts";
import {
  framedDecisionLines,
  isParkedItem,
  type ParkedItem,
} from "../scripts/lib/state/park-frame.ts";
import { redactStrings } from "../../../shared/redact.ts";

const decision: ParkedDecision = {
  schema: "parked-decision/v1",
  class: "scope",
  call: {
    id: "a",
    question: "Keep it?",
    recommended: "keep",
    why: "It still serves readers",
    options: [
      {
        id: "keep",
        name: "Keep",
        summary: "Notify alice@example.test",
        pay: ["Carry it"],
      },
      { id: "drop", name: "Remove", summary: "Delete it", pay: ["Lose it"] },
    ],
  },
  steps: [],
  alreadyDone: "Read the code",
};
const item: ParkedItem = {
  key: "K",
  kind: "finding",
  reason: "Keep it?",
  round: 1,
  at: "2026-11-10T10:00:00Z",
  decision,
  digest: "123456abcdef",
};
const comment = (body: string, at = "2026-11-10T11:00:00Z") => ({
  body,
  author: "alice",
  association: "OWNER",
  at,
  url: "https://example.test/answer",
});
const listing = (body: string, at?: string) => {
  const c = comment(body, at);
  return {
    body,
    user: { login: c.author },
    author_association: c.association,
    created_at: c.at,
    html_url: c.url,
  };
};

test("canonical digest ignores object key order, preserves arrays and hashes the stored private decision", () => {
  expect(decisionDigest({ ...decision, call: { ...decision.call } })).toBe(
    decisionDigest({
      alreadyDone: decision.alreadyDone,
      steps: [],
      call: decision.call,
      class: decision.class,
      schema: decision.schema,
    }),
  );
  expect(decisionDigest(decision)).toMatch(/^[a-f0-9]{12}$/);
  expect(decisionDigest(decision)).not.toBe(
    decisionDigest(redactStrings(decision)),
  );
  expect(decisionDigest({ ...decision, steps: ["a", "b"] })).not.toBe(
    decisionDigest({ ...decision, steps: ["b", "a"] }),
  );
  expect(decisionDigest({ ...decision, steps: [] })).not.toBe(
    createHash("sha256").update("{}").digest("hex").slice(0, 12),
  );
});

test("matching suffix selects an option and survives redaction without rehashing", () => {
  for (const park of [item, redactStrings(item)]) {
    const answer = parseAnswerComment(
      park,
      comment("answer K: approve [123456abcdef]"),
      "conversation",
    );
    expect(answer?.choice).toMatchObject({
      option: "Keep",
      digest: item.digest,
    });
    expect(answer?.stale).toBeUndefined();
  }
  expect(framedDecisionLines(item).join("\n")).toContain(
    "answer K: approve [123456abcdef]",
  );
  expect(isParkedItem({ ...item, digest: "bad" })).toBe(false);
});

test("digest is checked before obsolete names or mixed prose can become free answers", async () => {
  for (const body of [
    "answer K: approve [aaaaaaaaaaaa]",
    "answer K: **approve [aaaaaaaaaaaa]**",
    "answer K: `approve [aaaaaaaaaaaa]`",
    "answer K: ａｐｐｒｏｖｅ ［ａａａａａａａａａａａａ］",
    "answer K: choose Removed option [aaaaaaaaaaaa]",
    "answer K: approve [aaaaaaaaaaaa] Thanks",
    "answer K: choose Removed option [aaaaaaaaaaaa] Thanks",
    "answer K: approve [aaaaaaaaaaaa] [123456abcdef]",
    "answer K: approve [aaaaaaaaaaaa]\nThanks",
    "answer K: approve [aaaaaaaaaaaa], thanks",
    "answer K: approve [aaaaaaaaaaaa]. Thanks",
  ]) {
    const answer = parseAnswerComment(item, comment(body), "conversation");
    expect(answer?.stale).toBe(true);
    const read = await parkAnswers(12, [item], "example/repo", [listing(body)]);
    if ("unreadable" in read) throw new Error("fixture unreadable");
    expect(read.answered).toEqual([]);
    expect(read.waiting).toEqual([item]);
    expect(read.responded).toEqual([item]);
    expect(read.stale[0]?.answers[0]?.digest).toBe("aaaaaaaaaaaa");
  }
});

test("a framing suffix preserves option text and rejects extra identity claims", () => {
  const keep = decision.call.options[0];
  const remove = decision.call.options[1];
  if (keep === undefined || remove === undefined)
    throw new Error("missing decision option");
  const withDigestName = {
    ...item,
    decision: {
      ...decision,
      call: {
        ...decision.call,
        options: [{ ...keep, name: "Keep [aaaaaaaaaaaa]" }, remove],
      },
    },
  };
  expect(
    parseAnswerComment(
      withDigestName,
      comment("answer K: choose Keep [aaaaaaaaaaaa] [123456abcdef]"),
      "conversation",
    )?.choice,
  ).toMatchObject({ option: "Keep [aaaaaaaaaaaa]", digest: item.digest });
  expect(
    parseAnswerComment(
      item,
      comment("answer K: approve [123456abcdef] [aaaaaaaaaaaa]"),
      "conversation",
    )?.stale,
  ).toBe(true);
  const withOverlappingDigestNames = {
    ...withDigestName,
    decision: {
      ...withDigestName.decision,
      call: {
        ...withDigestName.decision.call,
        options: [keep, ...withDigestName.decision.call.options],
      },
    },
  };
  const withNormalizedOverlappingDigestNames = {
    ...withOverlappingDigestNames,
    decision: {
      ...withOverlappingDigestNames.decision,
      call: {
        ...withOverlappingDigestNames.decision.call,
        options: [
          { ...keep, name: "********Keep********" },
          ...withOverlappingDigestNames.decision.call.options.slice(1),
        ],
      },
    },
  };
  for (const park of [
    withDigestName,
    withOverlappingDigestNames,
    withNormalizedOverlappingDigestNames,
  ]) {
    const answer = parseAnswerComment(
      park,
      comment("answer K: choose Keep [aaaaaaaaaaaa] [123456abcdef] Thanks"),
      "conversation",
    );
    expect(answer).not.toBeNull();
    expect(answer?.stale).toBeUndefined();
    expect(answer?.choice).toBeUndefined();
  }
  expect(
    parseAnswerComment(
      item,
      comment(
        "answer K: approve [123456abcdef] only after backup verification",
      ),
      "conversation",
    )?.choice,
  ).toBeUndefined();
});

test("latest correction supersedes stale and retained verdict names its framing", async () => {
  const read = await parkAnswers(12, [item], "example/repo", [
    listing("answer K: approve [aaaaaaaaaaaa]"),
    listing("answer K: choose Remove [123456abcdef]", "2026-11-10T12:00:00Z"),
  ]);
  if ("unreadable" in read) throw new Error("fixture unreadable");
  expect(read.stale).toEqual([]);
  expect(read.answered[0]).toMatchObject({
    digest: item.digest,
    answers: [{ choice: { option: "Remove", digest: item.digest } }],
  });
});

test("parks without digests and digest-free answers retain time binding", () => {
  const { digest: _digest, ...old } = item;
  expect(
    parseAnswerComment(
      old,
      comment("answer K: approve [aaaaaaaaaaaa]"),
      "conversation",
    )?.stale,
  ).toBeUndefined();
  expect(
    parseAnswerComment(item, comment("answer K: approve"), "conversation")
      ?.choice?.option,
  ).toBe("Keep");
  expect(
    parseAnswerComment(
      item,
      comment("answer K: approve [123456abcdef]", "2026-11-10T09:00:00Z"),
      "conversation",
    ),
  ).toBeNull();
});

test("local and published framing disagreement blocks either matching bound answer", () => {
  const a = parseAnswerComment(
    item,
    comment("answer K: approve [123456abcdef]"),
    "conversation",
  );
  const b = parseAnswerComment(
    item,
    comment("answer K: approve [aaaaaaaaaaaa]"),
    "conversation",
  );
  if (a === null || b === null) throw new Error("missing fixture answers");
  const published = [{ ...item, digest: "aaaaaaaaaaaa" }];
  expect(answerPublicationLag(item, [a], published)).toBe(true);
  expect(answerPublicationLag(item, [b], published)).toBe(true);
  expect(answerPublicationLag(item, [a], [item])).toBe(false);
  const { digest: _answerDigest, ...unbound } = a;
  expect(answerPublicationLag(item, [unbound], published)).toBe(false);
  const { digest: _digest, ...old } = item;
  expect(answerPublicationLag(old, [a], published)).toBe(false);
});

test("published-ledger diagnostics distinguish absent, damaged, and unsupported ledgers", () => {
  const snapshot = (overrides: Record<string, unknown>) =>
    ({
      canonical: null,
      duplicates: [],
      malformed: [],
      untrusted: [],
      claims: [],
      maxGeneration: 0,
      ...overrides,
    }) as Parameters<typeof publicationLedgerDiagnostic>[0];
  expect(publicationLedgerDiagnostic(snapshot({}))).toBe(
    "no trusted published ledger exists",
  );
  expect(publicationLedgerDiagnostic(snapshot({ malformed: [{}] }))).toBe(
    "the published ledger has 1 damaged comment(s)",
  );
  expect(
    publicationLedgerDiagnostic(
      snapshot({
        canonical: { parsed: { kind: "unknown-version", version: 7 } },
      }),
    ),
  ).toBe("the published ledger uses unsupported ledgerVersion 7");
});

test("a copied notification line settles its framing and a reframe sends a new stale notice", async () => {
  const ledger = stoppedLedger(12, 8, { parked: [item] });
  const initial = await readPark(12, ledger, "example/repo", []);
  if (initial === undefined || "unreadable" in initial)
    throw new Error("fixture park unreadable");
  const pr = {
    number: 12,
    title: "Change",
    url: "https://example.test/pull/12",
    evidence: { generation: 1 },
    waiting: initial.parks,
  } as unknown as DrivenPr;
  const offered = parkNotice("example/repo", pr);
  expect(decisionOf({ ...item, lines: framedDecisionLines(item) }).digest).toBe(
    item.digest,
  );
  const copied = offered.text
    .split("\n")
    .find((l) => l === "answer K: approve [123456abcdef]");
  expect(copied).toBeDefined();
  const settled = await readPark(12, ledger, "example/repo", [
    listing(copied as string),
  ]);
  expect(settled).toMatchObject({ answered: 1, waiting: [] });
  ledger.parked = [
    {
      ...item,
      digest: "bbbbbbbbbbbb",
      decision: { ...decision, alreadyDone: "Read the changed code" },
    },
  ];
  const reframed = await readPark(12, ledger, "example/repo", [
    listing(copied as string),
  ]);
  if (reframed === undefined || "unreadable" in reframed)
    throw new Error("fixture park unreadable");
  expect(reframed.answered).toBe(0);
  const next = parkNotice("example/repo", {
    ...pr,
    waiting: reframed.parks ?? [],
  });
  expect(next.key).not.toBe(offered.key);
  expect(next.text).toContain("Stale answers name an earlier decision framing");
  expect(next.text).toContain("answer K: approve [bbbbbbbbbbbb]");
});

test("retained answers preserve park and choice digests across a process handoff", async () => {
  const read = await parkAnswers(12, [item], "example/repo", [
    listing("answer K: approve [123456abcdef]"),
  ]);
  if ("unreadable" in read) throw new Error("fixture unreadable");
  const dir = mkdtempSync(join(tmpdir(), "decision-handoff-"));
  try {
    writePendingVerdicts(dir, "12", read.answered);
    expect(readPendingVerdicts(dir, "12")).toEqual(read.answered);
    expect(readPendingVerdicts(dir, "12")?.[0]).toMatchObject({
      digest: item.digest,
      answers: [{ digest: item.digest, choice: { digest: item.digest } }],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
