// Minimal OIDC ID-token verification (RS256 / ES256) against the issuer's JWKS.
// No dependencies: uses node:crypto and global fetch.

import crypto from 'node:crypto';

const CLOCK_SKEW_S = 60;
const JWKS_TTL_MS = 3600_000;

export function createOidcVerifier({ issuer, audience = [], jwksUrl = '', allowedDomains = [] }) {
  if (!audience.length) throw new Error('ORGCHAT_OIDC_AUDIENCE is required when OIDC is enabled');
  if (!allowedDomains.length) throw new Error('ORGCHAT_OIDC_ALLOWED_DOMAINS is required when OIDC is enabled');

  let cache = { keys: [], at: 0 };

  async function resolveJwksUrl() {
    if (jwksUrl) return jwksUrl;
    const res = await fetch(issuer.replace(/\/$/, '') + '/.well-known/openid-configuration');
    if (!res.ok) throw new Error(`OIDC discovery failed: HTTP ${res.status}`);
    const doc = await res.json();
    if (!doc.jwks_uri) throw new Error('OIDC discovery document has no jwks_uri');
    jwksUrl = doc.jwks_uri;
    return jwksUrl;
  }

  async function getKeys(force = false) {
    if (!force && cache.keys.length && Date.now() - cache.at < JWKS_TTL_MS) return cache.keys;
    const res = await fetch(await resolveJwksUrl());
    if (!res.ok) throw new Error(`JWKS fetch failed: HTTP ${res.status}`);
    const { keys } = await res.json();
    cache = { keys: Array.isArray(keys) ? keys : [], at: Date.now() };
    return cache.keys;
  }

  return async function verify(token) {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('malformed ID token');
    const [h, p, s] = parts;
    let header, payload;
    try {
      header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
      payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    } catch {
      throw new Error('malformed ID token');
    }
    if (header.alg !== 'RS256' && header.alg !== 'ES256') throw new Error(`unsupported alg ${header.alg}`);

    const find = (keys) => keys.find((k) => k.kid === header.kid && (!k.use || k.use === 'sig'));
    const jwk = find(await getKeys()) || find(await getKeys(true));
    if (!jwk) throw new Error('signing key not found in JWKS');

    const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    const data = Buffer.from(`${h}.${p}`);
    const sig = Buffer.from(s, 'base64url');
    const ok = header.alg === 'RS256'
      ? crypto.verify('RSA-SHA256', data, key, sig)
      : crypto.verify('SHA256', data, { key, dsaEncoding: 'ieee-p1363' }, sig);
    if (!ok) throw new Error('bad ID token signature');

    const now = Math.floor(Date.now() / 1000);
    if (payload.iss !== issuer) throw new Error('ID token issuer mismatch');
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.some((a) => audience.includes(a))) throw new Error('ID token audience mismatch');
    if (typeof payload.exp !== 'number' || payload.exp + CLOCK_SKEW_S < now) throw new Error('ID token expired');
    if (typeof payload.nbf === 'number' && payload.nbf - CLOCK_SKEW_S > now) throw new Error('ID token not yet valid');

    const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : '';
    if (!email) throw new Error('ID token has no email claim');
    if (payload.email_verified === false || payload.email_verified === 'false') throw new Error('email not verified');
    const domain = email.split('@')[1] || '';
    if (!allowedDomains.includes(domain)) throw new Error(`domain ${domain} is not allowed on this relay`);
    return { email, domain, sub: payload.sub };
  };
}
