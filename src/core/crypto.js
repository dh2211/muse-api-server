/**
 * Noise_XX_25519_AESGCM_SHA256 Implementation
 * Extracted and optimized for Node.js WebCrypto
 */
require('./polyfill');
const crypto = globalThis.crypto || require('crypto').webcrypto || require('crypto');

function concat(...arrays) {
  let total = 0;
  for (const a of arrays) total += a.length;
  const res = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    res.set(a, offset);
    offset += a.length;
  }
  return res;
}

function bufferSlice(e) {
  return (0 === e.byteOffset && e.byteLength === e.buffer.byteLength)
    ? e.buffer
    : e.buffer.slice(e.byteOffset, e.byteOffset + e.byteLength);
}

function wipe(e) {
  if (e && e.fill) e.fill(0);
}

function constantTimeEqual(e, t) {
  if (e.length !== t.length) return false;
  let diff = 0;
  for (let i = 0; i < e.length; i++) diff |= e[i] ^ t[i];
  return diff === 0;
}

const LOW_ORDER_POINTS = [
  new Uint8Array(32).fill(0),
  new Uint8Array([1, ...new Array(31).fill(0)]),
  new Uint8Array([224, 235, 122, 124, 59, 65, 184, 174, 22, 86, 227, 250, 241, 159, 196, 106, 218, 9, 141, 235, 156, 50, 177, 253, 134, 98, 5, 22, 95, 73, 184, 0]),
  new Uint8Array([95, 156, 149, 188, 163, 80, 140, 36, 177, 208, 177, 85, 156, 131, 239, 91, 4, 68, 92, 196, 88, 28, 142, 134, 216, 34, 78, 221, 208, 159, 17, 87]),
  new Uint8Array([236, ...new Array(30).fill(255), 127]),
  new Uint8Array([237, ...new Array(30).fill(255), 127]),
  new Uint8Array([238, ...new Array(30).fill(255), 127])
];

async function generateX25519() {
  const pair = await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"]);
  const pub = await crypto.subtle.exportKey("raw", pair.publicKey);
  return {
    privateKey: pair.privateKey,
    publicKeyBytes: new Uint8Array(pub)
  };
}

async function x25519DH(privateKey, pubBytes) {
  if (pubBytes.length !== 32) throw Error("x25519: invalid pubkey length");
  for (const p of LOW_ORDER_POINTS) {
    if (constantTimeEqual(pubBytes, p)) throw Error("x25519: low-order public key");
  }
  const importedPub = await crypto.subtle.importKey("raw", bufferSlice(pubBytes), { name: "X25519" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "X25519", public: importedPub }, privateKey, 256));
  if (constantTimeEqual(shared, new Uint8Array(32))) throw Error("x25519: all-zeros DH");
  return shared;
}

async function hmacSha256(keyBytes, dataBytes) {
  const key = await crypto.subtle.importKey("raw", bufferSlice(keyBytes), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, bufferSlice(dataBytes)));
}

async function hkdf2(ck, ikm) {
  const prk = await hmacSha256(ck, ikm);
  const out1 = await hmacSha256(prk, new Uint8Array([1]));
  const out2 = await hmacSha256(prk, concat(out1, new Uint8Array([2])));
  return [out1, out2];
}

function makeNonce(n) {
  const buf = new Uint8Array(12);
  const dv = new DataView(buf.buffer);
  dv.setUint32(4, Math.floor(n / 0x100000000), false);
  dv.setUint32(8, n >>> 0, false);
  return buf;
}

class CipherState {
  #encKey = null;
  #decKey = null;
  #hasKey = false;
  #nonce = 0;

  async initializeKey(k) {
    const raw = bufferSlice(k);
    [this.#encKey, this.#decKey] = await Promise.all([
      crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]),
      crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"])
    ]);
    wipe(k);
    this.#hasKey = true;
    this.#nonce = 0;
  }

  hasKey() { return this.#hasKey; }

  async encryptWithAd(ad, plaintext) {
    if (!this.#hasKey) return plaintext;
    const iv = makeNonce(this.#nonce++);
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: bufferSlice(iv), additionalData: bufferSlice(ad), tagLength: 128 },
      this.#encKey,
      bufferSlice(plaintext)
    );
    return new Uint8Array(ct);
  }

  async decryptWithAd(ad, ciphertext) {
    if (!this.#hasKey) return ciphertext;
    const iv = makeNonce(this.#nonce++);
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bufferSlice(iv), additionalData: bufferSlice(ad), tagLength: 128 },
      this.#decKey,
      bufferSlice(ciphertext)
    );
    return new Uint8Array(pt);
  }
}

