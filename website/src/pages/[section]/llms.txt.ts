// One section's llms.txt: /modules/llms.txt, /skills/llms.txt and so on.
import { section, sections } from "../../lib/llms-data.ts";
import { render, type SectionEntry } from "../../lib/llms.ts";

export function getStaticPaths() {
  return sections().map((entry) => ({
    params: { section: entry.slug },
    props: { entry },
  }));
}

export function GET({ props }: { props: { entry: SectionEntry } }) {
  return new Response(render(section(props.entry)), {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
