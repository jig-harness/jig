#!/usr/bin/env bun
/**
 * Propose epic closures without tracker writes, or apply one recorded reply to
 * an earlier proposal after rechecking the closure prerequisites.
 */

import { consumerRoot, remoteName } from "../../../shared/consumer.ts";
import { git, type RunResult } from "../../../shared/proc.ts";
import { baseBranch } from "../../drive-pr/scripts/lib/overlay.ts";
import { classifyChildState } from "./get_issue.ts";
import { failingAsError, parseArgs, runEntry } from "./lib/cli.ts";
import {
  acceptedRows,
  assessEpic,
  containsEntry,
  createProposal,
  EpicSweepError,
  readScopes,
  verifyApprovedScope,
  type ReadEntry,
  type ScopeAssessment,
} from "./lib/epic-sweep-plan.ts";
import {
  listSweepEpics,
  prepareSweepTracker,
  readSweepEpic,
  readSweepReply,
  validateSweepRemainder,
} from "./lib/epic-sweep-tracker.ts";
import { epicChildDisposition } from "./reconcile_parent_status.ts";
import { ownTrackerConfig } from "./lib/tracker/config.ts";
import { openTracker } from "./lib/tracker/index.ts";
import { issueKeysOf } from "./lib/tracker/keys.ts";
import { statesForType } from "./lib/tracker/jira/state-maps.ts";

const USAGE =
  "Usage: epic-sweep.ts --propose --input <file> | --accept --input <file> --proposal <file> --reply <comment-url>";

