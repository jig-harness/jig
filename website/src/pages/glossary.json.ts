// Every term's definition, rendered, for the definition that opens beside a
// term (scripts/site.ts).
import { glossary } from "../lib/data/index.ts";
import { mdInline } from "../lib/markdown.ts";

export async function GET() {
  const out: Record<string, { term: string; group: string; html: string }> = {};
  for (const e of glossary())
    out[e.anchor] = {
      term: e.term,
      group: e.group,
      html: await mdInline(e.definition, "GLOSSARY.md"),
    };
  return new Response(JSON.stringify(out), {
    headers: { "content-type": "application/json" },
  });
}
