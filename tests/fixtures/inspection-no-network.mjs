import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const blocked = () => {
  appendFileSync(process.env.INSPECTION_NETWORK_LOG, 'attempted network operation\n');
  throw new Error('Network operations are forbidden in offline inspection tests');
};
net.Socket.prototype.connect = blocked;
net.connect = blocked;
net.createConnection = blocked;
tls.connect = blocked;
dgram.Socket.prototype.send = blocked;
dgram.Socket.prototype.connect = blocked;
syncBuiltinESMExports();