class SymmetricState {
  #h = new Uint8Array(32);
  #ck = new Uint8Array(32);
  #cs = new CipherState();

  async initialize() {
    const protocolName = new TextEncoder().encode("Noise_XX_25519_AESGCM_SHA256");
    const initHash = new Uint8Array(32);
    initHash.set(protocolName);
    this.#h = initHash;
    this.#ck = new Uint8Array(this.#h);
    await this.mixHash(new Uint8Array(0));
  }

  async mixHash(data) {
    this.#h = new Uint8Array(await crypto.subtle.digest("SHA-256", bufferSlice(concat(this.#h, data))));
  }

  async mixKey(ikm) {
    const [newCk, tempK] = await hkdf2(this.#ck, ikm);
    this.#ck = newCk;
    this.#cs = new CipherState();
    await this.#cs.initializeKey(tempK);
  }

  async encryptAndHash(plaintext) {
    const ct = await this.#cs.encryptWithAd(this.#h, plaintext);
    await this.mixHash(ct);
    return ct;
  }

  async decryptAndHash(ciphertext) {
    const pt = await this.#cs.decryptWithAd(this.#h, ciphertext);
    await this.mixHash(ciphertext);
    return pt;
  }

  async split() {
    const [c1, c2] = await hkdf2(this.#ck, new Uint8Array(0));
    const cs1 = new CipherState();
    await cs1.initializeKey(c1);
    const cs2 = new CipherState();
    await cs2.initializeKey(c2);
    return [cs1, cs2];
  }

  handshakeHash() { return new Uint8Array(this.#h); }
}

class NoiseXXInitiator {
  #sym = new SymmetricState();
  #e = null;
  #re = null;
  #rs = null;
  #s = null;
  #phase = 0;

  async initialize() {
    await this.#sym.initialize();
    this.#phase = 1;
  }

  async writeMessage1(payload = new Uint8Array(0)) {
    if (this.#phase !== 1) throw Error("wrong phase for msg1");
    this.#e = await generateX25519();
    await this.#sym.mixHash(this.#e.publicKeyBytes);
    const ct = await this.#sym.encryptAndHash(payload);
    this.#phase = 2;
    return concat(this.#e.publicKeyBytes, ct);
  }

  async readMessage2(msg2) {
    if (this.#phase !== 2) throw Error("wrong phase for msg2");
    if (msg2.length < 96) throw Error(`msg2 too short: ${msg2.length}`);
    let offset = 0;
    this.#re = new Uint8Array(msg2.subarray(offset, offset + 32));
    await this.#sym.mixHash(this.#re);
    offset += 32;

    const ee = await x25519DH(this.#e.privateKey, this.#re);
    await this.#sym.mixKey(ee);

    this.#rs = await this.#sym.decryptAndHash(msg2.subarray(offset, offset + 48));
    offset += 48;

    const es = await x25519DH(this.#e.privateKey, this.#rs);
    await this.#sym.mixKey(es);

    const payload = await this.#sym.decryptAndHash(msg2.subarray(offset));
    this.#phase = 3;
    return payload;
  }

  async writeMessage3(payload = new Uint8Array(0)) {
    if (this.#phase !== 3) throw Error("wrong phase for msg3");
    this.#s = await generateX25519();
    const sEnc = await this.#sym.encryptAndHash(this.#s.publicKeyBytes);
    const se = await x25519DH(this.#s.privateKey, this.#re);
    await this.#sym.mixKey(se);
    const ct = await this.#sym.encryptAndHash(payload);
    this.#phase = 4;
    return concat(sEnc, ct);
  }

  async split() {
    if (this.#phase !== 4) throw Error("wrong phase for split");
    this.#phase = 5;
    return await this.#sym.split();
  }

  remoteStaticPublicKey() { return this.#rs ? new Uint8Array(this.#rs) : null; }
  handshakeHash() { return this.#sym.handshakeHash(); }
}

module.exports = {
  NoiseXXInitiator,
  concat
};
