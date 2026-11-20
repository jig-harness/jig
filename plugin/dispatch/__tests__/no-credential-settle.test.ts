/**
 * settleNoCredential: the incident names, and the line keeps the previous
 * tracker part of, only the repositories whose readings the missing
 * credential cut; a repository read before it was lost keeps its reading.
 */
import { afterEach, expect, test } from "bun:test";
import {
  forgetMissingCredentials,
  noteMissingCredential,
} from "../../shared/outbound/missing-credential.ts";
import { keylessRepos, settleNoCredential } from "../lib/no-credential.ts";
import type { RepoReport } from "../lib/types.ts";
import type { TickReceipt } from "../receipts.ts";

afterEach(forgetMissingCredentials);

function report(slug: string, cut: boolean): RepoReport {
  return {
    path: `/w/${slug}`,
    slug,
    records: [
      {
        record: "tracker",
        source: "linear ENG",
        ok: !cut,
        detail: "",
        ...(cut ? { failure: { noCredential: true } } : {}),
      },
    ],
    unplaced: [],
  } as unknown as RepoReport;
}

test("a credential still missing names only the repositories whose readings it cut", () => {
  noteMissingCredential("linear:settle-test", {
    system: "linear",
    reason: "no Linear key configured",
    remedy: "set LINEAR_API_KEY",
  });
  const receipt = {
    repos: [report("org/a", false), report("org/b", true)],
  } as unknown as TickReceipt;
  settleNoCredential(receipt);
  expect(receipt.noCredential?.[0]?.repos).toEqual(["org/b"]);
  expect(receipt.noCredential?.[0]?.kept).toEqual(["org/b"]);
});

test("a credential missing with no reading cut names every tracked repository and keeps none", () => {
  noteMissingCredential("linear:settle-test", {
    system: "linear",
    reason: "no Linear key configured",
    remedy: "set LINEAR_API_KEY",
  });
  const receipt = {
    repos: [report("org/a", false), report("org/b", false)],
  } as unknown as TickReceipt;
  settleNoCredential(receipt);
  expect(receipt.noCredential?.[0]?.repos).toEqual(["org/a", "org/b"]);
  expect(receipt.noCredential?.[0]?.kept).toEqual([]);
  expect(keylessRepos(receipt).get("linear")).toEqual(new Set());
});
