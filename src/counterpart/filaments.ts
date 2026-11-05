/**
 * counterpart_propose_filaments (counterpart/1): which loaded spool prints each of a model's colours, proposed before
 * slicing. Nearest colour in OKLab with the asked-for material preferred; one print feeds from one source. Each spool
 * carries the words a person reads ("A2", "Sunflower Yellow PLA Basic") and every part an explicit verdict, so a client
 * renders the result instead of re-deriving it. Pure: the server supplies the live trays.
 */
import fs from "node:fs";
import path from "node:path";
import { COUNTERPART_CONTRACT } from "./contract.js";

/** One loaded spool as a client shows it. `feed` groups the spools that can feed one print together. */
export type ProposalTray = {
  slot: number; label: string; name: string; colour: string; material: string; filamentId: string; feed: string;
  /** This server can slice with it (a filament profile is resolved for it). */
  sliceable: boolean;
  /** The resolved slicer filament profile (absolute path), the one slice_stl takes in load_filaments. */
  profile?: string;
};
export type ProposalFilament = { index: number; name?: string; colour?: string; material?: string };
/** A filament slot no part names (a painted region): it follows the chosen spools' feed. `prints` false: not on this plate. */
export type PaintedFilament = { index: number; colour?: string; material?: string; prints?: boolean };
export type ChosenSpool = { index: number; slot: number; colour?: string; material?: string; filamentId?: string };
export type Verdict = "same-colour" | "closest" | "no-colour" | "none";
export type ProposalRow = {
  index: number; slot?: number; verdict: Verdict; distance?: number; materialMismatch?: boolean;
  /** What the person should know about this suggestion, in their words. */
  note?: string;
};
export type ProposalProblem = { code: string; message: string; index?: number };
export type FilamentProposal = {
  contract: typeof COUNTERPART_CONTRACT;
  /** The spools a person may choose from: every loaded one for a sliced file, the sliceable ones otherwise. */
  trays: ProposalTray[];
  proposal: ProposalRow[];
  /** Every filament slot (parts and painted) to its spool, when the proposal or the person's choice is printable. */
  mapping?: Array<{ index: number; slot: number }>;
  problems: ProposalProblem[];
};

/** A colour this close (OKLab) to the asked-for one is the same colour to a person. */
export const SAME_COLOUR = 0.08;
const MATERIAL_PENALTY = 0.15;
const REUSE_PENALTY = 0.1;
const DISTINCT = 0.05;

function oklab(hex: string): [number, number, number] | undefined {
  const match = /^#?([0-9a-fA-F]{6})(?:[0-9a-fA-F]{2})?$/.exec(hex.trim());
  if (!match) return undefined;
  const value = Number.parseInt(match[1]!, 16);
  const linear = (channel: number) => { const s = channel / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  const r = linear(value >> 16 & 255), g = linear(value >> 8 & 255), b = linear(value & 255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s, 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s];
}

/** Perceptual distance between two `#RRGGBB` colours (0 identical, about 1 black to white). Alpha is ignored. */
export function colourDistance(a: string, b: string): number {
  const left = oklab(a), right = oklab(b);
  if (!left || !right) return Number.POSITIVE_INFINITY;
  return Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2]);
}

type Match = { slot: number; distance?: number; materialMismatch?: boolean; guessed?: boolean };
const materialOf = (value: string | undefined) => value?.trim().toUpperCase() || undefined;

