/**
 * The work identity: one shape for a pull request and an item. An icon that
 * opens its popover, the key or number as its link, and a Copy; the popover
 * holds the quoted title, the kind with the product, the standing, the
 * repository, the linked work and one link out. A pull request's icon shows
 * its standing on the forge only, where the dispatcher holds it being the
 * card's status mark and stage chip; an item's icon is the same for every
 * tracker, since the page reads no live state for an item.
 *
 * A card shows its lead identity, then its linked work as smaller identities
 * (`LinkedInline`), up to two and "+N more"; the popover and the opened card
 * (`LinkedDetail`) list it all, or say that none was found or that the read
 * does not say.
 */
import { useContext } from "react";
import type {
  LineLinks,
  LineSnapshot,
} from "../../plugin/dispatch/lib/dashboard-contract.ts";
import type { DashboardPr } from "../../plugin/dispatch/lib/dashboard-pr.ts";
import { CopyButton } from "./copy.tsx";
import { Hint } from "./fold.tsx";
import { Glyph } from "./icon-word.tsx";
import {
  FORGE_ICONS,
  type ForgeStanding,
  GROUP_ICONS,
  type IconWord,
  LINE_ICONS,
  WORK_KIND_ICONS,
} from "./icons.ts";
import { type LinkedWork, linkedWork } from "./linked.ts";
import { derivedLink, type Forges, forgesOf } from "./links.ts";
import { prNumber } from "./pr-state.ts";
import {
  forgeStanding,
  type Standing,
  type StandingKind,
} from "./pr-standing.ts";
import {
  RepoLink,
  StandingSource,
  useMouseHover,
  usePrFact,
  useStanding,
} from "./pr.tsx";
import { itemWords, trackerOf } from "./tracker-name.ts";

export interface WorkProps {
  repo: string;
  /** `PR #7` or an item's key. */
  target: string;
  url: string | null;
  title?: string | null;
  /** The line's links for it; absent when the line does not say. */
  links?: LineLinks | undefined;
}

/** A standing's word as the popover says it. */
const FORGE_WORDS: Record<ForgeStanding, string> = {
  open: "open",
  draft: "draft",
  merged: "merged",
  closed: "closed",
  "not read": "not read yet",
};

/** Where the dispatcher holds a pull request, drawn beside its words in the popover. */
const KIND_ICONS: Record<StandingKind, IconWord> = {
  driving: LINE_ICONS.driving,
  "following-up": LINE_ICONS["following-up"],
  waiting: LINE_ICONS.waiting,
  "needs-person": LINE_ICONS["needs-person"],
  queued: GROUP_ICONS.starts,
  reported: GROUP_ICONS.reported,
  refused: GROUP_ICONS.never,
  held: GROUP_ICONS.held,
  merged: FORGE_ICONS.merged,
  closed: FORGE_ICONS.closed,
  draft: FORGE_ICONS.draft,
  open: FORGE_ICONS.open,
  unknown: FORGE_ICONS["not read"],
};

/** The forge a pull request's link names, for the words that say where it goes. */
function forgeOf(url: string | null): { name: string | null; host: string } {
  if (url === null) return { name: null, host: "" };
  const host = URL.canParse(url) ? new URL(url).host : "";
  return {
    name:
      host === "github.com" || host.endsWith(".github.com") ? "GitHub" : null,
    host,
  };
}

const forgesByLine = new WeakMap<LineSnapshot, Forges>();

/** What the line's links tell, worked out once per line. */
function forgesFor(line: LineSnapshot | null): Forges | null {
  if (line === null) return null;
  const known = forgesByLine.get(line);
  if (known !== undefined) return known;
  const forges = forgesOf(line);
  forgesByLine.set(line, forges);
  return forges;
}

/** The title the line holds for a target, where no prop gave one. */
function titleFromLine(
  line: LineSnapshot | null,
  repo: string,
  target: string,
): string | null {
  return forgesFor(line)?.titles.get(`${repo} ${target}`) ?? null;
}

function StandingBody({ standing }: { standing: Standing }) {
  return (
    <>
      <p className={`prLabel tone-${standing.tone}`}>
        <Glyph of={KIND_ICONS[standing.kind]} size={14} /> {standing.label}
      </p>
      <ul className="prFacts">
        {standing.facts.map((f) => (
          <li key={f}>{f}</li>
        ))}
      </ul>
    </>
  );
}

