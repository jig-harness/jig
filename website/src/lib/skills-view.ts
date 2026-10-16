/**
 * Where each skill shows up: the modules it runs (from the module index) and
 * the factory stations it runs (from FACTORY.md).
 */
import { factory, modules } from "./data/index.ts";

export function modulesRunBy(name: string): { id: string; title: string }[] {
  return modules()
    .filter((m) => m.skills.includes(name))
    .map((m) => ({ id: m.id, title: m.title }));
}

/** The stations any of the named skills or agents runs, in factory order. */
export function stationsRunBy(
  ...names: string[]
): { label: string; href: string }[] {
  const f = factory();
  const out: { label: string; href: string }[] = [];
  for (const s of [...f.pipeline, ...f.line]) {
    const runs = s.actors.some(
      (a) =>
        (a.kind === "skill" || a.kind === "agent") && names.includes(a.name),
    );
    if (!runs) continue;
    const level = s.id.startsWith("a") ? "Design" : "Execution";
    out.push({
      label: `${level} ${s.n} · ${s.name}`,
      href: `/factory/#station-${s.id}`,
    });
  }
  if (names.some((n) => ["review", "decide"].includes(n)))
    out.push({ label: "Design · every stage", href: "/factory/#station-band" });
  return out;
}
