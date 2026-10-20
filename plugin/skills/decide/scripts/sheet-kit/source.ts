/**
 * Source validation primitives of the sheet kit. A sheet genre
 * validates its own source with a `Checker`: every problem is collected with
 * its JSON path, so one run reports all of them.
 *
 * Validation is strict on purpose. An unknown key is an error, not a field to
 * ignore: a typo would otherwise drop a claim from every projection without a
 * trace.
 */

import { REPOSITORY_NAME, repositoryProblems } from "./freshness.ts";

/** A claim with the place it was verified: `path#symbol`, `path:line`, an issue or an ADR. */
export interface SourcedClaim {
  text: string;
  source: string;
}

export type Json = Record<string, unknown>;

export const ISSUE_ID = /^[A-Z][A-Z0-9]*-\d+$/;
export const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const COMMIT = /^[0-9a-f]{7,40}$/;
export const SIMPLE_ID = /^[A-Za-z0-9]{1,8}$/;

export class Checker {
  readonly problems: string[] = [];

  fail(path: string, message: string): void {
    this.problems.push(`${path}: ${message}`);
  }

  object(
    value: unknown,
    path: string,
    required: string[],
    optional: string[],
  ): value is Json {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      this.fail(path, "must be an object");
      return false;
    }
    const allowed = new Set([...required, ...optional]);
    for (const key of Object.keys(value))
      if (!allowed.has(key)) this.fail(`${path}.${key}`, "unknown field");
    for (const key of required)
      if (!Object.hasOwn(value, key))
        this.fail(`${path}.${key}`, "is required");
    return true;
  }

  /** A real calendar day, not merely the YYYY-MM-DD shape. */
  date(value: unknown, path: string): void {
    if (!this.text(value, path)) return;
    const parsed = new Date(`${value}T00:00:00Z`);
    if (
      !DATE.test(value) ||
      Number.isNaN(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== value
    )
      this.fail(path, "must be a real YYYY-MM-DD date");
  }

  /**
   * An https URL that survives as a markdown link target: no whitespace, no
   * parentheses, no backslash (URL parsing reads it as `/`, Markdown as an
   * escape, so the HTML and Markdown renderings would point at different places).
   */
  url(value: unknown, path: string): void {
    if (!this.text(value, path)) return;
    let ok = /^https:\/\/[^\s()<>\\]+$/.test(value);
    try {
      new URL(value);
    } catch {
      ok = false;
    }
    if (!ok)
      this.fail(
        path,
        "must be an https URL with no spaces, parentheses or backslashes",
      );
  }

  text(value: unknown, path: string): value is string {
    if (typeof value !== "string" || value.trim() === "") {
      this.fail(path, "must be a non-empty string");
      return false;
    }
    return true;
  }

  optionalText(obj: Json, key: string, path: string): void {
    if (key in obj) this.text(obj[key], `${path}.${key}`);
  }

  pattern(value: unknown, re: RegExp, path: string, what: string): void {
    if (this.text(value, path) && !re.test(value))
      this.fail(path, `must be ${what}`);
  }

  array(value: unknown, path: string, min: number): value is unknown[] {
    if (!Array.isArray(value)) {
      this.fail(path, "must be an array");
      return false;
    }
    if (value.length < min) this.fail(path, `needs at least ${min} item(s)`);
    return true;
  }

  texts(value: unknown, path: string, min: number): void {
    if (!this.array(value, path, min)) return;
    value.forEach((v, i) => {
      this.text(v, `${path}[${i}]`);
    });
  }

  claims(value: unknown, path: string, min: number): void {
    if (!this.array(value, path, min)) return;
    value.forEach((v, i) => {
      const p = `${path}[${i}]`;
      if (this.object(v, p, ["text", "source"], [])) {
        this.text(v.text, `${p}.text`);
        this.text(v.source, `${p}.source`);
      }
    });
  }

  uniqueIds(items: unknown[], path: string): string[] {
    const ids: string[] = [];
    items.forEach((item, i) => {
      const id = (item as Json | null)?.id;
      if (typeof id === "string" && SIMPLE_ID.test(id)) ids.push(id);
      else this.fail(`${path}[${i}].id`, "must be 1-8 letters or digits");
    });
    if (new Set(ids).size !== ids.length) this.fail(path, "has a duplicate id");
    return ids;
  }

  keyedBy(
    value: unknown,
    path: string,
    keys: string[],
    each: (v: unknown, p: string) => void,
  ): void {
    if (!this.object(value, path, keys, [])) return;
    for (const key of keys)
      if (Object.hasOwn(value, key)) each(value[key], `${path}.${key}`);
  }

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

  /** Terms with their meaning. */
  glossary(value: unknown, path: string): void {
    if (!this.array(value, path, 1)) return;
    value.forEach((g, i) => {
      const p = `${path}[${i}]`;
      if (this.object(g, p, ["term", "meaning"], [])) {
        this.text(g.term, `${p}.term`);
        this.text(g.meaning, `${p}.meaning`);
      }
    });
  }
}
