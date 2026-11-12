/** XML output boundary for 3MF metadata; no printer calls or geometry/G-code changes. */
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { SaxesParser } from "saxes";
import { readSafe3mfArchive } from "../safety/archive.js";

/** Encode text for a quoted XML attribute, preserving whitespace through XML parsing. */
export function xmlAttribute(value: string): string {
  const entities: Record<string,string> = {"&":"&amp;",'"':"&quot;","'":"&apos;","<":"&lt;",">":"&gt;","\t":"&#9;","\n":"&#10;","\r":"&#13;"};
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/[&"'<>\t\r\n]/g, char=>entities[char]);
}
const parses = (xml:string) => {
  try {
    let root:string|undefined;
    const parser=new SaxesParser();
    parser.on("error",error=>{throw error;});
    parser.on("opentag",node=>{root ??= node.name;});
    parser.write(xml).close();
    return root === "config";
  } catch { return false; }
};

/** Studio 02.08.02.61 bbs_3mf.cpp writes object opt_serialize values without XML escaping.
 * Only repair its single-line key/value metadata form. Unexpected malformed XML fails closed. */
export async function escapedModelSettings(xml:string):Promise<string> {
  if (Buffer.byteLength(xml)>16*1024*1024) throw Error("3MF model settings exceed the 16 MiB XML limit.");
  if (await parses(xml)) return xml;
  const lines=xml.split(/(?<=\n)/);
  for(let i=0;i<lines.length;i++) {
    const match=/^([ \t]*<metadata\s+key="[\w.:-]+"\s+value=")(.*)("\s*\/>[ \t]*\r?\n?)$/.exec(lines[i]);
    if (!match || await parses('<config>'+lines[i]+'</config>')) continue;
    lines[i]=match[1]+xmlAttribute(match[2])+match[3];
  }
  const repaired=lines.join('');
  if (!await parses(repaired)) throw Error("Slicer produced malformed Metadata/model_settings.config; no safe attribute repair is available.");
  return repaired;
}

/** Normalize only a newly produced/restored slice, before caching or handing it to the client. */
export async function normalize3mfMetadata(filePath:string):Promise<void> {
  const {zip}=await readSafe3mfArchive(filePath);
  const entry=zip.file('Metadata/model_settings.config');
  if(!entry) return;
  const original=await entry.async('string'), repaired=await escapedModelSettings(original);
  if (repaired===original) return;
  zip.file(entry.name,repaired);
  const staged=filePath+'.'+randomUUID()+'.xml-tmp';
  try {
    await fs.writeFile(staged,await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'}),{flag:'wx',mode:0o600});
    await fs.rename(staged,filePath);
  } finally { await fs.rm(staged,{force:true}).catch(()=>{}); }
}
