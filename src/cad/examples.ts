import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The code engine's cookbook: worked build123d designs, each modelled on the best bought version of the thing, kept as
 * plain scripts in src/cad/examples/. A design worker reaches them only through this MCP: the cad_design prompt names
 * each one by what it is for in one line, and the read-only cad_examples tool lists them and returns one script on
 * request, so the prompt pays a line per example instead of a script per example.
 *
 * A script's header (its docstring) is the record: title on the first line, then "Use for:" (the requests it suits,
 * so a worker chooses by purpose before mechanism), "Pattern:", "Modelled on:", "Published sizes used:", "Concept:"
 * and "What makes this good:".
 */
const DIR = fileURLToPath(new URL("../../src/cad/examples/", import.meta.url));
const FIELDS = {
  "Use for": "use_for",
  "Pattern": "pattern",
  "Modelled on": "modelled_on",
  "Published sizes used": "published_sizes",
  "Concept": "concept",
  "What makes this good": "what_makes_this_good",
} as const;
type Field = (typeof FIELDS)[keyof typeof FIELDS];
export type CadExample = { name: string; title: string; script: string } & Record<Field, string>;

/** Simplest first: the order the list and the prompt present them in. */
export const CAD_EXAMPLE_ORDER = [
  "cable_clip", "wall_hook", "drawer_divider", "organizer_tray", "plant_pot", "knurled_knob", "phone_stand",
  "swept_hook", "loft_handle", "shelf_bracket", "broom_grip", "desk_edge_cable_holder", "threaded_jar",
  "desk_clamp_hook", "bag_clip", "hinged_box", "bistable_clicker", "chainmail", "trigger_capo",
];

function parse(name: string, script: string): CadExample {
  const header = /^\s*"""([\s\S]*?)"""/.exec(script)?.[1] ?? "";
  const lines = header.split("\n");
  const example = { name, title: (lines.shift() ?? name).trim(), script } as CadExample;
  let field: Field | undefined;
  for (const line of lines) {
    const start = /^([A-Z][A-Za-z ]+):\s*(.*)$/.exec(line);
    const key = start && (FIELDS as Record<string, Field>)[start[1]];
    if (start && key) { field = key; example[key] = start[2].trim(); }
    else if (field && line.trim()) example[field] += " " + line.trim();
  }
  for (const key of Object.values(FIELDS)) example[key] ??= "";
  return example;
}

let cache: CadExample[] | undefined;
/** Every example on disk, in cookbook order (unlisted files last, by name). Empty when the folder is missing. */
export function cadExamples(): CadExample[] {
  if (cache) return cache;
  let files: string[] = [];
  try { files = fs.readdirSync(DIR).filter((f) => /^[a-z0-9_]+\.py$/.test(f)); } catch { /* no cookbook shipped */ }
  const rank = (n: string) => { const i = CAD_EXAMPLE_ORDER.indexOf(n); return i < 0 ? CAD_EXAMPLE_ORDER.length : i; };
  cache = files.map((f) => parse(f.slice(0, -3), fs.readFileSync(path.join(DIR, f), "utf8")))
    .sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
  return cache;
}

/** One line per example for the cad_design prompt: "name: what it is for". */
export function cadExampleLines(): string {
  return cadExamples().map((e) => `${e.name}: ${e.use_for}`).join("\n");
}

/** cad_examples: without a name, the list; with one, that example's record and script. */
export function cadExamplesTool(args: Record<string, unknown>): Record<string, unknown> {
  const extra = Object.keys(args).filter((k) => k !== "name");
  if (extra.length) throw new Error("cad_examples accepts only name.");
  const all = cadExamples();
  if (args.name === undefined)
    return {
      examples: all.map(({ name, title, use_for, pattern, modelled_on }) => ({ name, title, use_for, pattern, modelled_on })),
      usage: "Choose by use_for: the example made for the nearest request, before you choose a mechanism. Call cad_examples with that name to read its concept and script. Adapt the form and pattern to the request and to the product the person means; do not paste an example's sizes onto a different object.",
    };
  if (typeof args.name !== "string") throw new Error("name must be a string.");
  const found = all.find((e) => e.name === args.name);
  if (!found) throw new Error(`No example named ${JSON.stringify(args.name)}. Examples: ${all.map((e) => e.name).join(", ")}.`);
  return { ...found };
}
