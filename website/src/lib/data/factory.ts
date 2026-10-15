/**
 * FACTORY.md in the parts the factory page and figures lay out: the
 * scaffolding's three jobs and the modules that build each, what Jig
 * provides, the two levels, their stations and who runs each station, what
 * stays with a person and what Jig leaves to the platform.
 */
import {
  firstParagraph,
  leadOf,
  listItems,
  moduleIds,
  paragraphs,
  section,
  sections,
  tableRows,
  withoutTitle,
} from "../source.ts";

/** Who runs a station: a skill, the arbiter agent, a tool, a person, or nothing yet. */
export type Actor =
  | { kind: "skill" | "agent"; name: string; note?: string }
  | { kind: "tool"; name: string; note: string }
  | { kind: "person"; note?: string }
  | { kind: "todo"; item: string; text: string; note?: string };

export interface Station {
  /** `a3` for design stage 3, `b6` for execution station 6. */
  id: string;
  n: number;
  name: string;
  /** What happens at the station, Markdown. */
  what: string;
  actors: Actor[];
}

export type JobId = "context" | "verification" | "knowledge";

export interface Job {
  id: JobId;
  name: string;
  means: string;
  /** The modules cell, Markdown, as written. */
  modulesText: string;
  without: string;
  /** For verification, the guides' modules; otherwise the job's modules. */
  modules: string[];
  /** For verification, the catches' modules. */
  catches: string[];
  /** The job names the glossary (M0's) among what builds it. */
  glossary: boolean;
}

export interface FactoryLevel {
  name: string;
  unit: string;
  decides: string;
  handsOn: string;
  modules: string[];
}

export interface Factory {
  intro: string[];
  scaffoldLead: string;
  jobs: Job[];
  /** The "running many agents at once" paragraph, and the modules it names. */
  many: { text: string; modules: string[] };
  provideLead: string;
  provideList: string;
  provideClose: string;
  levelsLead: string;
  levels: FactoryLevel[];
  loopAndAudit: string;
  pipeline: Station[];
  everyStage: string;
  designSkillsLead: string;
  designSkills: { name: string; station: string }[];
  designPerson: string;
  prLoopLead: string;
  prLoop: { n: number; lead: string; body: string }[];
  lineLead: string;
  line: Station[];
  lineAfter: string;
  learning: string;
  personLead: string;
  person: string[];
  platformLead: string;
  platform: { lead: string; body: string; modules: string[] }[];
}

const JOB_IDS: Record<string, JobId> = {
  Context: "context",
  Verification: "verification",
  Knowledge: "knowledge",
};

/** The design stage a design-level skill serves, where the factory names one. */
const DESIGN_STAGE: Record<string, number> = {
  explain: 1,
  adr: 3,
  "design-brief-builder": 4,
};

/**
 * Stations work the factory says is not built yet, by roadmap item. The
 * factory's "Not built yet" sentences name each; the test checks every item
 * named here still appears in FACTORY.md.
 */
export const NOT_BUILT: Record<string, Actor[]> = {
  a5: [{ kind: "todo", item: "Later", text: "epic planning on the tracker" }],
  b3: [
    {
      kind: "todo",
      item: "13",
      text: "batching small items into one pull request",
    },
  ],
  b6: [
    {
      kind: "todo",
      item: "9",
      text: "a converged drive arming the merge it certified",
      note: "would change “a person merges”; decided on its own",
    },
  ],
  b7: [
    {
      kind: "todo",
      item: "17",
      text: "a post-merge stage that carries out the follow-ups",
    },
  ],
};

/**
 * Work the design level lacks, by roadmap item: for the level as a whole,
 * and for the review "at every stage".
 */
export const DESIGN_NOT_BUILT: { level: Actor[]; everyStage: Actor[] } = {
  level: [{ kind: "todo", item: "3", text: "the greenfield kickoff" }],
  everyStage: [
    { kind: "todo", item: "3", text: "an adversarial red-team reviewer" },
  ],
};

/**
 * The design level's review band, "at every stage": the skills that review
 * and decide, the person who accepts, and what the band still lacks.
 */
export const EVERY_STAGE: Actor[] = [
  { kind: "skill", name: "review", note: "against the repository's decisions" },
  { kind: "skill", name: "decide", note: "a dilemma: ruled, or escalated" },
  { kind: "person", note: "accepts each stage's artifact" },
  ...DESIGN_NOT_BUILT.everyStage,
];

/**
 * What each station hands to the next, by station id, as the figure labels
 * its arrows; `says` is the phrase in that station's own text in FACTORY.md
 * the label stands for, which the test checks is still there.
 */
