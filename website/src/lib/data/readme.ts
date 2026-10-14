/**
 * The parts of the README the home page lays out: its factory section and
 * its list of ways to use Jig.
 */
import { leadOf, listItems, paragraphs, section, sections } from "../source.ts";

export interface ReadmeFactory {
  lead: string;
  jobs: { lead: string; body: string }[];
  /** How Jig fits the way an organization already works. */
  fits: string;
  /** The skills run the stations at two levels, and where to read more. */
  stations: string;
}

export function parseReadme(readme: string): {
  factory: ReadmeFactory;
  ways: { n: number; lead: string; body: string }[];
} {
  const parts = sections(readme);
  const fx = section(parts, "Jig as a software factory");
  const paras = paragraphs(fx);
  const close = (paras[paras.length - 1] ?? "").replace(/\s*\n\s*/g, " ");
  const at = close.indexOf("On top of the scaffolding");
  return {
    factory: {
      lead: (paras[0] ?? "").replace(/:\s*$/, "."),
      jobs: listItems(fx).map((i) => ({
        lead: leadOf(i.text),
        body: i.body.replace(/^\*\*[^*]+\*\*:\s*/, ""),
      })),
      fits: at > 0 ? close.slice(0, at).trim() : close,
      stations: at > 0 ? close.slice(at).trim() : "",
    },
    ways: listItems(section(parts, "Ways to use")).map((i) => ({
      n: i.n,
      lead: leadOf(i.text),
      body: i.body,
    })),
  };
}
