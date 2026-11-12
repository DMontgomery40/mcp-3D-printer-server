import test from 'node:test';
import assert from 'node:assert/strict';
import {parseStringPromise} from 'xml2js';
import {xmlAttribute,escapedModelSettings} from '../dist/slicer/3mf-xml.js';
test('3MF attribute encoder preserves quoted text, entity literals and whitespace',async()=>{
 const original='"A" & <B> \'C\'\t\r\n😀';
 const value=(await parseStringPromise('<metadata value="'+xmlAttribute(original)+'"/>')).metadata.$.value;
 assert.equal(value,original);
 assert.equal(xmlAttribute('x\u0001y'),'xy');
});
test('valid model settings are byte-identical; unexpected malformed XML is rejected',async()=>{
 const valid='<config>\n<metadata key="name" value="A &amp; &quot;B&quot;"/>\n</config>';
 assert.equal(await escapedModelSettings(valid),valid);
 for(const xml of ['', '   ', '<config/><other/>','<config/>garbage','<config/>\n<other', '<other/>', '<config><object></config>','<config>\n<metadata key="name" value="unterminated\n</config>'])await assert.rejects(escapedModelSettings(xml),/malformed/);
});
