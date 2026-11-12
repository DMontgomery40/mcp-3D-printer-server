/**
 * Merging Bambu MQTT reports. P1/A1 printers push only what changed, so a merged report keeps every field until the
 * printer sends it again. A new job's first pushes can carry its name and layer count before its layer number, and the
 * previous job's last layer then read against the new total ("315/150").
 */

/** Fields that name the job a report describes. */
const JOB_FIELDS = ["subtask_name", "gcode_file", "task_id", "total_layer_num"] as const;
const ENDED = new Set(["FINISH", "FAILED", "IDLE"]);
const STARTING = new Set(["PREPARE", "SLICING", "RUNNING"]);

/** The previous job's progress, which a new job restarts until the printer reports its own. */
const JOB_PROGRESS: Record<string, number | undefined> = { layer_num: 0, mc_percent: 0, mc_remaining_time: undefined };

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
  return ENDED.has(String(previous.gcode_state)) && STARTING.has(String(update.gcode_state));
}

/**
 * The fields to set when update merges into previous: for a new job, the layer and percentage it did not send start
 * at 0, and a remaining time it did not send is dropped. Nothing for the same job.
 */
export function newJobResets(previous: Record<string, any> | undefined, update: Record<string, any>): Record<string, number | undefined> {
  if (!startsNewJob(previous, update)) return {};
  return Object.fromEntries(Object.entries(JOB_PROGRESS).filter(([field]) => update[field] === undefined && previous?.[field] !== undefined));
}

/** The fields of a merged report that newJobResets compares against the next update. */
export function jobIdentity(report: Record<string, any>): Record<string, any> {
  return Object.fromEntries([...JOB_FIELDS, "gcode_state", ...Object.keys(JOB_PROGRESS)].map(field => [field, report[field]]));
}