export const HANDOFFS: Record<string, { label: string; says: RegExp }> = {
  a1: { label: "a dated research note", says: /dated research note/ },
  a2: { label: "the PRD", says: /\*\*PRD\*\*/ },
  a3: { label: "the architecture, with its ADRs", says: /become\s+ADRs/ },
  a4: { label: "the accepted prototype", says: /accepted prototype/ },
  a5: { label: "an epic of planned work items", says: /epic/ },
  b1: {
    label: "a branch, a workspace and a plan",
    says: /a branch, a workspace and a plan/,
  },
  b2: {
    label: "the change, reviewed before its first push",
    says: /review before the first push/,
  },
  b3: { label: "a pull request", says: /A pull request shaped/ },
  b4: {
    label: "every finding with one outcome",
    says: /every finding one recorded outcome/,
  },
  b5: { label: "a green head without conflicts", says: /Red CI or a conflict/ },
  b6: { label: "a merged pull request", says: /A person merges/ },
  b7: {
    label: "follow-up items, back to station 1",
    says: /tracked follow-up items/,
  },
};

/**
 * When each verification module acts, on the time axis the scaffolding
 * figure draws: guides before and while an agent works, catches before merge
 * and before deploy. A module may act at more than one point.
 */
export const VERIFY_PHASES = [
  "before the agent acts",
  "while it works",
  "before merge",
  "before deploy",
] as const;
export const VERIFY_WHEN: Record<string, { at: number[]; what: string }> = {
  M0: { at: [0], what: "instructions" },
  M5: { at: [0, 2], what: "decisions, then checks derived from them" },
  M6: { at: [1], what: "templates" },
  M3: { at: [1], what: "the validation plan" },
  M1: { at: [2], what: "tested gates, CI the authority" },
  M2: { at: [2], what: "freshness checks" },
  M7: { at: [2], what: "layered review" },
  M10: { at: [3], what: "verification before deployment" },
};

/** One actor a "Run by" cell's match names. */
function actorFromMatch(m: RegExpMatchArray): Actor {
  if (m[0] === "a person") return { kind: "person" };
  if (m[0] === "[launcher]")
    return {
      kind: "tool",
      name: "launcher",
      note: "the tracker's “open in coding agent” button",
    };
  const name = m[1] ?? m[3] ?? "";
  const agent = m[2] === "agents" || name === "review-arbiter";
  return {
    kind: agent ? "agent" : "skill",
    name,
    ...(m[4] ? { note: "its deferral" } : {}),
  };
}

const actorKey = (a: Actor) =>
  a.kind === "person" ? "person" : `${a.kind}:${"name" in a ? a.name : ""}`;

/** The actors a "Run by" cell names, in order, each once. */
function actorsOf(cell: string): Actor[] {
  const re =
    /\[`([a-z-]+)`\]\(plugin\/(skills|agents)\/|`([a-z-]+)`('\s*deferral)?|\ba person\b|\[launcher\]/g;
  const all = [...cell.matchAll(re)].map(actorFromMatch);
  return all.filter(
    (a, i) => all.findIndex((b) => actorKey(b) === actorKey(a)) === i,
  );
}

function parseJobs(table: string): Job[] {
  return tableRows(table).flatMap(
    ([job = "", means = "", mods = "", without = ""]) => {
      const name = job.replace(/\*/g, "");
      const id = JOB_IDS[name];
      if (!id) return [];
      const [guides = mods, catches = ""] =
        id === "verification" ? mods.split(/Catches:/) : [mods, ""];
      const bare = (t: string) => t.replace(/\]\([^)]*\)/g, "]");
      return [
        {
          id,
          name,
          means,
          modulesText: mods,
          without,
          modules: moduleIds(bare(guides)),
          catches: moduleIds(bare(catches)),
          glossary: /glossary\s*$/.test(mods.trim()),
        },
      ];
    },
  );
}

/** The first table in `body`, from its header line. */
function tableOf(body: string): string {
  return body.slice(Math.max(0, body.search(/^\|/m))).split(/\n\s*\n/)[0] ?? "";
}

const startingWith = (paras: string[], prefix: string) =>
  paras.find((p) => p.startsWith(prefix)) ?? "";

function scaffoldParts(scaffold: string, provide: string) {
  const sp = paragraphs(scaffold);
  const pp = paragraphs(provide);
  return {
    scaffoldLead: sp[0] ?? "",
    jobs: parseJobs(tableOf(scaffold)),
    many: { text: sp[1] ?? "", modules: moduleIds(sp[1] ?? "") },
    provideLead: pp[0] ?? "",
    provideList: provide
      .slice(
        provide.indexOf("\n- ") + 1,
        provide.lastIndexOf("\nThe [principles]"),
      )
      .trim(),
    provideClose: pp[pp.length - 1] ?? "",
  };
}

