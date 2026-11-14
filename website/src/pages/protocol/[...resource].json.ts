import type { APIRoute } from "astro";
import { protocolResources } from "../../lib/protocol-source.ts";

export function getStaticPaths() {
  return protocolResources().map(({ route, text }) => ({
    params: { resource: route.replace(/\.json$/, "") },
    props: { text },
  }));
}

export const GET: APIRoute = ({ props }) =>
  new Response(props.text, {
    headers: { "content-type": "application/json; charset=utf-8" },
  });
