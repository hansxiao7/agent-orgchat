import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { createOidcVerifier } from '../src/oidc.mjs';

let server, issuer;
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' };

function sign(payload, kid = 'k1') {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const data = `${enc({ alg: 'RS256', kid, typ: 'JWT' })}.${enc(payload)}`;
  return `${data}.${crypto.sign('RSA-SHA256', Buffer.from(data), privateKey).toString('base64url')}`;
}

before(async () => {
  server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/.well-known/openid-configuration') res.end(JSON.stringify({ jwks_uri: `${issuer}/jwks` }));
    else if (req.url === '/jwks') res.end(JSON.stringify({ keys: [jwk] }));
    else { res.statusCode = 404; res.end('{}'); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  issuer = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const claims = (over = {}) => ({
  iss: issuer, aud: 'orgchat', email: 'Alice@Acme.com', email_verified: true,
  exp: Math.floor(Date.now() / 1000) + 600, ...over,
});

test('valid token from an allowed domain', async () => {
  const verify = createOidcVerifier({ issuer, audience: ['orgchat'], allowedDomains: ['acme.com'] });
  assert.deepEqual(await verify(sign(claims({ sub: 'u1' }))), { email: 'alice@acme.com', domain: 'acme.com', sub: 'u1' });
});

test('rejects wrong domain, audience, expiry, issuer and tampering', async () => {
  const verify = createOidcVerifier({ issuer, audience: ['orgchat'], allowedDomains: ['acme.com'] });
  await assert.rejects(verify(sign(claims({ email: 'eve@evil.com' }))), /not allowed/);
  await assert.rejects(verify(sign(claims({ aud: 'other' }))), /audience/);
  await assert.rejects(verify(sign(claims({ exp: 1 }))), /expired/);
  await assert.rejects(verify(sign(claims({ iss: 'https://evil' }))), /issuer/);
  await assert.rejects(verify(sign(claims({ email_verified: false }))), /not verified/);
  await assert.rejects(verify(sign(claims(), 'nope')), /signing key/);
  const [h, , s] = sign(claims()).split('.');
  const forged = Buffer.from(JSON.stringify(claims({ email: 'boss@acme.com' }))).toString('base64url');
  await assert.rejects(verify(`${h}.${forged}.${s}`), /signature/);
});

test('requires audience and allowed domains', () => {
  assert.throws(() => createOidcVerifier({ issuer, audience: [], allowedDomains: ['acme.com'] }), /AUDIENCE/);
  assert.throws(() => createOidcVerifier({ issuer, audience: ['x'], allowedDomains: [] }), /ALLOWED_DOMAINS/);
});