function levelParts(two: string) {
  const tp = paragraphs(two);
  return {
    levelsLead: tp[0] ?? "",
    levels: tableRows(two).map(
      ([name = "", unit = "", decides = "", handsOn = "", mods = ""]) => ({
        name: name.replace(/\*/g, ""),
        unit,
        decides,
        handsOn,
        modules: moduleIds(mods),
      }),
    ),
    loopAndAudit: tp[tp.length - 1] ?? "",
  };
}

function designStation(item: {
  n: number;
  text: string;
  body: string;
}): Station {
  const skills = Object.entries(DESIGN_STAGE)
    .filter(([, stage]) => stage === item.n)
    .map(([name]): Actor => ({ kind: "skill", name }));
  const people: Actor[] =
    item.n === 2 || item.n === 5 ? [{ kind: "person" }] : [];
  const id = `a${item.n}`;
  return {
    id,
    n: item.n,
    name: leadOf(item.text),
    what: item.body,
    actors: [...skills, ...people, ...(NOT_BUILT[id] ?? [])],
  };
}

function designParts(pipe: string) {
  const pp = paragraphs(pipe);
  return {
    pipeline: listItems(pipe).map(designStation),
    everyStage: startingWith(pp, "**At every stage"),
    designSkillsLead: startingWith(pp, "The skills that run"),
    designSkills: tableRows(tableOf(pipe.slice(pipe.indexOf("| Skill")))).map(
      ([skill = "", station = ""]) => ({
        name: /`([a-z-]+)`/.exec(skill)?.[1] ?? skill,
        station,
      }),
    ),
    designPerson: startingWith(pp, "A person sets"),
  };
}

function lineStation([
  n = "",
  name = "",
  what = "",
  by = "",
]: string[]): Station {
  const id = `b${n}`;
  return {
    id,
    n: Number(n),
    name,
    what,
    actors: [...actorsOf(by), ...(NOT_BUILT[id] ?? [])],
  };
}

function executionParts(exec: string) {
  const ep = paragraphs(exec);
  return {
    prLoopLead: ep[0] ?? "",
    prLoop: listItems(exec).map((i) => ({
      n: i.n,
      lead: leadOf(i.text),
      body: i.body,
    })),
    lineLead: startingWith(ep, "The plugin runs that loop"),
    line: tableRows(tableOf(exec.slice(exec.indexOf("| #")))).map(lineStation),
    lineAfter: startingWith(ep, "Follow-up items"),
  };
}

function boundaryParts(person: string, platform: string) {
  return {
    personLead: paragraphs(person)[0] ?? "",
    person: listItems(person).map((i) => i.body),
    platformLead: paragraphs(platform)[0] ?? "",
    platform: listItems(platform).map((i) => ({
      lead: leadOf(i.text),
      body: i.body,
      modules: moduleIds(
        i.body.replace(/\]\(modules\/(M\d+)-[^)]*\)/g, "] $1"),
      ),
    })),
  };
}

export function parseFactory(markdown: string): Factory {
  const parts = sections(markdown);
  const of = (prefix: string) => section(parts, prefix);
  return {
    intro: paragraphs(withoutTitle(parts[0]?.body ?? "")),
    ...scaffoldParts(of("A factory of agents"), of("What Jig provides")),
    ...levelParts(of("Two levels")),
    ...designParts(of("Design and planning")),
    ...executionParts(of("Execution")),
    learning: firstParagraph(of("The learning loop")),
    ...boundaryParts(of("What stays"), of("What Jig leaves")),
  };
}

/** Which scaffolding jobs each module builds: `guide` and `catch` split verification. */
export function jobsByModule(f: Factory): Map<string, string[]> {
  const order = ["context", "guide", "catch", "knowledge", "many"];
  const out = new Map<string, string[]>();
  const add = (id: string, job: string) => {
    const list = out.get(id) ?? [];
    if (!list.includes(job)) list.push(job);
    out.set(id, list);
  };
  for (const job of f.jobs) {
    for (const id of job.modules)
      add(id, job.id === "verification" ? "guide" : job.id);
    for (const id of job.catches) add(id, "catch");
  }
  for (const id of f.many.modules) add(id, "many");
  for (const [id, list] of out)
    out.set(
      id,
      list.sort((a, b) => order.indexOf(a) - order.indexOf(b)),
    );
  return out;
}
