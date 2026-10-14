/**
 * Small pieces of presentation shared by several pages: what a module's
 * scaffolding jobs are called, where it sits in the factory, a skill's
 * command, an ordinal.
 */
import { jobsByModule } from "./data/factory.ts";
import { factory } from "./data/index.ts";

export interface JobTag {
  label: string;
  href: string;
  note: string;
}

const JOB_NOTE: Record<string, string> = {
  context: "what an agent knows when a session starts and while it works",
  guide: "a guide: steers an agent before it acts",
  catch: "a catch: stops what still slips through",
  knowledge: "decisions, facts and lessons kept explicit and versioned",
};

/** The verification tag: guide, catch, or both, with their notes. */
function verificationTag(jobs: string[]): JobTag | null {
  const sides = ["guide", "catch"].filter((j) => jobs.includes(j));
  if (!sides.length) return null;
  return {
    label: `verification · ${sides.join(" + ")}`,
    href: "/factory/#job-verification",
    note: sides.map((j) => JOB_NOTE[j]).join("; "),
  };
}

/** A module's jobs in the scaffolding, in their fixed order. */
export function jobTags(moduleId: string): JobTag[] {
  const jobs = jobsByModule(factory()).get(moduleId) ?? [];
  const tag = (job: string): JobTag | null =>
    jobs.includes(job)
      ? { label: job, href: `/factory/#job-${job}`, note: JOB_NOTE[job] ?? "" }
      : null;
  const many: JobTag | null = jobs.includes("many")
    ? {
        label: "many agents at once",
        href: "/factory/#scaffolding-many",
        note:
          moduleId === "M12"
            ? "workspaces that do not collide"
            : "measurement of the process itself",
      }
    : null;
  return [tag("context"), verificationTag(jobs), tag("knowledge"), many].filter(
    (t): t is JobTag => t !== null,
  );
}

/** Where a module shows up among the factory's stations, if it does. */
export function factoryPlace(
  moduleId: string,
): { label: string; href: string } | null {
  const f = factory();
  if (f.levels[0]?.modules.includes(moduleId))
    return { label: "Factory · design and planning", href: "/factory/#design" };
  if (f.levels[1]?.modules.includes(moduleId))
    return { label: "Factory · execution", href: "/factory/#execution" };
  if (moduleId === "M8")
    return { label: "Factory · the learning loop", href: "/factory/#learning" };
  if (f.platform.some((p) => p.modules.includes(moduleId)))
    return {
      label: "Factory · asks the platform for",
      href: "/factory/#platform",
    };
  return null;
}

/** How a skill or agent is invoked. */
export function commandOf(name: string): { prefix: string; name: string } {
  return { prefix: name === "review-arbiter" ? "jig:" : "/jig:", name };
}

export function ordinal(n: number): string {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teen ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${suffix}`;
}

/** A level's place in the order: Lite 1, Standard 2, Strict 3. */
export function levelRank(level: string): number {
  return level === "strict"
    ? 3
    : level === "standard"
      ? 2
      : level === "lite"
        ? 1
        : 0;
}

/** The anchor GitHub gives a heading, so links written for the repository land. */
export function headingId(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*[\]()]/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .trim()
    .replace(/\s/g, "-");
}

const NUMBER_WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
];

/** A count as prose writes it: `3` -> `three`, `Three` with `capital`. */
export function countWord(n: number, capital = false): string {
  const word = NUMBER_WORDS[n] ?? String(n);
  return capital ? word.charAt(0).toUpperCase() + word.slice(1) : word;
}
