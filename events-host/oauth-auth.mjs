import {createHash} from 'node:crypto';
import {createRemoteJWKSet,jwtVerify} from 'jose';

/** Existing OAuth issuer only: no client registration, grants, tokens or accounts are created. */
export function createOAuthAuth({issuer,audience,jwksUrl,oauthMetadata,isAllowed,scopesSupported=['printer:read'],requiredScopes=scopesSupported,keySet,currentDate}) {
  const checked=value=>{const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.port)throw new Error('OAuth provider URLs must be HTTPS without credentials or query');return url;};
  checked(issuer);checked(jwksUrl);checked(audience);
  if(!oauthMetadata || typeof isAllowed!=='function' || !Array.isArray(scopesSupported)||scopesSupported.some(scope=>typeof scope!=='string'||!/^[A-Za-z0-9:_-]+$/.test(scope))||!Array.isArray(requiredScopes)||requiredScopes.some(scope=>!scopesSupported.includes(scope)))throw new Error('Existing issuer metadata and printer authorization are required');
  const keys=keySet??createRemoteJWKSet(new URL(jwksUrl),{timeoutDuration:5000});
  return {oauthMetadata,scopesSupported,requiredScopes,
    async authenticate(request) {
      const header=request.headers.get('authorization');
      if(!header?.startsWith('Bearer ') || header.length>32768)return undefined;
      try {
        const {payload}=await jwtVerify(header.slice(7),keys,{issuer,audience,algorithms:['RS256','ES256'],requiredClaims:['exp','iat','sub'],...(currentDate?{currentDate:currentDate()}:{} )});
        if(typeof payload.sub!=='string'||!payload.sub)return undefined;
        const scopes=typeof payload.scope==='string'?payload.scope.split(' ').filter(Boolean):[];
        if(requiredScopes.some(scope=>!scopes.includes(scope)))return undefined;
        return {principal:createHash('sha256').update(JSON.stringify([issuer,payload.sub])).digest('hex'),scopes};
      }catch{return undefined;}
    },
    async authorize({principal},printer) {
      if(typeof principal!=='string'||!principal||typeof printer!=='string')return false;
      return await isAllowed(principal,printer)===true;
    },
  };
}
