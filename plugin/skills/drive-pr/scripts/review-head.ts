#!/usr/bin/env bun
/** Current-head reviewer evidence for the standalone review loop. */
import { runMain } from "../../../shared/cli.ts";
import { reviewerExpected } from "./lib/overlay.ts";
import { ghCall } from "./lib/proc.ts";
import {
  checkRunsFor,
  reviewerRun,
  reviewerStickyMarkers,
} from "./lib/status/evidence.ts";
import { resolveMarkerSha } from "./lib/status/reviewed-sha.ts";

// 0 witnessed; 4 waiting for this head; 1 unreadable; 2 invalid invocation.
async function main(): Promise<number> {
  const [pr = "", head = ""] = process.argv.slice(2);
  if (!/^\d+$/.test(pr) || !/^[0-9a-f]{40}$/.test(head)) return 2;
  if (!reviewerExpected()) return 0;
  const repo = await ghCall([
    "repo",
    "view",
    "--json",
    "owner,name",
    "-q",
    '.owner.login + "/" + .name',
  ]);
  if (repo.code !== 0) return 1;
  const [owner, name] = repo.stdout.trim().split("/");
  if (!owner || !name) return 1;
  const [runs, sticky] = await Promise.all([
    checkRunsFor(owner, name, head),
    reviewerStickyMarkers(owner, name, pr),
  ]);
  if (runs === null || sticky === null) return 1;
  const run = reviewerRun(runs);
  if (run?.status !== "completed" || run.conclusion !== "success") return 4;
  if (sticky.sha === "" || (await resolveMarkerSha(sticky.sha)) !== head) {
    console.error(`reviewer has not recorded reviewing current head ${head}`);
    return 4;
  }
  return 0;
}

if (import.meta.main) runMain("review-head", main);