function pick(filament: { colour?: string; material?: string }, loaded: ProposalTray[], assigned: Map<number, string[]>, requireMaterial: boolean): Match | undefined {
  if (!loaded.length) return undefined;
  const wanted = materialOf(filament.material);
  const mismatch = (tray: ProposalTray) => wanted !== undefined && materialOf(tray.material) !== wanted;
  const eligible = requireMaterial && wanted ? loaded.filter(tray => !mismatch(tray)) : loaded;
  if (!eligible.length) return undefined;
  const target = filament.colour ? oklab(filament.colour) : undefined;
  if (!target) {
    const free = eligible.filter(tray => !assigned.has(tray.slot));
    const pool = free.length ? free : eligible;
    const chosen = pool.find(tray => !mismatch(tray)) ?? pool[0]!;
    assigned.set(chosen.slot, [...(assigned.get(chosen.slot) ?? [])]);
    return { slot: chosen.slot, guessed: true, ...(mismatch(chosen) ? { materialMismatch: true } : {}) };
  }
  let best: { tray: ProposalTray; distance: number; score: number } | undefined;
  for (const tray of eligible) {
    const distance = colourDistance(filament.colour!, tray.colour);
    const shared = (assigned.get(tray.slot) ?? []).some(colour => colourDistance(colour, filament.colour!) > DISTINCT);
    const score = distance + (mismatch(tray) ? MATERIAL_PENALTY : 0) + (shared ? REUSE_PENALTY : 0);
    if (!best || score < best.score || (score === best.score && tray.slot < best.tray.slot)) best = { tray, distance, score };
  }
  assigned.set(best!.tray.slot, [...(assigned.get(best!.tray.slot) ?? []), filament.colour!]);
  return { slot: best!.tray.slot, distance: best!.distance, ...(mismatch(best!.tray) ? { materialMismatch: true } : {}) };
}

/**
 * One match per filament, in order; undefined where nothing can serve it. Several filaments of one colour may share a
 * spool. With `requireMaterial` (an already-sliced file) only spools of the asked-for material qualify. Automatic matches
 * never mix feeds: the first feed listed (the AMS) is preferred, another feed only when it alone serves every colour.
 */
export function matchColours(model: Array<{ colour?: string; material?: string }>, trays: ProposalTray[], options: { requireMaterial?: boolean } = {}): (Match | undefined)[] {
  const loaded = trays.filter(tray => oklab(tray.colour));
  const run = (pool: ProposalTray[]) => { const assigned = new Map<number, string[]>(); return model.map(filament => pick(filament, pool, assigned, !!options.requireMaterial)); };
  const matches = run(loaded);
  const feedOf = new Map(loaded.map(tray => [tray.slot, tray.feed]));
  const feeds = [...new Set(loaded.map(tray => tray.feed))];
  if (new Set(matches.flatMap(match => match ? [feedOf.get(match.slot)] : [])).size <= 1) return matches;
  const perFeed = feeds.map(feed => run(loaded.filter(tray => tray.feed === feed)));
  return perFeed.find(result => result.every(match => match)) ?? perFeed[0]!;
}

/** The colour names Bambu Studio itself uses for its filaments (profiles/BBL/filament/filaments_color_codes.json). */
export type ColourNames = { spool(filamentId: string, colour: string): string | undefined; colour(colour: string): string | undefined };
export const NO_COLOUR_NAMES: ColourNames = { spool: () => undefined, colour: () => undefined };

