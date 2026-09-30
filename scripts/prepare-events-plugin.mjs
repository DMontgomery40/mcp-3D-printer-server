import {cpSync,existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {isAbsolute,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
export function preparePlugin(url,destination) {
 const endpoint=new URL(url);
 if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.port||endpoint.search||endpoint.hash||endpoint.pathname!=='/mcp'||!isAbsolute(destination))throw new Error('Use the approved HTTPS /mcp endpoint and an absolute new output directory');
 if(existsSync(destination))throw new Error('Output directory already exists; nothing is overwritten');
 const template=fileURLToPath(new URL('../plugins/print-events/',import.meta.url));
 mkdirSync(destination,{recursive:true});cpSync(template,destination,{recursive:true});
 const manifest=JSON.parse(readFileSync(resolve(destination,'plugin.json'),'utf8'));
 writeFileSync(resolve(destination,'mcp.json'),JSON.stringify({$schema:'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',mcpServers:{'printer-events':{type:'streamable-http',url:endpoint.href}}},null,2)+'\n');
 return {name:manifest.name,endpoint:endpoint.href,directory:destination};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
 const [url,destination]=process.argv.slice(2);if(!url||!destination)throw new Error('Usage: node scripts/prepare-events-plugin.mjs APPROVED_HTTPS_MCP_URL ABSOLUTE_NEW_DIRECTORY');
 console.log(JSON.stringify(preparePlugin(url,destination)));
}
