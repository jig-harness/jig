/**
 * The personas, read from `references/personas.md`: the one place they are
 * written, so the brief a persona gets is the section a person reads.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Defect } from "../../../../shared/errors.ts";
import { KINDS, type Kind } from "./document.ts";

export interface Persona {
  id: string;
  name: string;
  reads: Kind[];
  /** The section below the heading, handed to the persona as its brief. */
  section: string;
}

export const PERSONAS_FILE = join(
  import.meta.dir,
  "..",
  "..",
  "references",
  "personas.md",
);

const HEADING = /^## (.+?) \(`([a-z][a-z0-9-]*)`\)\s*$/;

function readsOf(section: string, id: string): Kind[] {
  const match = /^\*\*Reads:\*\*\s*(.+)$/m.exec(section);
  if (!match) throw new Defect(`persona ${id} has no **Reads:** line`);
  const kinds = (match[1] ?? "").split(",").map((word) => word.trim());
  for (const kind of kinds)
    if (!(KINDS as readonly string[]).includes(kind))
      throw new Defect(`persona ${id} reads an unknown kind: ${kind}`);
  return kinds as Kind[];
}

/** Every persona the file defines, in its order. */
export function parsePersonas(text: string): Persona[] {
  const personas: Persona[] = [];
  let current: { id: string; name: string; lines: string[] } | undefined;
  const close = () => {
    if (!current) return;
    const section = current.lines.join("\n").trim();
    personas.push({
      id: current.id,
      name: current.name,
      reads: readsOf(section, current.id),
      section,
    });
  };
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("## ")) {
      close();
      const match = HEADING.exec(line);
      current = match
        ? { name: match[1] ?? "", id: match[2] ?? "", lines: [] }
        : undefined;
    } else current?.lines.push(line);
  }
  close();
  const ids = new Set<string>();
  for (const persona of personas) {
    if (ids.has(persona.id))
      throw new Defect(`persona ${persona.id} is defined twice`);
    ids.add(persona.id);
  }
  return personas;
}

export function loadPersonas(file = PERSONAS_FILE): Persona[] {
  return parsePersonas(readFileSync(file, "utf8"));
}

/** The personas that read a document of `kind`. */
export function personasFor(kind: Kind, all = loadPersonas()): Persona[] {
  return all.filter((persona) => persona.reads.includes(kind));
}
