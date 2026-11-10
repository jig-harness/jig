/**
 * Source validation primitives of the sheet kit. A sheet genre
 * validates its own source with a `Checker`: every problem is collected with
 * its JSON path, so one run reports all of them.
 *
 * Validation is strict on purpose. An unknown key is an error, not a field to
 * ignore: a typo would otherwise drop a claim from every projection without a
 * trace.
 */

import {
  ANY_KEY_SOURCE,
  shapeOfKey,
} from "../../../do-item/scripts/lib/tracker/keys.ts";
import { REPOSITORY_NAME, repositoryProblems } from "./freshness.ts";

import {
  Checker as CoreChecker,
  COMMIT,
} from "../../../../shared/decisions/source.ts";
export {
  DATE,
  COMMIT,
  SIMPLE_ID,
  type Json,
  type SourcedClaim,
} from "../../../../shared/decisions/source.ts";

/** An issue key of any tracker (`ENG-123`, `#123`): a sheet is validated without the tracker's configuration. */
export const ISSUE_ID = new RegExp(`^${ANY_KEY_SOURCE}$`);
/** An issue key as a file or directory name (`IssueKeys.toFileStem`): `ENG-123`, `issue-123`. */
export const issueFileStem = (id: string): string =>
  shapeOfKey(id)?.toFileStem(id) ?? id;
/** The portable checker with sheet repository verification. */
export class Checker extends CoreChecker {
  /**
   * `{ date, commit, repositories? }`: the day the facts were checked, the
   * commit they were checked at, and for each other repository a citation
   * names (`other:ADR-0002`) the commit its facts were checked at.
   */
  verifiedAt(value: unknown, path: string): void {
    if (!this.object(value, path, ["date", "commit"], ["repositories"])) return;
    this.date(value.date, `${path}.date`);
    this.pattern(
      value.commit,
      COMMIT,
      `${path}.commit`,
      "a lowercase git commit hash",
    );
    if (Object.hasOwn(value, "repositories"))
      this.recordedRepositories(value.repositories, `${path}.repositories`);
  }

  /** Repository name to the commit its facts were checked at. */
  private recordedRepositories(value: unknown, path: string): void {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.keys(value).length === 0
    ) {
      this.fail(path, "must be an object of repository name to commit");
      return;
    }
    for (const [name, commit] of Object.entries(value)) {
      if (!REPOSITORY_NAME.test(name))
        this.fail(
          `${path}.${name}`,
          "repository names are lowercase letters, digits, - and _, starting with a letter",
        );
      this.pattern(
        commit,
        COMMIT,
        `${path}.${name}`,
        "a lowercase git commit hash",
      );
    }
  }

  /**
   * Every repository a citation qualifies has a commit in
   * `verifiedAt.repositories`: without one the citation could not be checked.
   */
  qualifiedCitations(citations: readonly string[], verifiedAt: unknown): void {
    const recorded =
      typeof verifiedAt === "object" && verifiedAt !== null
        ? (verifiedAt as { repositories?: unknown }).repositories
        : undefined;
    const commits =
      typeof recorded === "object" &&
      recorded !== null &&
      !Array.isArray(recorded)
        ? (recorded as Record<string, string>)
        : undefined;
    for (const problem of repositoryProblems(citations, commits))
      this.fail("$.verifiedAt.repositories", problem);
  }
}
