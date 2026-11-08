// Exercise the public handler with delayed notification delivery and no printer I/O.
import './inspection-no-network.mjs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { BambuImplementation } from '../../dist/printers/bambu.js';
const setRequestHandler = Server.prototype.setRequestHandler;
Server.prototype.setRequestHandler = function (schema, handler) {
  return setRequestHandler.call(this, schema, async (request, extra) => {
    if (request.method !== 'tools/call') return handler(request, extra);
    return handler(request, { ...extra, sendNotification: async notification => {
      await new Promise(resolve => setTimeout(resolve, 25));
      if (process.env.FAIL_UPLOAD_NOTIFICATION === '1' && notification.params.progress === 0) {
        throw new Error('mock progress send failure');
      }
      return extra.sendNotification(notification);
    } });
  });
};
BambuImplementation.prototype.print3mf = async function (_host, _serial, _token, options) {
  options.onUploadProgress?.(0, 100);
  options.onUploadProgress?.(100, 100);
  return { mock: true };
};
