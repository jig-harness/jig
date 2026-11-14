/**
 * The chapter list of the Jig Protocol (design/protocol.md § The chapters):
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
import { DRIVE_EXITS } from "./chapters/drive-exits.ts";

export const CHAPTERS: readonly Chapter[] = [DRIVE_EXITS];

export const WITHDRAWN: readonly Withdrawn[] = [];
