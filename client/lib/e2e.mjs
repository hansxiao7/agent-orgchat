// End-to-end encryption for orgchat messages. node:crypto only.
//
// - Each device has a long-term X25519 identity key (~/.config/orgchat/identity.json).
// - Per message: key = HKDF-SHA256(X25519(my_priv, their_pub), info = both public keys),
//   then AES-256-GCM with a random 96-bit nonce. The additional authenticated
//   data binds the sender session, recipient session and thread, so the relay
//   cannot re-route or re-thread a ciphertext.
// - Sender keys are pinned trust-on-first-use per user (known_keys.json).
//
// What this protects against: a relay operator or anyone with access to the
// relay's memory, database or logs reading message content. What it does not:
// an actively malicious relay substituting public keys on first contact (compare
// fingerprints out of band to rule that out), replay of old ciphertexts, and
// forward secrecy if a device key is stolen.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const E2E_ALG = 'x25519-hkdf-sha256-aes256gcm-v1';
const PUBKEY_RE = /^[A-Za-z0-9_-]{43}$/;

const configDir = () => path.join(os.homedir(), '.config', 'orgchat');

export function isPublicKey(value) {
  return typeof value === 'string' && PUBKEY_RE.test(value);
}

export function fingerprint(pub) {
  const hex = crypto.createHash('sha256').update(Buffer.from(pub, 'base64url')).digest('hex').slice(0, 20);
  return hex.match(/.{4}/g).join('-');
}

function writePrivate(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, data, { mode: 0o600 });
}

/** Load (or create on first use) this device's identity key. */
export function loadIdentity(file = process.env.ORGCHAT_IDENTITY_FILE || path.join(configDir(), 'identity.json')) {
  let jwk;
  try {
    jwk = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`cannot read identity key ${file}: ${err.message}`);
    const { privateKey } = crypto.generateKeyPairSync('x25519');
    jwk = privateKey.export({ format: 'jwk' });
    writePrivate(file, JSON.stringify(jwk) + '\n');
  }
  const privateKey = crypto.createPrivateKey({ key: jwk, format: 'jwk' });
  const pub = crypto.createPublicKey(privateKey).export({ format: 'jwk' }).x;
  return { privateKey, pub, fingerprint: fingerprint(pub), file };
}

function publicKeyFrom(pub) {
  return crypto.createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: pub }, format: 'jwk' });
}

function deriveKey(identity, peerPub, senderPub, recipientPub) {
  const shared = crypto.diffieHellman({ privateKey: identity.privateKey, publicKey: publicKeyFrom(peerPub) });
  return Buffer.from(crypto.hkdfSync('sha256', shared, Buffer.from('orgchat'), Buffer.from(`${E2E_ALG}|${senderPub}|${recipientPub}`), 32));
}

const aad = ({ fromSid, toSid, thread }) => Buffer.from(`${fromSid}|${toSid}|${thread || ''}`);

export function encrypt(identity, recipientPub, text, binding) {
  const key = deriveKey(identity, recipientPub, identity.pub, recipientPub);
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad(binding));
  const body = Buffer.concat([cipher.update(JSON.stringify({ text, ts: new Date().toISOString() }), 'utf8'), cipher.final()]);
  return {
    alg: E2E_ALG,
    nonce: nonce.toString('base64url'),
    ct: Buffer.concat([body, cipher.getAuthTag()]).toString('base64url'),
  };
}

export function decrypt(identity, senderPub, envelope, binding) {
  if (envelope?.alg !== E2E_ALG) throw new Error(`unsupported encryption ${envelope?.alg}`);
  const key = deriveKey(identity, senderPub, senderPub, identity.pub);
  const raw = Buffer.from(envelope.ct, 'base64url');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.nonce, 'base64url'));
  decipher.setAAD(aad(binding));
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  const plain = Buffer.concat([decipher.update(raw.subarray(0, raw.length - 16)), decipher.final()]).toString('utf8');
  const { text, ts } = JSON.parse(plain);
  return { text: String(text), sentAt: ts };
}

/** Trust-on-first-use pinning of peers' keys, per user. */
export class KnownKeys {
  constructor(file = process.env.ORGCHAT_KNOWN_KEYS_FILE || path.join(configDir(), 'known_keys.json')) {
    this.file = file;
  }
  #read() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return {};
    }
  }
  /** Returns 'known' if this user's key was seen before, otherwise pins it and returns 'new'. */
  check(user, pub) {
    const fp = fingerprint(pub);
    const db = this.#read();
    const entry = (db[user] ||= []);
    if (entry.some((k) => k.fingerprint === fp)) return { status: 'known', fingerprint: fp, otherKeys: entry.length - 1 };
    const otherKeys = entry.length;
    entry.push({ fingerprint: fp, first_seen: new Date().toISOString() });
    try {
      writePrivate(this.file, JSON.stringify(db, null, 2) + '\n');
    } catch {
      /* pinning is best effort */
    }
    return { status: 'new', fingerprint: fp, otherKeys };
  }
}