function checkedGit(result: RunResult, purpose: string): string {
  if (result.code !== 0) {
    throw new EpicSweepError(
      `${purpose} (git exit ${result.code}): ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result.stdout;
}

async function committedEntries(
  root: string,
  scopes: ScopeAssessment[],
): Promise<ReadEntry> {
  const paths = new Set(
    scopes.flatMap(({ plan, roadmap }) =>
      [plan, roadmap].flatMap((entry) => (entry ? [entry.path] : [])),
    ),
  );
  const documents = new Map<string, string>();
  if (paths.size) {
    const remote = remoteName(root);
    const branch = await baseBranch(root);
    if (!branch)
      throw new EpicSweepError(
        "Cannot identify the repository's integration branch",
      );
    const ref = `refs/heads/${branch}`;
    const tracking = `refs/remotes/${remote}/${branch}`;
    const options = { cwd: root, timeoutSec: 60 };
    checkedGit(
      await git(["check-ref-format", ref], options),
      `Invalid integration ref ${ref}`,
    );
    checkedGit(
      await git(
        ["fetch", "--no-tags", "--", remote, `${ref}:${tracking}`],
        options,
      ),
      `Cannot refresh ${remote}/${branch}`,
    );
    const commit = checkedGit(
      await git(["rev-parse", "--verify", `${tracking}^{commit}`], options),
      `Cannot read ${tracking}`,
    ).trim();
    for (const path of paths) {
      const exists = await git(
        ["cat-file", "-e", `${commit}:${path}`],
        options,
      );
      if (exists.code === 1) continue;
      checkedGit(
        exists,
        `Cannot establish whether ${path} exists on ${remote}/${branch}`,
      );
      const contents = checkedGit(
        await git(["show", `${commit}:${path}`], options),
        `Cannot read ${path} on ${remote}/${branch}`,
      );
      documents.set(path, contents);
    }
  }
  return async ({ path, heading }) => {
    const document = documents.get(path);
    // A path confirmed absent at the fetched integration commit is an absent
    // entry, not an unreadable document. `cat-file` above separates that
    // result from failures to establish the path's state.
    if (document === undefined) return false;
    return containsEntry(document, heading);
  };
}

async function readJson(path: string): Promise<unknown> {
  return Bun.file(path).json();
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2), {
    flags: ["propose", "accept"],
    values: ["input", "proposal", "reply"],
    noPositional: true,
    usage: USAGE,
  });
  if (!parsed.ok) {
    console.error(parsed.message);
    return 2;
  }
  const { flags, values } = parsed.args;
  const input = values.get("input");
  const proposal = values.get("proposal");
  const replyUrl = values.get("reply");
  const propose = flags.has("propose");
  if (
    !input ||
    flags.size !== 1 ||
    (propose ? Boolean(proposal || replyUrl) : !proposal || !replyUrl)
  ) {
    console.error(USAGE);
    return 2;
  }

  return failingAsError(false, async () => {
    const scopes = readScopes(await readJson(input));
    const config = ownTrackerConfig();
    const root = consumerRoot();
    const tracker = openTracker(config, root);
    const vocabulary = {
      labels: config.labels,
      states: config.states,
      statesByType: config.adapter === "jira" ? config.jira.statesByType : {},
    };

    if (propose) {
      const readEntry = await committedEntries(root, [...scopes.values()]);
      const keys = await listSweepEpics(tracker, config.labels.epic);
      const rows = [];
      const personChecks =
        config.personChecks &&
        issueKeysOf(config)?.normalize(config.personChecks);
      for (const key of keys) {
        const { epic, children } = await readSweepEpic(tracker, key);
        if (personChecks === epic.identifier) continue;
        if (
          classifyChildState(
            epic.state,
            statesForType(vocabulary.states, vocabulary, epic.nativeType),
          ) !== "incomplete"
        )
          continue;
        rows.push(
          await assessEpic(
            epic,
            children,
            scopes.get(key),
            readEntry,
            vocabulary,
          ),
        );
      }
      console.log(JSON.stringify(createProposal(rows), null, 2));
      return 0;
    }

    if (!proposal || !replyUrl) return 2;
    const reply = await readSweepReply(tracker, replyUrl);
    const approved = acceptedRows(
      await readJson(proposal),
      reply.body,
      reply.precedingBodies,
    );
    const assessments = approved.map(({ epic }) => {
      const scope = scopes.get(epic);
      if (!scope)
        throw new EpicSweepError(`Missing scope assessment for ${epic}`);
      return scope;
    });
    const readEntry = await committedEntries(root, assessments);
    const pending = [];
    const alreadyClosed = [];
    for (const row of approved) {
      const { epic, children } = await readSweepEpic(tracker, row.epic);
      const state = classifyChildState(
        epic.state,
        statesForType(vocabulary.states, vocabulary, epic.nativeType),
      );
      if (state === "completed") {
        alreadyClosed.push(epic.identifier);
        continue;
      }
      if (state === "abandoned")
        throw new EpicSweepError(
          `${epic.identifier} was abandoned since the proposal`,
        );
      const scope = scopes.get(row.epic);
      const fresh = await assessEpic(
        epic,
        children,
        scope,
        readEntry,
        vocabulary,
      );
      verifyApprovedScope(row, fresh);
      const remainder = (scope?.remainder ?? []).map(({ title, issue }) => {
        if (!issue)
          throw new EpicSweepError(
            `${row.epic} still needs a linked backlog issue for "${title}"`,
          );
        return { title, issue };
      });
      await validateSweepRemainder(tracker, epic, remainder);
      const apply = await prepareSweepTracker(tracker, {
        epic,
        ...(config.personChecks === undefined
          ? {}
          : { personChecks: config.personChecks }),
        personTails: row.personTails,
        ordinaryTails: row.ordinaryTails,
        operatorSteps: fresh.operatorSteps,
        replyUrl,
        classifyTail(child) {
          const kind = epicChildDisposition(child, vocabulary);
          if (kind === "person-check") return "person";
          if (kind === "extractable-tail") return "ordinary";
          return null;
        },
      });
      pending.push({ epic: epic.identifier, apply });
    }

    const closed = [];
    for (const { epic, apply } of pending) {
      await apply();
      closed.push(epic);
    }
    console.log(JSON.stringify({ closed, alreadyClosed }, null, 2));
    return 0;
  });
}

if (import.meta.main) runEntry(main);
