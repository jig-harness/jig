// The search index: pages, modules and their levels, the factory's stations
// and scaffolding jobs, skills and terms. Built at build time; the browser
// filters it (scripts/site.ts).
import {
  factory,
  features,
  glossary,
  moduleDoc,
  modules,
  skills,
} from "../lib/data/index.ts";
import {
  type Actor,
  jobsByModule,
  partOf,
  stationLabel,
} from "../lib/data/factory.ts";
import { LEVEL_NAME, LEVELS } from "../lib/data/modules.ts";
import { protocolChapters } from "../lib/protocol-source.ts";
import { headingId } from "../lib/view.ts";

const plain = (md: string) =>
  md
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*`_>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
const clip = (s: string, n = 96) =>
  s.length > n ? `${s.slice(0, n - 1).replace(/\s+\S*$/, "")}…` : s;

const JOB_LABEL: Record<string, string> = {
  context: "context",
  guide: "verification · guide",
  catch: "verification · catch",
  knowledge: "knowledge",
  many: "many agents at once",
};

const PAGES: [string, string, string][] = [
  [
    "What you get",
    "/features/",
    "features what you get tooling skills gates audit learning loop reflection change notes changelog tracker configuration launcher",
  ],
  [
    "Get started with Jig",
    "/adopt/",
    "get started getting started install claude code codex agent prompt setup jig.yaml configure requirements bun first audit",
  ],
  [
    "The jig plugin",
    "/adopt/plugin/",
    "plugin drive loop issue pickup codex notes update pin remove where it works troubleshooting release",
  ],
  [
    "Configuration",
    "/adopt/configuration/",
    "configuration layers jig.yaml user repository environment overlay tracker adapter linear",
  ],
  [
    "Extending and adapting Jig",
    "/adopt/extending/",
    "extend adapt interface adapter tracker linear jira store reflection notion command hook forge github gitlab ci github actions windows macos linux operating system wsl launcher provider requirements",
  ],
  [
    "Where the model is in the loop",
    "/adopt/mechanisms/",
    "mechanisms deterministic reasoned model script boundary ledger marker receipt outcome log dispatcher tick drive pass implementer arbiter audit probe judgement failure",
  ],
  [
    "Adoption guide · existing repository",
    "/adopt/existing/",
    "brownfield audit ladder profile order grandfathering coverage gate",
  ],
  [
    "Greenfield guide · new project",
    "/adopt/greenfield/",
    "kickoff phases new project",
  ],
  [
    "Jig as a software factory",
    "/factory/",
    "software factory line dispatcher scaffolding context verification guides catches knowledge stations design planning pipeline pr loop learning loop flywheel platform person merge",
  ],
  [
    "The line",
    "/factory/line/",
    "line execution work item pull request loop pick up build open drive repair merge follow up stations rails",
  ],
  [
    "With nobody at the keyboard: the dispatcher",
    "/factory/unattended/",
    "dispatcher unattended nobody at the keyboard tick timer pickup re-arm re-drive follow-up notification phone morning outcome log dashboard account slot wall usage limit nudge serialized area held labels drift",
  ],
  [
    "Deciding what to build: the feature pipeline",
    "/factory/design/",
    "design planning feature pipeline research requirements prd architecture prototype plan epic stages",
  ],
  [
    "What it stands on: the scaffolding",
    "/factory/scaffolding/",
    "scaffolding context verification guides catches knowledge jobs modules configuration layers tracker interface adapters",
  ],
  [
    "The loop that sharpens it",
    "/factory/learning-loop/",
    "learning loop flywheel miss lens fixture validate measure reflection memory promotion",
  ],
  [
    "What's new and what's next",
    "/whats-new/",
    "changelog roadmap release version",
  ],
  [
    "Code statistics: what Jig is made of",
    "/stats/",
    "code stats statistics lines of code loc size languages modules tests ratio areas kinds",
  ],
  ["All skills", "/skills/", "skills agent index"],
  ["Principles", "/principles/", "principles"],
  ["Glossary", "/glossary/", "glossary terms"],
];

interface Entry {
  kind: string;
  label: string;
  sub: string;
  href: string;
  key: string;
}

const pageEntries = (): Entry[] =>
  PAGES.map(([label, href, words]) => ({
    kind: "Page",
    label,
    sub: "",
    href,
    key: `${label} ${words}`.toLowerCase(),
  }));

function moduleEntries(): Entry[] {
  const jobs = jobsByModule(factory());
  return modules().flatMap((m) => {
    const jl = (jobs.get(m.id) ?? []).map((j) => JOB_LABEL[j]).join(", ");
    const area = plain(m.area);
    const doc = moduleDoc(m.id);
    return [
      {
        kind: "Module",
        label: `${m.id} ${m.title}`,
        sub: area + (jl ? ` · scaffolding: ${jl}` : ""),
        href: `/modules/${m.id}/`,
        key: `${m.id} ${m.title} ${area} ${jl}`.toLowerCase(),
      },
      ...LEVELS.map((level) => {
        const text = plain(doc.levels[level]);
        return {
          kind: "Level",
          label: `${m.id} ${LEVEL_NAME[level]}`,
          sub: clip(text),
          href: `/modules/${m.id}/#${level}`,
          key: `${m.id} ${LEVEL_NAME[level]} ${m.title} ${text}`.toLowerCase(),
        };
      }),
    ];
  });
}

