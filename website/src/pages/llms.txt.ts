// The root llms.txt: what Jig is and a link to each section's own file.
import { root } from "../lib/llms-data.ts";
import { render } from "../lib/llms.ts";

export function GET() {
  return new Response(render(root()), {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
