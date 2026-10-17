/**
 * What hovering or focusing an actor opens (scripts/site.ts reads it from
 * the element's `data-tip-*` attributes), and where the actor links to.
 */
import type { Actor } from "./data/factory.ts";
import {
  factory,
  isRoadmapGroup,
  roadmapHref,
  roadmapItem,
  skillSummary,
  toolSummary,
} from "./data/index.ts";
import { clip, plain } from "./data/modules.ts";
import { REPO_URL } from "./routes.ts";

export const roadmapLabel = (item: string) =>
  isRoadmapGroup(item) ? `roadmap, ${item}` : `roadmap ${item}`;

export interface ActorTip {
  href: string;
  head: string;
  kind: string;
  body: string;
  more: string;
  /** What a screen reader hears before the chip's name. */
  said: string;
}

export function actorTip(a: Actor): ActorTip {
  switch (a.kind) {
    case "skill":
      return {
        href: `/skills/${a.name}/`,
        head: a.name,
        kind: `Skill · jig:${a.name}`,
        body: skillSummary(a.name),
        more: "Open the skill →",
        said: "Run by a skill: ",
      };
    case "agent":
      return {
        href: `/skills/${a.name}/`,
        head: a.name,
        kind: `Agent · jig:${a.name}`,
        body: skillSummary(a.name),
        more: "Open the agent →",
        said: "Run by an agent: ",
      };
    case "tool":
      return {
        href: `${REPO_URL}/blob/main/tools/${a.name}/README.md`,
        head: a.name,
        kind: "Tool · runs outside the agent",
        body: toolSummary(a.name),
        more: "Open its README →",
        said: "Run by a tool: ",
      };
    case "person":
      return {
        href: "/factory/#person",
        head: "A person",
        kind: "Kept with people",
        body:
          (a.note ? `Here, a person ${a.note}. ` : "") +
          plain(factory().personLead),
        more: "What stays with a person →",
        said: "Run by a person",
      };
    case "todo": {
      const item = roadmapItem(a.item);
      return {
        href: roadmapHref(a.item),
        head: `On the roadmap · ${roadmapLabel(a.item)}`,
        kind: "Roadmap",
        body: item ? clip(`${item.title}. ${plain(item.body)}`, 220) : a.text,
        more: "Open the roadmap item →",
        said: "On the roadmap: ",
      };
    }
  }
}

/** The attributes that make an element open the actor's popover. */
export function tipData(tip: ActorTip): Record<string, string> {
  return {
    "data-tip-head": tip.head,
    "data-tip-kind": tip.kind,
    "data-tip-body": tip.body,
    "data-tip-more": tip.more,
  };
}
