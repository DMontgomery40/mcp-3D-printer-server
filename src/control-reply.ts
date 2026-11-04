/**
 * The printer's answer to Pause, Resume or Stop, shared by every route (FULU's local network and Bambu Cloud,
 * and the direct local network a printer in LAN Only + Developer Mode takes).
 */

export type ControlReply = { accepted: boolean; errCode: number };

/**
 * The printer's answer to a control it was sent: it echoes command and sequence_id, with
 * err_code set when it refuses. A P1S on authorization firmware signs it: {"header":{...},"print":{...}}.
 */
export function controlReply(msg: unknown, command: string, sequenceId: string): ControlReply | undefined {
  if (typeof msg !== "string" || !msg.includes(sequenceId)) return undefined;
  let print: any;
  try { print = JSON.parse(msg)?.print; } catch { return undefined; }
  if (print?.command !== command || String(print.sequence_id) !== sequenceId) return undefined;
  const errCode = Number(print.err_code ?? 0) || 0;
  const failed = typeof print.result === "string" && print.result.toLowerCase() !== "success";
  return { accepted: errCode === 0 && !failed, errCode };
}

/**
 * The printer's authorization check refused the command (0x05024007-0x0502400B: unsigned, certificate not
 * trusted, malformed header, signature rejected). On a P1S 01.10.00.00 FULU's plug-in gets 0x0502400A for every
 * Pause and Stop over LAN and Bambu Cloud, while Bambu Studio and Bambu Handy are accepted.
 */
export function isAuthorizationRefusal(errCode: number): boolean {
  const code = errCode >>> 0;
  return code >= 0x05024007 && code <= 0x0502400B;
}

/** What to tell a person about a refused control. direct: the control went straight to the printer (Developer Mode connection). */
export function refusedControlMessage(command: string, route: string, errCode: number, direct = false): string {
  const word = `${command[0]!.toUpperCase()}${command.slice(1)}`;
  const code = (errCode >>> 0).toString(16).toUpperCase().padStart(8, "0");
  if (!isAuthorizationRefusal(errCode)) return `The printer refused ${word} over ${route} (error ${code}). Nothing changed on the printer.`;
  return direct
    ? `The printer refused ${word} (error ${code}): it isn't in LAN Only and Developer Mode, so it takes Pause, Resume and Stop only from Bambu Studio or Bambu Handy. ` +
      "Use one of those now, or turn on LAN Only and Developer Mode on the printer."
    : `The printer refused ${word} (error ${code}): in its current mode it takes Pause, Resume and Stop only from Bambu Studio or Bambu Handy. ` +
      "Use one of those now. To use them from here, turn on LAN Only and Developer Mode on the printer and choose the Developer Mode connection.";
}
