/**
 * The miss → lens flywheel and its companion cycles, from M8's README.
 */
import { leadOf, listItems, paragraphs, section, sections } from "../source.ts";

export interface Flywheel {
  /** The paragraph before the steps: who catches a miss. */
  oracle: string;
  steps: { n: number; lead: string; body: string }[];
  cycles: { lead: string; body: string }[];
  /** "Both cycles are the same shape as the flywheel…" */
  sameShape: string;
  trigger: { title: string; body: string };
}

export function parseFlywheel(m8Readme: string): Flywheel {
  const parts = sections(m8Readme);
  const steps = section(parts, "The flywheel");
  const companion = section(parts, "The two companion cycles");
  const [main = "", trigger = ""] = companion.split(/^### /m);
  const nl = trigger.indexOf("\n");
  return {
    oracle: paragraphs(steps)[0] ?? "",
    steps: listItems(steps).map((i) => ({
      n: i.n,
      lead: leadOf(i.text).replace(/ — .*/, ""),
      body: i.body,
    })),
    cycles: listItems(main).map((i) => ({
      lead: leadOf(i.text),
      body: i.body,
    })),
    sameShape: paragraphs(main).find((p) => p.startsWith("Both cycles")) ?? "",
    trigger: {
      title: nl < 0 ? trigger.trim() : trigger.slice(0, nl).trim(),
      body: nl < 0 ? "" : trigger.slice(nl + 1).trim(),
    },
  };
}
