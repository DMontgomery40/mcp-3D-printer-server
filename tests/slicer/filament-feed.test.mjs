import test from "node:test";
import assert from "node:assert/strict";
import { feedFromBambuReport, feedVerdict, sliceColours, UNKNOWN_FEED } from "../../dist/slicer/filament-feed.js";

const plate = (filaments, changes) => ({ sliced_plates: [{ id: 1, filament_change_times: changes, filaments: filaments.map((g, i) => ({ id: i + 1, total_used_g: g })) }] });

// How a printer's feeds are known (src/slicer/filament-feed.ts): a connected full report, AMS trays plus external spools.
test("feedFromBambuReport reads AMS trays and external spools only from a connected full report", () => {
  assert.equal(feedFromBambuReport({ gcode_state: "IDLE" }, false, false).known, false, "not connected");
  assert.equal(feedFromBambuReport({ nozzle_temper: 20 }, true, false).known, false, "a sparse push says nothing about the AMS");
  assert.equal(feedFromBambuReport({ gcode_state: "IDLE" }, true, false).known, false, "nor does a report without its AMS block");
  assert.deepEqual(feedFromBambuReport({ gcode_state: "IDLE", ams: { ams: [], ams_exist_bits: "0" } }, true, false),
    { known: true, ams_slots: 0, external: 1, source: "the printer reports no AMS" });
  assert.deepEqual(feedFromBambuReport({ ams: { ams: [] } }, true, true), { known: true, ams_slots: 0, external: 2, source: "the printer reports no AMS" });
  const two = { ams: { ams: [{ id: "0", tray: [{}, {}, {}, {}] }, { id: "128", tray: [{}] }] } };
  assert.equal(feedFromBambuReport({ ams: { ams: [{ id: "0", tray: [] }] } }, true, false).ams_slots, 0, "a unit reporting no trays counts none");
  assert.deepEqual(feedFromBambuReport(two, true, false), { known: true, ams_slots: 5, external: 1, source: "the printer reports 2 AMS units" });
});

test("sliceColours counts the filaments a slice uses and its filament changes", () => {
  assert.deepEqual(sliceColours(plate([69.4, 43.8], 85)), { colours: 2, changes: 85 });
  assert.deepEqual(sliceColours(plate([69.4, 0], 0)), { colours: 1, changes: 0 }, "a declared filament no part uses is not a colour");
  assert.deepEqual(sliceColours(undefined), { colours: 0, changes: undefined });
  // Each plate prints on its own: two one-colour plates are not a two-colour print.
  assert.deepEqual(sliceColours({ sliced_plates: [{ id: 1, filament_change_times: 0, filaments: [{ id: 1, total_used_g: 5 }] },
    { id: 2, filament_change_times: 0, filaments: [{ id: 2, total_used_g: 5 }] }] }), { colours: 1, changes: 0 });
});

test("feedVerdict refuses colours the printer can't feed, flags an unknown printer, and accepts manual changes", () => {
  const noAms = feedFromBambuReport({ gcode_state: "IDLE", ams: { ams: [] } }, true, false);
  const dad = feedVerdict(plate([69.4, 43.8], 85), noAms, false);
  assert.equal(dad.refusal.code, "needs-more-filaments");
  assert.deepEqual([dad.refusal.colours, dad.refusal.slots, dad.refusal.changes], [2, 1, 85]);
  assert.equal(dad.refusal.plain, "This prints in 2 colours. Your printer has no AMS, so it would stop 85 times for you to change filament. Print it in one colour instead, or print each colour as its own part.");
  assert.deepEqual(dad.refusal.feed, dad.facts);
  // A dual-nozzle printer with no AMS feeds two colours from its two external spools.
  assert.equal(feedVerdict(plate([10, 10], 40), feedFromBambuReport({ ams: { ams: [] } }, true, true), false).facts.printer, "feeds-all");
  // One AMS (4 trays) feeds four colours, not five: a print doesn't mix the external spool with AMS trays.
  const ams = feedFromBambuReport({ ams: { ams: [{ tray: [{}, {}, {}, {}] }] } }, true, false);
  assert.equal(feedVerdict(plate([1, 1, 1, 1], 9), ams, false).facts.printer, "feeds-all");
  assert.match(feedVerdict(plate([1, 1, 1, 1, 1], 9), ams, false).refusal.plain, /^This prints in 5 colours, but your printer can hold 4 filaments, so it would stop for you to change filament by hand\./);
  // A slice that changes filament nowhere stops for nothing.
  assert.deepEqual(feedVerdict(plate([10, 10], 0), noAms, false), {});
  // Unknown: a flagged success with the changes in its sentence.
  const unknown = feedVerdict(plate([69.4, 43.8], 85), UNKNOWN_FEED("no printer is configured to ask"), false);
  assert.equal(unknown.refusal, undefined);
  assert.deepEqual(unknown.facts, { colours: 2, filament_changes: 85, source: "no printer is configured to ask", printer: "unknown" });
  assert.match(unknown.note, /changes filament 85 times\. Without an AMS, the printer stops for each change/);
  // Manual changes accepted: the slice stands, and says how often it stops.
  assert.equal(feedVerdict(plate([69.4, 43.8], 85), noAms, true).note, "Your printer has no AMS, so this print stops 85 times for you to change filament.");
  // One colour: nothing to say.
  assert.deepEqual(feedVerdict(plate([100], 0), noAms, false), {});
});
