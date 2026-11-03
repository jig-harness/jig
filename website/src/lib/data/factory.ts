/**
 * FACTORY.md in the parts the factory pages and figures lay out, in the
 * document's order: the line, its stations and who runs each station; what
 * the dispatcher starts with nobody at the keyboard; deciding what to build;
 * the scaffolding's three jobs, the modules that build each and what Jig
 * provides; the learning loop; what stays with a person and what the
 * platform supplies. A section is found by the start of its heading, and a
 * subsection by the start of its own.
 */
import {
  blocks,
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

/** Who runs a station: a skill, the arbiter agent, a tool, a person, or work on the roadmap. */
export type Actor =
  | { kind: "skill" | "agent"; name: string; note?: string }
  | { kind: "tool"; name: string; note: string; href?: string }
  | { kind: "person"; note?: string }
  | { kind: "todo"; item: string; text: string; note?: string };

export interface Station {
  /** `a3` for design stage 3, `b6` for line station 6. */
  id: string;
  n: number;
  name: string;
  /** What happens at the station, Markdown. */
  what: string;
  actors: Actor[];
}

/** The part of the factory a station is in, as a station's label names it. */
export const partOf = (s: Pick<Station, "id">): "Design" | "Line" =>
  s.id.startsWith("a") ? "Design" : "Line";

/** A station as the site labels it: "Line 4 · Drive". */
export const stationLabel = (s: Station): string =>
  `${partOf(s)} ${s.n} · ${s.name}`;

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

/**
 * Roadmap work an "On the roadmap" sentence links: the item's number, or a
 * group's name ("Later"), and the link's text, which says what the work is.
 */
export interface RoadmapRef {
  item: string;
  text: string;
  /** The ROADMAP.md heading anchor the link names. */
  anchor: string;
  /** The title of the FACTORY.md section the sentence is in. */
  section: string;
}

/** One thing the dispatcher starts, as "What it starts" lists it. */
export interface DispatcherStart {
  /** The item's bold lead: "A pickup". */
  lead: string;
  /** The item's text, Markdown. */
  body: string;
  /** The line station it starts, from `DISPATCHER_STARTS`. */
  station?: string;
}

/** The dispatcher's section, "With nobody at the keyboard". */
export interface Unattended {
  /** The paragraphs before the first subsection. */
  lead: string[];
  /** Each subsection: its anchor, its title and its Markdown, in order. */
  parts: { id: string; title: string; body: string }[];
  /** What each tick reads, as "What it starts" lists it in its first sentence. */
  reads: string[];
  starts: DispatcherStart[];
  /** The stops only a person settles, as "What reaches a person" lists them first. */
  tells: string[];
  /** "What it never does": each item's bold lead and its text. */
  never: { lead: string; body: string }[];
}

export interface Factory {
  intro: string[];
  lineLead: string;
  line: Station[];
  lineAfter: string;
  prLoopLead: string;
  prLoop: { n: number; lead: string; body: string }[];
  unattended: Unattended;
  designLead: string;
  pipeline: Station[];
  everyStage: string;
  designSkillsLead: string;
  designSkills: { name: string; station: string }[];
  designPerson: string;
  levelsLead: string;
  levels: FactoryLevel[];
  scaffoldLead: string;
  jobs: Job[];
  /** The "running many agents at once" paragraph, and the modules it names. */
  many: { text: string; modules: string[] };
  provideLead: string;
  provideList: string;
  provideClose: string;
  /** The learning loop's first paragraph, and the paragraphs after it. */
  learning: string;
  learningMore: string[];
  /** The paragraph on the audit that closes the learning loop's section. */
  audit: string;
  personLead: string;
  person: string[];
  platformLead: string;
  platform: { lead: string; body: string; modules: string[] }[];
  /** Every roadmap link an "On the roadmap" sentence makes, in order. */
  roadmap: RoadmapRef[];
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
 * Stations work the factory says is on the roadmap, by roadmap item. The
 * factory's "On the roadmap" sentences link each; the test checks every item
 * named here is one of those links.
 */
export const NOT_BUILT: Record<string, Actor[]> = {
  a5: [{ kind: "todo", item: "Later", text: "epic planning on the tracker" }],
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
      text: "a follow-up skill for every repository",
    },
  ],
};

/**
 * Work the design level lacks, by roadmap item: for the level as a whole,
 * and for the review "at every stage".
 */
