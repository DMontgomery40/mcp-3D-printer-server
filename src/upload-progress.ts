/** counterpart/1: the `_meta` key and value that mark a print_3mf progress notification as the file upload. */
export const UPLOAD_STAGE_META = { "counterpart/stage": "upload" } as const;

export interface UploadProgressParams {
  progress: number;
  total: number;
  message: string;
  _meta: typeof UPLOAD_STAGE_META;
}

/**
 * Turns bytes sent over FTPS into MCP progress params: progress = bytes sent, total = file bytes,
 * marked as the upload stage, at most once per whole percent so a slow upload doesn't flood the client.
 */
export function uploadProgressReporter(send: (params: UploadProgressParams) => void): (sent: number, total: number) => void {
  let last = -1;
  return (sent, total) => {
    const percent = total > 0 ? Math.floor(sent * 100 / total) : 100;
    if (percent === last) return;
    last = percent;
    send({ progress: sent, total, message: `Sending to the printer: ${percent}%`, _meta: UPLOAD_STAGE_META });
  };
}
