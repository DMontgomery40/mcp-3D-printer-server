/**
 * Merging Bambu MQTT reports. P1/A1 printers push only what changed, so a merged report keeps every field until the
 * printer sends it again. A new job's first pushes can carry its name and layer count before its layer number, and the
 * previous job's last layer then read against the new total ("315/150"). Until the new job reports its own progress,
 * its report has none.
 */

/**
 * Fields that name the job a report describes. The layer count is not one: a running job's count can be revised, and a
 * different job differs in its name, file or task id.
 */
const JOB_FIELDS = ["subtask_name", "gcode_file", "task_id"] as const;
/** A new job prepares (PREPARE, SLICING) after any end; RUNNING straight after FAILED is that job resuming. */
const PREPARING = new Set(["PREPARE", "SLICING"]);
const DONE = new Set(["FINISH", "IDLE"]);

/** The previous job's progress, left out of a new job's report until the printer reports the new job's own. */
const JOB_PROGRESS = ["layer_num", "mc_percent", "mc_remaining_time"] as const;

/** A job field's value, or undefined for a placeholder: empty, or 0 (LAN prints report task_id "0"). */
function named(value: unknown): string | undefined {
  const text = value === undefined || value === null ? "" : String(value).trim();
  return text === "" || text === "0" ? undefined : text;
}

/** True when update describes a different job than the report merged before it. */
export function startsNewJob(previous: Record<string, any> | undefined, update: Record<string, any>): boolean {
  if (!previous) return false;
  for (const field of JOB_FIELDS) {
    const before = named(previous[field]), after = named(update[field]);
    if (before !== undefined && after !== undefined && before !== after) return true;
  }
  const before = String(previous.gcode_state), after = String(update.gcode_state);
  return (DONE.has(before) || before === "FAILED") && PREPARING.has(after) || DONE.has(before) && after === "RUNNING";
}

/** The previous job's progress fields to leave out when update starts a new job without reporting them. */
export function newJobResets(previous: Record<string, any> | undefined, update: Record<string, any>): string[] {
  if (!startsNewJob(previous, update)) return [];
  return JOB_PROGRESS.filter(field => update[field] === undefined && previous?.[field] !== undefined);
}

/** The fields of a merged report that newJobResets compares against the next update. */
export function jobIdentity(report: Record<string, any>): Record<string, any> {
  return Object.fromEntries([...JOB_FIELDS, "gcode_state", ...JOB_PROGRESS].map(field => [field, report[field]]));
}