export const DESIGN_NOT_BUILT: { level: Actor[]; everyStage: Actor[] } = {
  level: [{ kind: "todo", item: "3", text: "the greenfield kickoff" }],
  everyStage: [],
};

/**
 * The design level's review band, "at every stage": the skills that review
 * and decide, the person who accepts, and what the band still lacks.
 */
export const EVERY_STAGE: Actor[] = [
  { kind: "skill", name: "review", note: "against the repository's decisions" },
  { kind: "skill", name: "decide", note: "a dilemma: ruled, or escalated" },
  {
    kind: "skill",
    name: "red-team",
    note: "requirements and architecture, by persona",
  },
  { kind: "person", note: "accepts each stage's artifact" },
  ...DESIGN_NOT_BUILT.everyStage,
];

/**
 * The line stations the dispatcher starts when nobody does, by the bold lead
 * of the "What it starts" item that names each start. The line figure draws
 * each as a tap of the dispatcher's rail, and the who-works-where grid marks
 * the dispatcher in each station's column; the test checks every lead here
 * is an item of that list, and every item has a station.
 */
export const DISPATCHER_STARTS: Readonly<Record<string, string>> = {
  "A pickup": "b1",
  "A re-arm": "b4",
  "A re-drive": "b4",
  "The follow-up": "b7",
};

/** The dispatcher, as the tool the who-works-where grid gives a row. */
export const DISPATCHER: Actor = {
  kind: "tool",
  name: "dispatcher",
  note: "starts a station when nobody does",
};

