/**
 * Whether the printer can feed a multi-colour slice itself (beta 8 DAD replay, Nov 17): a two-colour 3MF sliced for a
 * P1S with no AMS succeeded with 85 filament changes and no word, so a tester would have been sent a print that stops
 * 85 times for a manual swap. Shared by bambu-printer-mcp and mcp-3D-printer-server.
 *
 * How the printer's feeds are known (the judgement, written down):
 * - Feeds are the AMS trays the printer reports (every tray of every AMS unit, loaded or not: a person can load an
 *   empty one). Without an AMS, its external spool holders, one per nozzle (two on a dual-nozzle model). A print
 *   doesn't mix the external spool with AMS trays, so the two are not added.
 * - Known only from a connected printer's report that carries its AMS block; one that lists no AMS unit in it means
 *   no AMS. A report without the block says nothing. The model alone never decides it: every model's AMS is
 *   optional.
 * - Counted per plate: a project whose plates each print in one colour needs no change, and a slice that reports no
 *   filament change is never refused.
 * - Unknown when there are no printer credentials, the printer can't be reached, the caller said
 *   use_printer_filaments: false, or the printer isn't a Bambu. Then the slice succeeds, flagged: the colours and the
 *   filament changes are in the result and its message, so a client never sends it on silently.
 * - Known too few feeds: the slice is refused with needs-more-filaments, as 1.1.97 refuses more colours than slots,
 *   unless the caller says the person will change filament by hand (manual_filament_changes: true).
 */
import { FilamentSlotsError } from "../refusal.js";

export interface PrinterFeed {
  known: boolean;
  /** AMS trays the printer reports (0: no AMS). */
  ams_slots: number;
  /** External spool holders: one per nozzle. */
  external: number;
  /** How it was known, or why it isn't. */
  source: string;
}

/** The feeds a connected Bambu printer's raw report shows. */
export function feedFromBambuReport(raw: unknown, connected: boolean, dualNozzle: boolean): PrinterFeed {
  const report = raw && typeof raw === "object" ? raw as Record<string, unknown> : undefined;
  const external = dualNozzle ? 2 : 1;
  const block = report?.ams && typeof report.ams === "object" ? report.ams as Record<string, unknown> : undefined;
  if (!connected || !block) return { known: false, ams_slots: 0, external, source: connected ? "the printer's report has no AMS block yet" : "the printer's report could not be read" };
  const units = Array.isArray(block.ams) ? block.ams : [];
  // A unit's own tray list when it reports one (an AMS HT has one); four, as an AMS has, when it doesn't.
  const slots = units.reduce((sum: number, unit) => sum + (Array.isArray((unit as { tray?: unknown })?.tray) ? (unit as { tray: unknown[] }).tray.length : 4), 0);
  return { known: true, ams_slots: slots, external, source: slots ? `the printer reports ${units.length} AMS unit${units.length === 1 ? "" : "s"}` : "the printer reports no AMS" };
}

export const UNKNOWN_FEED = (source: string, dualNozzle = false): PrinterFeed => ({ known: false, ams_slots: 0, external: dualNozzle ? 2 : 1, source });

/**
 * The colours a slice prints with and its filament changes, from Bambu Studio / OrcaSlicer's result.json: the plate
 * with the most colours (each plate prints on its own), and its filament changes.
 */
export function sliceColours(result: unknown): { colours: number; changes: number | undefined } {
  const plates = result && typeof result === "object" && Array.isArray((result as { sliced_plates?: unknown }).sliced_plates)
    ? (result as { sliced_plates: Record<string, unknown>[] }).sliced_plates : [];
  let best = { colours: 0, changes: undefined as number | undefined };
  for (const plate of plates) {
    const used = new Set<number>();
    for (const f of Array.isArray(plate?.filaments) ? plate.filaments as Record<string, unknown>[] : [])
      if (typeof f?.id === "number" && (typeof f.total_used_g !== "number" || f.total_used_g > 0)) used.add(f.id);
    const changes = typeof plate?.filament_change_times === "number" ? plate.filament_change_times : undefined;
    if (used.size > best.colours || (used.size === best.colours && (changes ?? 0) > (best.changes ?? 0))) best = { colours: used.size, changes };
  }
  return best;
}

export interface FeedVerdict {
  /** The structured facts every multi-colour slice carries (additive). */
  facts?: { colours: number; filament_changes?: number; printer: "feeds-all" | "too-few-feeds" | "unknown"; feeds?: number; source: string; manual?: true };
  /** A sentence for slicer_report.message on a slice that worked. */
  note?: string;
  /** The refusal, when the printer is known not to feed the colours and the caller didn't accept manual changes. */
  refusal?: FilamentSlotsError;
}

/** The verdict on one slice: nothing for a one-colour slice. */
export function feedVerdict(result: unknown, feed: PrinterFeed, manual: boolean): FeedVerdict {
  const { colours, changes } = sliceColours(result);
  // One colour on every plate, or a slice that changes filament nowhere, stops for nothing.
  if (colours < 2 || changes === 0) return {};
  const feeds = feed.ams_slots > 0 ? feed.ams_slots : feed.external;
  const base = { colours, ...(changes !== undefined ? { filament_changes: changes } : {}), source: feed.source };
  const stops = changes !== undefined ? `${changes} time${changes === 1 ? "" : "s"}` : "at each colour change";
  if (!feed.known)
    return { facts: { ...base, printer: "unknown" },
      note: `This prints in ${colours} colours${changes !== undefined ? ` and changes filament ${changes} time${changes === 1 ? "" : "s"}` : ""}. Without an AMS, the printer stops ${changes !== undefined ? "for each change" : "at each colour change"} for you to swap filament: print it in one colour, or each colour as its own part.` };
  if (feeds >= colours) return { facts: { ...base, printer: "feeds-all", feeds } };
  const plain = feed.ams_slots === 0
    ? `This prints in ${colours} colours. Your printer has no AMS, so it would stop ${stops} for you to change filament. Print it in one colour instead, or print each colour as its own part.`
    : `This prints in ${colours} colours, but your printer can hold ${feeds} filaments, so it would stop for you to change filament by hand. Print it in fewer colours, or print each colour as its own part.`;
  if (manual)
    return { facts: { ...base, printer: "too-few-feeds", feeds, manual: true },
      note: feed.ams_slots === 0 ? `Your printer has no AMS, so this print stops ${stops} for you to change filament.` : `This print stops for you to change filament by hand.` };
  const facts = { ...base, printer: "too-few-feeds" as const, feeds };
  const refusal = new FilamentSlotsError(colours, feeds, { plain, changes });
  refusal.feed = facts;
  return { facts, refusal };
}