/** The popover's list of linked work: each with its icon and link. */
function LinkedLine({ repo, linked }: { repo: string; linked: LinkedWork }) {
  const { line } = useContext(StandingSource);
  const forges = forgesFor(line);
  return (
    <>
      <p className="sm wLinked">
        <b>Linked work:</b> {linked.state === "some" ? null : linked.sentence}
      </p>
      {linked.state === "some" ? (
        <ul className="wLinkedList">
          {linked.all.map((ref) => {
            const url =
              ref.url ??
              (forges === null ? null : derivedLink(repo, ref.target, forges));
            return (
              <li key={ref.target}>
                <Glyph of={ref.pr ? FORGE_ICONS.open : WORK_KIND_ICONS.issue} />{" "}
                {url === null ? (
                  <span className="m">{ref.target}</span>
                ) : (
                  <a
                    className="m"
                    href={url}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    {ref.target}
                  </a>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
    </>
  );
}

interface Shape {
  repo: string;
  target: string;
  url: string | null;
  title: string | null;
  /** What it is, with its product: "GitHub pull request", "Linear issue". */
  kind: string;
  icon: IconWord;
  /** The trigger's class: its standing's colour. */
  tone: string;
  /** The trigger's accessible name. */
  name: string;
  facts: Array<{ k: string; v: string }>;
  standing: Standing | null;
  linked: LinkedWork | null;
  /** The one link out, and what is said where there is none. */
  openWord: string;
  noLinkWords: string;
  copy: string;
  copyAria: string;
  /** Whether it leads its card: a lead identity has its Copy on the face. */
  lead: boolean;
  className: string;
}

/** One identity, drawn the same for a pull request and an item. */
function Identity({ shape }: { shape: Shape }) {
  const { open, setOpen, hover } = useMouseHover();
  return (
    <span
      className={`wid ${shape.className}${shape.lead ? "" : " lk"}`}
      {...hover}
    >
      <Hint
        className={`prState wtrig ${shape.tone}`}
        label={shape.name}
        open={open}
        onOpenChange={setOpen}
        trigger={<Glyph of={shape.icon} size={shape.lead ? 16 : 14} />}
      >
        <p className="wKind mut">{shape.kind}</p>
        {shape.title === null ? (
          <p className="mut">Its title is not in this read.</p>
        ) : (
          <strong className="wTitle">
            <q>{shape.title}</q>
          </strong>
        )}
        {shape.standing === null ? null : (
          <StandingBody standing={shape.standing} />
        )}
        <dl className="kv wFacts">
          <dt>repository</dt>
          <dd className="m">
            <RepoLink repo={shape.repo} url={shape.url} />
          </dd>
          {shape.facts.map((f) => (
            <div key={f.k} style={{ display: "contents" }}>
              <dt>{f.k}</dt>
              <dd className="m">
                <span>{f.v}</span>
              </dd>
            </div>
          ))}
        </dl>
        {shape.linked === null ? null : (
          <LinkedLine repo={shape.repo} linked={shape.linked} />
        )}
        <p className="wTools">
          {shape.url === null ? (
            <span className="mut">{shape.noLinkWords}</span>
          ) : (
            <a href={shape.url} target="_blank" rel="noreferrer noopener">
              {shape.openWord}
            </a>
          )}
          <CopyButton text={shape.copy} aria={shape.copyAria} label="Copy" />
        </p>
      </Hint>
      {shape.url === null ? (
        <span className="tgt">{shape.target}</span>
      ) : (
        <a
          className="tgt"
          href={shape.url}
          target="_blank"
          rel="noreferrer noopener"
        >
          {shape.target}
        </a>
      )}
      {shape.lead ? (
        <CopyButton text={shape.copy} aria={shape.copyAria} />
      ) : null}
    </span>
  );
}

function prShape(
  props: WorkProps & { pr: string; lead: boolean },
  forge: ForgeStanding,
  standing: Standing | null,
  title: string | null,
): Shape {
  const where = forgeOf(props.url);
  const word = FORGE_WORDS[forge];
  return {
    repo: props.repo,
    target: props.target,
    url: props.url,
    title,
    kind: `${where.name === null ? "Pull request" : `${where.name} pull request`}, ${word}`,
    icon: FORGE_ICONS[forge],
    tone: `st-${forge.replace(" ", "-")}`,
    name: `${props.target}: ${word}${standing === null ? "" : `, ${standing.label}`}`,
    facts: [
      { k: "standing", v: word },
      { k: "number", v: `#${props.pr}` },
    ],
    standing,
    linked: props.lead ? linkedWork(props.target, props.links) : null,
    openWord:
      where.name !== null ? `Open on ${where.name}` : `Open on ${where.host}`,
    noLinkWords: "No link: the line holds none for it.",
    copy: props.pr,
    copyAria: `Copy PR ID ${props.pr}`,
    lead: props.lead,
    className: `prIdentity pr-${forge.replace(" ", "-")}`,
  };
}

/** A pull request that leads its card: the forge's read of it and the line's story. */
function LeadPr(props: WorkProps & { pr: string }) {
  const { line } = useContext(StandingSource);
  const fact: DashboardPr | null = usePrFact(props.repo, props.target);
  const standing = useStanding(props.repo, props.pr, fact);
  const forge = forgeStanding(line, props.repo, Number(props.pr), fact);
  const title =
    fact?.title ?? props.title ?? titleFromLine(line, props.repo, props.target);
  return (
    <Identity
      shape={prShape(
        { ...props, url: fact?.url ?? props.url, lead: true },
        forge,
        standing,
        title,
      )}
    />
  );
}

/** A pull request linked from an item's card: the line names only open ones, so it reads no forge. */
function LinkedPr(props: WorkProps & { pr: string }) {
  const { line } = useContext(StandingSource);
  const title = props.title ?? titleFromLine(line, props.repo, props.target);
  return (
    <Identity shape={prShape({ ...props, lead: false }, "open", null, title)} />
  );
}

/** An item: its key, its tracker's words for it, and no live state. */
function Item(props: WorkProps & { lead: boolean }) {
  const { line } = useContext(StandingSource);
  const words = itemWords(trackerOf(line, props.repo));
  const forges = forgesFor(line);
  const url =
    props.url ??
    (forges === null ? null : derivedLink(props.repo, props.target, forges));
  const title = props.title ?? titleFromLine(line, props.repo, props.target);
  return (
    <Identity
      shape={{
        repo: props.repo,
        target: props.target,
        url,
        title,
        kind:
          words.unnamed === null
            ? words.kind
            : `${words.kind} (${words.unnamed})`,
        icon: WORK_KIND_ICONS.issue,
        tone: "st-item",
        name: `${words.kind} ${props.target}: details`,
        facts: [{ k: "key", v: props.target }],
        standing: null,
        linked: props.lead ? linkedWork(props.target, props.links) : null,
        openWord: words.open,
        noLinkWords: `No link: ${words.name ?? "the line"} gave none for it.`,
        copy: props.target,
        copyAria: `Copy ID ${props.target}`,
        lead: props.lead,
        className: "itemIdentity",
      }}
    />
  );
}

/** The repository a need of the whole host names, whose target is an account (`HOST_NEED_REPO` in the dispatcher's preflight). */
const HOST_REPO = "host";

/** A card's lead identity: the pull request or item the card is about; an account as plain text, and no target as nothing. */
function Work(props: WorkProps) {
  if (props.target === "" || props.repo === HOST_REPO)
    return props.target === "" ? null : (
      <span className="tgt">{props.target}</span>
    );
  const pr = prNumber(props.target);
  return pr === null ? <Item {...props} lead /> : <LeadPr {...props} pr={pr} />;
}

/** A piece of linked work, as a smaller identity with its Copy in its popover. */
function Linked({ repo, target, url }: Omit<WorkProps, "links">) {
  const pr = prNumber(target);
  return pr === null ? (
    <Item repo={repo} target={target} url={url} lead={false} />
  ) : (
    <LinkedPr repo={repo} target={target} url={url} pr={pr} />
  );
}

/** Linked work on a card's face, after its identity: up to two, then "+N more"; nothing when none is known. */
function LinkedInline({
  repo,
  target,
  links,
}: Pick<WorkProps, "repo" | "target" | "links">) {
  const linked = linkedWork(target, links);
  if (linked.state !== "some") return null;
  return (
    <span className="links">
      <Glyph of={WORK_KIND_ICONS["linked to"]} />
      <span className="vh">linked to</span>
      {linked.shown.map((ref) => (
        <Linked
          repo={repo}
          target={ref.target}
          url={ref.url}
          key={ref.target}
        />
      ))}
      {linked.more === 0 ? null : (
        <span className="linkMore">+{linked.more} more</span>
      )}
    </span>
  );
}

/** A card's lead identity and the linked work after it, as every card's first row draws them. */
export function WorkLead(props: WorkProps) {
  return (
    <>
      <Work {...props} />
      <LinkedInline
        repo={props.repo}
        target={props.target}
        links={props.links}
      />
    </>
  );
}

/** Linked work in an opened card: every piece, or which case holds when there is none. */
export function LinkedDetail({
  repo,
  target,
  links,
}: Pick<WorkProps, "repo" | "target" | "links">) {
  const linked = linkedWork(target, links);
  return (
    <div className="linkedDetail sm">
      <b>Linked work:</b>{" "}
      {linked.state === "some" ? (
        <span className="links">
          {linked.all.map((ref) => (
            <Linked
              repo={repo}
              target={ref.target}
              url={ref.url}
              key={ref.target}
            />
          ))}
        </span>
      ) : (
        linked.sentence
      )}
    </div>
  );
}