/** What the dispatcher's rail says at each station it starts: "pickup". */
export function dispatcherTaps(f: Factory): Map<string, string[]> {
  const taps = new Map<string, string[]>();
  for (const s of f.unattended.starts) {
    if (!s.station) continue;
    const said = s.lead.replace(/^(A|The) /, "").toLowerCase();
    taps.set(s.station, [...(taps.get(s.station) ?? []), said]);
  }
  return taps;
}

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
  if (m[0] === "The repository's follow-up command")
    return {
      kind: "tool",
      name: "repository follow-up",
      note: "supplied by the repository; started by a person or the dispatcher",
      href: "/factory/line/#line",
    };
  if (m[0] === "[dispatcher]")
    return {
      kind: "tool",
      name: "dispatcher",
      note: "starts the repository's follow-up command",
      href: "/adopt/plugin/#the-dispatcher",
    };
  if (m[0] === "[launcher]")
    return {
      kind: "tool",
      name: "launcher",
      note: "the “open in coding agent” button in Linear",
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
    /\[`([a-z-]+)`\]\(plugin\/(skills|agents)\/|`([a-z-]+)`('\s*deferral)?|\ba person\b|\[launcher\]|The repository's follow-up command|\[dispatcher\]/g;
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

/** The first table in `body` whose header row starts with the column `head`. */
function tableHeaded(body: string, head: string): string {
  const escaped = head.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const at = body.search(new RegExp(`^\\|\\s*${escaped}\\s*\\|`, "m"));
  return at < 0 ? "" : tableOf(body.slice(at));
}

const startingWith = (paras: string[], prefix: string) =>
  paras.find((p) => p.startsWith(prefix)) ?? "";

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

function lineParts(line: string) {
  const lp = paragraphs(line);
  return {
    lineLead: lp[0] ?? "",
    line: tableRows(tableHeaded(line, "#")).map(lineStation),
    lineAfter: startingWith(lp, "Follow-up items"),
    prLoopLead: startingWith(lp, "Every change follows"),
    prLoop: listItems(line).map((i) => ({
      n: i.n,
      lead: leadOf(i.text),
      body: i.body,
    })),
  };
}

/** A subsection's anchor on the unattended page: `unattended-what-it-starts`. */
const partId = (title: string) =>
  `unattended-${title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")}`;

/**
 * The items of the list a sentence opens with, after `verb`: "Each tick
 * reads the tracker, the pull requests and the sessions" gives the three.
 */
function listAfter(text: string, verb: RegExp): string[] {
  const m = new RegExp(`${verb.source}([^.]+)\\.`).exec(
    text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/\s+/g, " "),
  );
  return (m?.[1] ?? "")
    .split(/,\s*(?:or\s+|and\s+)?|\s+(?:and|or)\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function unattendedParts(body: string): Unattended {
  const [own, ...subs] = sections(body, 3);
  const starting = section(subs, "What it starts");
  return {
    lead: paragraphs(own?.body ?? ""),
    parts: subs.map((p) => ({
      id: partId(p.title),
      title: p.title,
      body: p.body,
    })),
    reads: listAfter(firstParagraph(starting), /\breads /),
    tells: listAfter(
      firstParagraph(section(subs, "What reaches a person")),
      /\bsettle: /,
    ),
    starts: listItems(starting).map((i) => {
      const lead = leadOf(i.text).replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
      const station = DISPATCHER_STARTS[lead];
      return { lead, body: i.body, ...(station ? { station } : {}) };
    }),
    never: listItems(section(subs, "What it never does")).map((i) => ({
      lead: leadOf(i.text),
      body: i.body,
    })),
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

function levelParts(design: string) {
  const table = tableHeaded(design, "Part");
  const before = table ? design.slice(0, design.indexOf(table)) : "";
  return {
    levelsLead: paragraphs(before).at(-1) ?? "",
    levels: tableRows(table).map(
      ([name = "", unit = "", decides = "", handsOn = "", mods = ""]) => ({
        name: name.replace(/\*/g, ""),
        unit,
        decides,
        handsOn,
        modules: moduleIds(mods),
      }),
    ),
  };
}

function designParts(design: string) {
  const dp = paragraphs(design);
  return {
    designLead: dp[0] ?? "",
    pipeline: listItems(design).map(designStation),
    everyStage: startingWith(dp, "**At every stage"),
    designSkillsLead: startingWith(dp, "The skills that run"),
    designSkills: tableRows(tableHeaded(design, "Skill")).map(
      ([skill = "", station = ""]) => ({
        name: /`([a-z-]+)`/.exec(skill)?.[1] ?? skill,
        station,
      }),
    ),
    designPerson: startingWith(dp, "A person sets"),
    ...levelParts(design),
  };
}

function scaffoldParts(stands: string) {
  const [own, ...subs] = sections(stands, 3);
  const scaffold = own?.body ?? "";
  const provide = section(subs, "What Jig provides");
  const sp = paragraphs(scaffold);
  const pp = paragraphs(provide);
  const many = startingWith(sp, "Running many agents");
  return {
    scaffoldLead: sp[0] ?? "",
    jobs: parseJobs(tableHeaded(scaffold, "Job")),
    many: { text: many, modules: moduleIds(many) },
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

function learningParts(loop: string) {
  const lp = paragraphs(loop);
  const audit = startingWith(lp, "The [audit]");
  return {
    learning: firstParagraph(loop),
    learningMore: lp.slice(1).filter((p) => p !== audit),
    audit,
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

const ROADMAP_LINK = /\[([^\]]+)\]\(ROADMAP\.md#([^)\s]+)\)/g;

/**
 * The roadmap links of every block that says what is on the roadmap (a
 * paragraph or a list that contains "on the roadmap"), each with the item
 * its anchor names: `9-delegated-merge-…` is item 9, `later` is Later.
 */
function roadmapRefs(all: { title: string; body: string }[]): RoadmapRef[] {
  return all.flatMap(({ title, body }) =>
    blocks(body)
      .filter((b) => /\bon the roadmap\b/i.test(b))
      .flatMap((b) =>
        [...b.matchAll(ROADMAP_LINK)].map(([, text = "", anchor = ""]) => ({
          item:
            /^(\d+)-/.exec(anchor)?.[1] ??
            anchor.charAt(0).toUpperCase() + anchor.slice(1),
          text: text.replace(/\s+/g, " ").replace(/`/g, ""),
          anchor,
          section: title,
        })),
      ),
  );
}

export function parseFactory(markdown: string): Factory {
  const parts = sections(markdown);
  const of = (prefix: string) => section(parts, prefix);
  return {
    intro: paragraphs(withoutTitle(parts[0]?.body ?? "")),
    ...lineParts(of("The line")),
    unattended: unattendedParts(of("With nobody at the keyboard")),
    ...designParts(of("Deciding what to build")),
    ...scaffoldParts(of("What it stands on")),
    ...learningParts(of("The loop that sharpens it")),
    ...boundaryParts(of("What stays"), of("What the platform")),
    roadmap: roadmapRefs(parts),
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
