import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { createCloudflareAccessAuth } from './cloudflare-auth.mjs';

test('Access verifier validates signed individual identity, issuer, audience and lifetime before authorization',async()=> {
 const {privateKey,publicKey}=await generateKeyPair('RS256');
 const now=Math.floor(Date.now()/1000),issuer='https://printer-test.cloudflareaccess.com';
 const jwk=await exportJWK(publicKey);jwk.kid='test';let allowed=true;
 const auth=createCloudflareAccessAuth({teamDomain:issuer,audience:'test-app-audience',isAllowed:(principal,printer)=>allowed&&['default','farm-a'].includes(printer)&&principal===auth.principalFor('test-user'),keySet:createLocalJWKSet({keys:[jwk]}),currentDate:()=>new Date(now*1000)});
 const sign=async changes=>new SignJWT({iss:issuer,aud:'test-app-audience',sub:'test-user',iat:now,exp:now+600,type:'app',email:'test@example.invalid',...changes}).setProtectedHeader({alg:'RS256',kid:'test'}).sign(privateKey);
 const req=token=>new Request('https://printer.example.com/mcp',{headers:{'cf-access-jwt-assertion':token}});
 const valid=await sign({}),identity=await auth.authenticate(req(valid));assert.equal(identity.principal,auth.principalFor('test-user'));
 assert.equal(await auth.authorize(identity,'default'),true);assert.equal(await auth.authorize(identity,'farm-a'),true);assert.equal(await auth.authorize(identity,'farm-b'),false);allowed=false;assert.equal(await auth.authorize(identity,'default'),false);
 for(const claims of [{iss:'https://wrong.cloudflareaccess.com'},{aud:'other-app'},{exp:now-1},{nbf:now+60},{exp:undefined},{sub:undefined},{sub:''},{type:'service'},{email:undefined},{email:''}]) assert.equal(await auth.authenticate(req(await sign(claims))),undefined,JSON.stringify(claims));
 const parts=valid.split('.');parts[2]=(parts[2][0]==='a'?'b':'a')+parts[2].slice(1);assert.equal(await auth.authenticate(req(parts.join('.'))),undefined);
 assert.equal(await auth.authenticate(new Request('https://printer.example.com/mcp',{headers:{authorization:`Bearer ${valid}`}})),undefined);
 assert.equal(await auth.authorize(identity,'other'),false);assert.deepEqual(auth.scopesSupported,[]);
 for(const teamDomain of ['https://evil.example','http://test.cloudflareaccess.com','https://test.cloudflareaccess.com:8443','https://test.cloudflareaccess.com/path'])assert.throws(()=>createCloudflareAccessAuth({teamDomain,audience:'x',isAllowed:()=>true}),/Invalid/);
});