const actorText = (a: Actor) =>
  a.kind === "todo"
    ? `on the roadmap: ${a.text}`
    : a.kind === "person"
      ? "a person"
      : a.name;

function stationEntries(): Entry[] {
  const f = factory();
  return [...f.pipeline, ...f.line].map((s) => {
    const who = s.actors.map(actorText).join(" · ");
    return {
      kind: "Station",
      label: stationLabel(s),
      sub: who,
      href: `/factory/#station-${s.id}`,
      key: `${partOf(s)} ${s.name} station ${who}`.toLowerCase(),
    };
  });
}

const jobEntries = (): Entry[] =>
  factory().jobs.map((j) => {
    const ver = j.id === "verification";
    return {
      kind: "Scaffolding",
      label: j.name + (ver ? " · guides and catches" : ""),
      sub: clip(plain(j.means)),
      href: `/factory/scaffolding/#job-${j.id}`,
      key: `scaffolding ${j.name} ${plain(j.means)}${ver ? " guide guides catch catches" : ""}`.toLowerCase(),
    };
  });

const featureEntries = (): Entry[] =>
  features().features.map((x) => ({
    kind: "Feature",
    label: x.title,
    sub: clip(plain(x.body)),
    href: `/features/#${headingId(x.title)}`,
    key: `${x.title} ${plain(x.body)} ${x.skills.join(" ")} ${x.modules.join(" ")}`.toLowerCase(),
  }));

const skillEntries = (): Entry[] =>
  skills().map((s) => ({
    kind: s.agent ? "Agent" : "Skill",
    label: s.command,
    sub: clip(plain(s.purpose)),
    href: `/skills/${s.name}/`,
    key: `${s.name} ${s.command} ${plain(s.purpose)}`.toLowerCase(),
  }));

const termEntries = (): Entry[] =>
  glossary().map((e) => ({
    kind: "Term",
    label: e.term,
    sub: clip(plain(e.definition)),
    href: `/glossary/#${e.anchor}`,
    key: `${e.term} ${plain(e.definition)}`.toLowerCase(),
  }));

export function GET() {
  const entries = [
    ...pageEntries(),
    {
      kind: "Page",
      label: "The Jig Protocol",
      sub: "",
      href: "/protocol/",
      key: "protocol contracts operating rules",
    },
    ...protocolChapters().map((chapter) => ({
      kind: "Protocol",
      label: chapter.title,
      sub: `Version ${chapter.version} · ${chapter.status}`,
      href: `/protocol/${chapter.chapter}/`,
      key: `${chapter.title} ${chapter.values.map((v) => Object.values(v).join(" ")).join(" ")}`.toLowerCase(),
    })),
    ...moduleEntries(),
    ...stationEntries(),
    ...jobEntries(),
    ...featureEntries(),
    ...skillEntries(),
    ...termEntries(),
  ];
  return new Response(JSON.stringify(entries), {
    headers: { "content-type": "application/json" },
  });
}
