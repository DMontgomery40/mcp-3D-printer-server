import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPair,SignJWT} from 'jose';
import {createOAuthAuth} from './oauth-auth.mjs';
test('existing OAuth JWT verification binds issuer/audience/scopes and printer policy',async()=>{
 const {privateKey,publicKey}=await generateKeyPair('RS256');const now=Math.floor(Date.now()/1000);
 let allowed=true;const options={issuer:'https://issuer.example',audience:'https://farm.example/mcp',jwksUrl:'https://issuer.example/jwks',oauthMetadata:{issuer:'https://issuer.example'},keySet:publicKey,isAllowed:(_principal,printer)=>allowed&&printer==='farm-a'};
 const auth=createOAuthAuth(options);
 const sign=async(overrides={})=>new SignJWT({sub:'user-a',iat:now,exp:now+60,iss:options.issuer,aud:options.audience,scope:'printer:read',...overrides}).setProtectedHeader({alg:'RS256'}).sign(privateKey);
 const request=token=>new Request('https://farm.example/mcp',{headers:{authorization:`Bearer ${token}`}});
 const identity=await auth.authenticate(request(await sign()));assert.ok(identity?.principal);assert.ok(!identity.principal.includes('user-a'));
 assert.equal(await auth.authorize(identity,'farm-a'),true);assert.equal(await auth.authorize(identity,'farm-b'),false);allowed=false;assert.equal(await auth.authorize(identity,'farm-a'),false);
 for(const claims of [{iss:'https://wrong.example'},{aud:'https://other-farm.example/mcp'},{exp:now-60},{scope:''},{sub:''},{iat:undefined},{exp:undefined}])assert.equal(await auth.authenticate(request(await sign(claims))),undefined);
 assert.equal(await auth.authenticate(request('opaque-unverified')),undefined);assert.equal(await auth.authenticate(new Request('https://farm.example/mcp')),undefined);
 assert.throws(()=>createOAuthAuth({...options,jwksUrl:'http://issuer.example/jwks'}),/HTTPS/);
});

test('optional advertised scopes are separate from required read scopes and verifier outages propagate',async()=> {
 const {privateKey,publicKey}=await generateKeyPair('RS256');const now=Math.floor(Date.now()/1000);const options={issuer:'https://issuer.example',audience:'https://farm.example/mcp',jwksUrl:'https://issuer.example/jwks',oauthMetadata:{issuer:'https://issuer.example'},keySet:publicKey,scopesSupported:['printer:read','printer:optional'],requiredScopes:['printer:read'],isAllowed:()=>{throw Error('policy unavailable');}};
 const auth=createOAuthAuth(options);const token=await new SignJWT({sub:'user-a',iat:now,exp:now+60,iss:options.issuer,aud:options.audience,scope:'printer:read'}).setProtectedHeader({alg:'RS256'}).sign(privateKey);
 const identity=await auth.authenticate(new Request(options.audience,{headers:{authorization:`Bearer ${token}`}}));assert.deepEqual(identity.scopes,['printer:read']);assert.deepEqual(auth.requiredScopes,['printer:read']);await assert.rejects(auth.authorize(identity,'farm-a'),/policy unavailable/);
 assert.throws(()=>createOAuthAuth({...options,requiredScopes:['unadvertised']}));
});
