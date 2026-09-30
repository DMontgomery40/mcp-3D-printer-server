import { createHash } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';

/** Opt-in verifier for Access Managed OAuth. It neither creates Access settings
 * nor trusts the assertion header without cryptographic verification.
 * isAllowed must consult the operator's current local owner/revocation policy.
 */
export function createCloudflareAccessAuth({ teamDomain, audience, oauthMetadata, isAllowed,
  keySet, currentDate }) {
  const issuer=new URL(teamDomain);
  if(issuer.protocol!=='https:' || !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer.hostname) ||
    issuer.port || issuer.pathname!=='/' || issuer.username || issuer.password || issuer.search || issuer.hash ||
    typeof audience!=='string' || !audience || typeof isAllowed!=='function') throw new Error('Invalid Access authentication configuration');
  const expectedIssuer=issuer.origin;
  const keys=keySet??createRemoteJWKSet(new URL('/cdn-cgi/access/certs',issuer),{timeoutDuration:5000});
  const principalFor=subject=>createHash('sha256').update(JSON.stringify([expectedIssuer,subject])).digest('hex');
  return {
    oauthMetadata,
    // Access applies owner policy to the whole read-only application; it does
    // not issue this project's custom printer:read scope.
    scopesSupported:[],
    principalFor,
    async authenticate(request) {
      const token=request.headers.get('cf-access-jwt-assertion');
      if(!token || token.length>16384)return undefined;
      try {
        const {payload}=await jwtVerify(token,keys,{issuer:expectedIssuer,audience,algorithms:['RS256'],
          requiredClaims:['iss','aud','sub','exp','iat'],...currentDate?{currentDate:currentDate()}:{}});
        // Machine service tokens are not individual subscription owners.
        if(payload.type!=='app' || typeof payload.sub!=='string' || !payload.sub ||
          typeof payload.email!=='string' || !payload.email)return undefined;
        return {principal:principalFor(payload.sub)};
      } catch {return undefined;}
    },
    async authorize({principal},printer) {
      if(typeof printer!=='string' || typeof principal!=='string')return false;
      return (await isAllowed(principal,printer))===true;
    },
  };
}
