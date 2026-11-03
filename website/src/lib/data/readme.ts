/**
 * The parts of the README the home page lays out: the problem it opens
 * with, its factory section and its list of ways to use Jig.
 */
import { leadOf, listItems, paragraphs, section, sections } from "../source.ts";

export interface ReadmeOpening {
  /** The problem the README opens with, one sentence per entry, in order. */
  problem: string[];
  /** The bold line after the problem: what Jig is, in one line, Markdown. */
  tagline: string;
}

export interface ReadmeFactory {
  /** The line and what keeps it moving: the paragraphs before the jobs. */
  line: string[];
  /** The sentence that opens the scaffolding's jobs. */
  jobsLead: string;
  jobs: { lead: string; body: string }[];
}

/** The README lost a part the home page lays out. */
class ReadmeShapeError extends Error {}

const oneLine = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .join(" ")
    .trim();

/** A paragraph's sentences: a break after `.`, `!` or `?` before a capital. */
const sentencesOf = (text: string) =>
  oneLine(text).split(/(?<=[.!?])\s+(?=["“A-Z])/);

/**
 * The opening: the first paragraph under the title that is not the logo,
 * which states the problem, then the bold tagline. A README that opens on
 * its tagline, or puts anything between the problem and the tagline, fails
 * the build here rather than giving the home page a hero without a problem.
 */
function opening(preamble: string): ReadmeOpening {
  const paras = paragraphs(preamble)
    .map(oneLine)
    .filter((p) => !/^!\[[^\]]*\]\([^)]*\)$/.test(p));
  const [problem = "", tagline = ""] = paras;
  if (!problem || problem.startsWith("**"))
    throw new ReadmeShapeError(
      "README.md: the first paragraph under the title must state the problem, before the bold tagline",
    );
  if (!/^\*\*[^*]+\*\*$/.test(tagline))
    throw new ReadmeShapeError(
      "README.md: the paragraph after the problem must be the bold tagline",
    );
  return { problem: sentencesOf(problem), tagline };
}

/** The factory section: the line's paragraphs, then the jobs and the sentence opening them. */
function factory(fx: string): ReadmeFactory {
  const listAt = fx.search(/^[-*] /m);
  const before = listAt < 0 ? [] : paragraphs(fx.slice(0, listAt)).map(oneLine);
  const jobsLead = before.at(-1) ?? "";
  const line = before.slice(0, -1);
  if (line.length === 0 || !jobsLead.endsWith(":"))
    throw new ReadmeShapeError(
      'README.md: "Jig as a software factory" must tell the line, then open the scaffolding\'s jobs with a sentence ending in ":" and list them',
    );
  return {
    line,
    jobsLead,
    jobs: listItems(fx).map((i) => ({
      lead: leadOf(i.text),
      body: i.body.replace(/^\*\*[^*]+\*\*:\s*/, ""),
    })),
  };
}

export function parseReadme(readme: string): {
  opening: ReadmeOpening;
  factory: ReadmeFactory;
  ways: { n: number; lead: string; body: string }[];
} {
  const parts = sections(readme);
  return {
    opening: opening(parts[0]?.body ?? ""),
    factory: factory(section(parts, "Jig as a software factory")),
    ways: listItems(section(parts, "Ways to use")).map((i) => ({
      n: i.n,
      lead: leadOf(i.text),
      body: i.body,
    })),
  };
}
