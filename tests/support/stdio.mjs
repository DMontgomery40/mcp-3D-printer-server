// The SDK's close can return after sending SIGKILL, before the child closes.
// Teardown must join that lifecycle before file hooks remove fixtures or the guard inspects TMPDIR.
import {StdioClientTransport as SDKTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

export class StdioClientTransport extends SDKTransport {
  async start() {
    const onclose = this.onclose;
    let closed;
    this.serverClosed = new Promise(resolve => { closed = resolve; });
    this.onclose = () => { closed(); onclose?.(); };
    try {
      await super.start();
    } catch (error) {
      closed();
      throw error;
    }
  }

  close() {
    this.closing ??= (async () => {
      await super.close();
      await this.serverClosed;
    })();
    return this.closing;
  }
}

// Raw HTTP-process helpers need the same join, including after timeout escalation.
export async function terminateChildProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise(resolve => child.once('close', resolve));
  const escalation = setTimeout(() => child.kill('SIGKILL'), 2000);
  child.kill('SIGTERM');
  try { await closed; }
  finally { clearTimeout(escalation); }
}
