/**
 * The chapter list of the Jig Protocol (tools/protocol/README.md § The chapter template):
 * for each chapter its file, version, status, the plan items that still move
 * it with their epic issues, and its generated sections. The generator
 * (`generate.ts`) writes each chapter's status line, its generated sections,
 * the index page's list and its data file from this list.
 *
 * A provisional chapter names each plan item that still moves it, with the
 * item's epic issue: `{ item: 39, epic: 485 }`. The pull request that
 * finishes the last of them removes them here and marks the chapter stable.
 * A stable chapter that is removed is listed in `WITHDRAWN` at a version
 * above its last, with a change note marked breaking.
 */
import type { Chapter, Withdrawn } from "./chapter.ts";
import { ADDRESSES } from "./chapters/addresses.ts";
import { COMMENT_MARKERS } from "./chapters/comment-markers.ts";
import { DRIVE_EXITS } from "./chapters/drive-exits.ts";
import { FOLLOWUP_CLAIM_CHAPTER } from "./chapters/followup-claim.ts";
import { FORGE_CLAIMS_CHAPTER } from "./chapters/forge-claims.ts";
import { MAILBOX } from "./chapters/mailbox.ts";
import { NEEDS_AND_ANSWERS } from "./chapters/needs-and-answers.ts";
import { PR_LABELS } from "./chapters/pr-labels.ts";
import { REPO_COMMANDS_CHAPTER } from "./chapters/repo-commands.ts";
import { RULE_MATCHERS_CHAPTER } from "./chapters/rule-matchers.ts";
import { STEWARD_RECORDS_CHAPTER } from "./chapters/steward-records.ts";
import { TRACKER_FACETS } from "./chapters/tracker-facets.ts";

export const CHAPTERS: readonly Chapter[] = [
  DRIVE_EXITS,
  MAILBOX,
  PR_LABELS,
  COMMENT_MARKERS,
  REPO_COMMANDS_CHAPTER,
  FOLLOWUP_CLAIM_CHAPTER,
  RULE_MATCHERS_CHAPTER,
  ADDRESSES,
  FORGE_CLAIMS_CHAPTER,
  TRACKER_FACETS,
  NEEDS_AND_ANSWERS,
  STEWARD_RECORDS_CHAPTER,
];

export const WITHDRAWN: readonly Withdrawn[] = [];