export function loadColourNames(filamentProfileDir: string | undefined): ColourNames {
  if (!filamentProfileDir) return NO_COLOUR_NAMES;
  let data: unknown;
  try {
    const file = path.join(filamentProfileDir, "filaments_color_codes.json");
    if (fs.statSync(file).size > 8 * 1024 * 1024) return NO_COLOUR_NAMES;
    data = (JSON.parse(fs.readFileSync(file, "utf8")) as { data?: unknown }).data;
  } catch { return NO_COLOUR_NAMES; }
  if (!Array.isArray(data)) return NO_COLOUR_NAMES;
  const byId = new Map<string, string>(), byColour = new Map<string, string>();
  for (const entry of data) {
    const colours = Array.isArray(entry?.fila_color) ? entry.fila_color : [];
    const name = typeof entry?.fila_color_name?.en === "string" ? entry.fila_color_name.en.trim().slice(0, 64) : "";
    const id = typeof entry?.fila_id === "string" ? entry.fila_id.trim().toUpperCase() : "";
    // Single colours only: a gradient or multi-colour spool's first colour is not its name.
    if (colours.length !== 1 || typeof colours[0] !== "string" || !name || !/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(colours[0])) continue;
    const hex8 = (colours[0].slice(1) + "FF").slice(0, 8).toUpperCase();
    if (id && !byId.has(`${id}#${hex8}`)) byId.set(`${id}#${hex8}`, name);
    if (id && !byId.has(`${id}#${hex8.slice(0, 6)}`)) byId.set(`${id}#${hex8.slice(0, 6)}`, name);
    // A bare colour's name: the shortest Bambu uses for exactly that opaque colour ("White", not "Jade White").
    if (hex8.endsWith("FF")) {
      const key = hex8.slice(0, 6), known = byColour.get(key);
      if (!known || name.length < known.length) byColour.set(key, name);
    }
  }
  const hex = (value: string) => value.replace(/^#/, "").toUpperCase();
  return {
    spool: (filamentId, colour) => byId.get(`${filamentId.toUpperCase()}#${hex(colour)}`) ?? byId.get(`${filamentId.toUpperCase()}#${hex(colour).slice(0, 6)}`),
    colour: colour => byColour.get(hex(colour).slice(0, 6)),
  };
}

/** Where a Bambu tray sits, as Bambu Studio labels it: AMS units A–D with trays 1–4, AMS HT units by letter. */
export function bambuTrayLabel(amsId: number, trayId: number): string {
  const letter = (n: number) => String.fromCharCode(65 + Math.max(0, Math.min(n, 25)));
  return amsId >= 128 ? `AMS HT ${letter(amsId - 128)}` : `${letter(amsId)}${trayId + 1}`;
}

/** A spool's name: its colour name (when Bambu names it) and product ("Sunflower Yellow PLA Basic"), else the product. */
export function spoolName(product: string, colourName: string | undefined): string {
  return (colourName ? `${colourName} ${product}` : product).trim().slice(0, 128);
}

const partName = (filament: ProposalFilament) => filament.name?.trim() || `Part ${filament.index}`;

export function proposeFilaments(input: {
  trays: ProposalTray[]; filaments: ProposalFilament[]; painted?: PaintedFilament[]; chosen?: ChosenSpool[]; sliced?: boolean; names?: ColourNames;
}): FilamentProposal {
  const names = input.names ?? NO_COLOUR_NAMES;
  const sliced = !!input.sliced;
  const live = input.trays;
  const menu = sliced ? live : live.filter(tray => tray.sliceable);
  const problems: ProposalProblem[] = [];
  const result = (proposal: ProposalRow[], mapping?: Array<{ index: number; slot: number }>): FilamentProposal =>
    ({ contract: COUNTERPART_CONTRACT, trays: menu, proposal, ...(mapping && !problems.length ? { mapping } : {}), problems });
  const describe = (tray: ProposalTray) => `${tray.label} ${tray.name}`;
  const colourWords = (colour: string) => names.colour(colour) ?? colour.toUpperCase();

  // A sliced file's painted slots need their material on the same feed: they take part in choosing the feed,
  // so the proposal never picks a feed that can't print them when another one can.
  const required = sliced ? (input.painted ?? []).filter(slot => slot.material && slot.prints !== false
    && !input.filaments.some(filament => filament.index === slot.index)) : [];
  const matches = matchColours([...input.filaments, ...required], menu, { requireMaterial: sliced }).slice(0, input.filaments.length);
  const proposal: ProposalRow[] = input.filaments.map((filament, i) => {
    const match = matches[i];
    if (!match) return { index: filament.index, verdict: "none" as const };
    const tray = menu.find(item => item.slot === match.slot)!;
    const row: ProposalRow = { index: filament.index, slot: match.slot,
      verdict: match.guessed ? "no-colour" : (match.distance ?? 0) <= SAME_COLOUR ? "same-colour" : "closest",
      ...(match.distance !== undefined ? { distance: match.distance } : {}), ...(match.materialMismatch ? { materialMismatch: true } : {}) };
    if (row.verdict === "no-colour") row.note = "The model doesn’t say this part’s colour — pick its spool.";
    else if (row.verdict === "closest") {
      // The colour may be loaded but not chosen: on another feed (one print feeds from one source), in another
      // material, or on a spool another colour of this model already prints from. Say which, never "isn't loaded".
      const words = colourWords(filament.colour!);
      const loaded = menu.find(item => item.slot !== tray.slot && colourDistance(item.colour, filament.colour!) <= SAME_COLOUR);
      const wanted = materialOf(filament.material);
      row.note = !loaded ? `${words} isn’t loaded. Closest loaded: ${describe(tray)}.`
        : loaded.feed !== tray.feed ? `${words} is loaded on ${loaded.label}, but one print feeds from one source. Closest here: ${describe(tray)}.`
        : wanted && materialOf(loaded.material) !== wanted ? `${words} is loaded on ${loaded.label} in ${loaded.material}, not ${filament.material}. Closest in ${filament.material}: ${describe(tray)}.`
        : `${words} is on ${loaded.label}, which another colour of this model already prints from. Closest other spool: ${describe(tray)}.`;
    }
    if (match.materialMismatch) row.note = `${row.note ? row.note + " " : ""}Prints in ${tray.material}, not ${filament.material}.`;
    return row;
  });

  if (!input.filaments.length) return result(proposal);
  // The spools that will print, in filament order: the person's choices, validated, or the proposal.
  let chosen: ProposalTray[];
  if (input.chosen) {
    if (input.chosen.length !== input.filaments.length || input.filaments.some((filament, i) => input.chosen![i]!.index !== filament.index)) {
      problems.push({ code: "choices-incomplete", message: "Choose a spool for every colour in this model, then try again." });
      return result(proposal);
    }
    chosen = [];
    for (const [i, choice] of input.chosen.entries()) {
      const tray = live.find(item => item.slot === choice.slot);
      const filament = input.filaments[i]!;
      if (!tray || (choice.colour !== undefined && choice.colour.toUpperCase() !== tray.colour.toUpperCase())
          || (choice.material !== undefined && materialOf(choice.material) !== materialOf(tray.material)) || (choice.filamentId !== undefined && choice.filamentId !== tray.filamentId)) {
        problems.push({ code: "spool-changed", index: filament.index, message: "A chosen filament changed. Choose the current spools and try again." });
        continue;
      }
      if (sliced && filament.material && materialOf(tray.material) !== materialOf(filament.material))
        problems.push({ code: "sliced-material", index: filament.index, message: `“${partName(filament)}” was sliced for ${filament.material}, so it can only print from a ${filament.material} spool. Choose one, or share the designer’s editable 3MF to change material.` });
      if (!sliced && !tray.sliceable)
        problems.push({ code: "no-profile", index: filament.index, message: `The ${tray.material} spool you chose has no slicing profile on this computer. Choose another spool.` });
      chosen.push(tray);
    }
    if (problems.length) return result(proposal);
    if (new Set(chosen.map(tray => tray.feed)).size > 1) {
      problems.push({ code: "mixed-feeds", message: "One print feeds from one source: put every colour on AMS spools, or every colour on the external spool." });
      return result(proposal);
    }
  } else {
    const missing = matches.findIndex(match => !match);
    if (!menu.length) { problems.push({ code: "nothing-loaded", message: "No filament is loaded. Load a spool in the AMS, then try again." }); return result(proposal); }
    if (missing >= 0) {
      const filament = input.filaments[missing]!;
      const elsewhere = sliced && filament.material && live.some(tray => materialOf(tray.material) === materialOf(filament.material));
      problems.push({ code: elsewhere ? "material-on-another-feed" : "material-not-loaded", index: filament.index, message: elsewhere
        ? `“${partName(filament)}” needs ${filament.material}, but one print feeds from one source and no single source holds every colour’s material. Load the spools on one source, then try again.`
        : sliced && filament.material
          ? `No ${filament.material} spool is loaded for “${partName(filament)}”, and this file was sliced for ${filament.material}. Load one, then try again.`
          : "No filament is loaded. Load a spool in the AMS, then try again." });
      return result(proposal);
    }
    chosen = matches.map(match => menu.find(tray => tray.slot === match!.slot)!);
  }

  const mapping = new Map(input.filaments.map((filament, i) => [filament.index, chosen[i]!.slot]));
  const feed = chosen[0]!.feed;
  const chosenSlots = new Set(chosen.map(tray => tray.slot));
  const primary = live[0]?.feed;
  // A painted slot follows the chosen feed: on the external spool(s) exactly those chosen; on the AMS any AMS spool.
  const fillerPool = menu.filter(tray => feed === primary ? tray.feed === feed : chosenSlots.has(tray.slot));
  for (const painted of input.painted ?? []) {
    if (mapping.has(painted.index)) continue;
    const [match] = matchColours([painted], fillerPool, { requireMaterial: sliced });
    if (match) mapping.set(painted.index, match.slot);
    else if (sliced && painted.material && painted.prints !== false)
      problems.push({ code: "painted-material", index: painted.index, message: `A painted part of this file was sliced for ${painted.material}, and no ${painted.material} spool on the chosen feed source can print it. Load one, then try again.` });
    else mapping.set(painted.index, chosen[0]!.slot);
  }
  return result(proposal, [...mapping.entries()].sort((a, b) => a[0] - b[0]).map(([index, slot]) => ({ index, slot })));
}

const colour = { type: "string", pattern: "^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$" };
export const PROPOSE_FILAMENTS_INPUT_PROPERTIES = {
  filaments: {
    type: "array", maxItems: 64,
    description: "The model's filaments a person sees, in project order: 1-based index, part name, the colour it belongs in and its material when known.",
    items: { type: "object", properties: { index: { type: "integer", minimum: 1, maximum: 64 }, name: { type: "string", maxLength: 256 }, colour, material: { type: "string", maxLength: 64 } }, required: ["index"], additionalProperties: false },
  },
  painted: {
    type: "array", maxItems: 64,
    description: "Filament slots no part names (painted regions). Each follows the chosen spools' feed; prints false when the selected plate never uses it.",
    items: { type: "object", properties: { index: { type: "integer", minimum: 1, maximum: 64 }, colour, material: { type: "string", maxLength: 64 }, prints: { type: "boolean" } }, required: ["index"], additionalProperties: false },
  },
  chosen: {
    type: "array", maxItems: 64,
    description: "The person's spool for each filament, in the same order: checked against what is loaded now. Omit for the proposal alone.",
    items: { type: "object", properties: { index: { type: "integer", minimum: 1, maximum: 64 }, slot: { type: "integer", minimum: 0, maximum: 4095 }, colour, material: { type: "string", maxLength: 128 }, filamentId: { type: "string", maxLength: 128 } }, required: ["index", "slot"], additionalProperties: false },
  },
  sliced: { type: "boolean", description: "The file is already sliced: its materials are fixed, so only spools of the same material qualify." },
} as const;

export const PROPOSE_FILAMENTS_OUTPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    contract: { type: "string", const: COUNTERPART_CONTRACT },
    trays: { type: "array", items: { type: "object", properties: {
      slot: { type: "integer" }, label: { type: "string" }, name: { type: "string" }, colour: { type: "string" }, material: { type: "string" },
      filamentId: { type: "string" }, feed: { type: "string" }, sliceable: { type: "boolean" }, profile: { type: "string" },
    }, required: ["slot", "label", "name", "colour", "material", "filamentId", "feed", "sliceable"] } },
    proposal: { type: "array", items: { type: "object", properties: {
      index: { type: "integer" }, slot: { type: "integer" }, verdict: { type: "string", enum: ["same-colour", "closest", "no-colour", "none"] },
      distance: { type: "number" }, materialMismatch: { type: "boolean" }, note: { type: "string" },
    }, required: ["index", "verdict"] } },
    mapping: { type: "array", items: { type: "object", properties: { index: { type: "integer" }, slot: { type: "integer" } }, required: ["index", "slot"] } },
    problems: { type: "array", items: { type: "object", properties: { code: { type: "string" }, message: { type: "string" }, index: { type: "integer" } }, required: ["code", "message"] } },
  },
  required: ["contract", "trays", "proposal", "problems"],
};
