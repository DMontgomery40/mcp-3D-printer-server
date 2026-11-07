import fs from "node:fs/promises";
import type { Client as FTPClient } from "basic-ftp";

/**
 * How long a print upload may wait for the printer to take more data before it is
 * reported as stalled. A P1S writing a large file to its SD card pauses mid-file
 * for longer than the 15 s used for FTP commands: an 18.4 MB plate stopped at
 * 13.3 MB for over 15 s (2026-11-06), while 4.6 and 11.5 MB files went through
 * at 130-160 KiB/s. A printer that has really stopped is still reported, after this.
 */
export const FTP_UPLOAD_STALL_MS = 120_000;

/**
 * Upload a local file, allowing the printer's SD card to pause, and report bytes sent.
 *
 * basic-ftp streams the file in 64 KiB reads, and its TransferWatchdog reports a stall
 * ("Timeout (data socket)") when the data socket stops making progress for the client's
 * timeout, read when the transfer starts. That limit is raised to stallMs for this
 * transfer (and the wait for the printer's 226 after it) and restored afterwards, so
 * other commands keep theirs.
 */
export async function uploadFile(client: FTPClient, localPath: string, remotePath: string,
  { stallMs = FTP_UPLOAD_STALL_MS, onProgress }: { stallMs?: number; onProgress?: (sent: number, total: number) => void } = {}): Promise<void> {
  // Typed readonly, but a plain property that basic-ftp 6.x reads when each transfer starts
  // (TransferResolver.onDataStart/onDataDone); tests/ftp-upload.test.mjs fails if that changes.
  const context = client.ftp as { timeout: number };
  const commandTimeout = context.timeout;
  context.timeout = Math.max(commandTimeout, stallMs);
  const total = onProgress ? (await fs.stat(localPath)).size : 0;
  if (onProgress) {
    onProgress(0, total);
    client.trackProgress(info => { if (info.type === "upload") onProgress(Math.min(info.bytes, total), total); });
  }
  try {
    await client.uploadFrom(localPath, remotePath);
    onProgress?.(total, total);
  } finally {
    context.timeout = commandTimeout;
    if (onProgress) client.trackProgress();
  }
}
