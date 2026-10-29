/**
 * Protobuf framing utilities for Muse AI / Hatch Noise Transport
 */
const { concat } = require('./crypto');

function writeVarint(val) {
  const bytes = [];
  let n = BigInt(val);
  if (n < 0n) n = BigInt.asUintN(64, n);
  while (n > 0x7fn) {
    bytes.push(Number((n & 0x7fn) | 0x80n));
    n >>= 7n;
  }
  bytes.push(Number(n & 0x7fn));
  return new Uint8Array(bytes);
}

function writeTag(fieldNum, wireType) {
  return writeVarint((fieldNum << 3) | wireType);
}

function writeStringField(fieldNum, str) {
  const enc = new TextEncoder().encode(str);
  return concat(writeTag(fieldNum, 2), writeVarint(enc.length), enc);
}

function writeBytesField(fieldNum, bytes) {
  return concat(writeTag(fieldNum, 2), writeVarint(bytes.length), bytes);
}

function writeVarintField(fieldNum, val) {
  return concat(writeTag(fieldNum, 0), writeVarint(val));
}

function encodeHeader(key, value) {
  return writeBytesField(3, concat(
    writeStringField(1, key),
    writeStringField(2, value)
  ));
}

function encodeApplicationRequest(verb, path, headers = [], body = new Uint8Array(0), endBody = true) {
  const parts = [
    writeStringField(1, verb),
    writeStringField(2, path),
  ];
  for (const h of headers) {
    parts.push(encodeHeader(h.key, h.value));
  }
  if (body.length > 0) {
    parts.push(writeBytesField(4, body));
  }
  if (endBody) {
    parts.push(writeVarintField(5, 1));
  }
  return concat(...parts);
}

function encodeServiceFrame(streamId, appRequest) {
  return concat(
    writeVarintField(1, streamId),
    writeBytesField(2, appRequest) // kind: request (field 2)
  );
}

function encodeServiceRequest(serviceType, serviceFrameBytes) {
  const parts = [
    writeVarintField(1, serviceType),
    writeBytesField(2, serviceFrameBytes)
  ];
  return concat(...parts);
}

function encodeNoiseTransportFrame(chunkId, chunkIndex, totalChunks, payload) {
  return concat(
    writeVarintField(1, chunkId),
    writeVarintField(2, chunkIndex),
    writeVarintField(3, totalChunks),
    writeBytesField(4, payload)
  );
}

function decodeProtoFields(buf) {
  let pos = 0;
  const fields = [];
  while (pos < buf.length) {
    let tag = 0, shift = 0;
    while (pos < buf.length) {
      const b = buf[pos++];
      tag |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    const fieldNum = tag >>> 3;
    const wireType = tag & 7;
    if (wireType === 0) {
      let val = 0n, s = 0n;
      while (pos < buf.length) {
        const b = BigInt(buf[pos++]);
        val |= (b & 0x7fn) << s;
        s += 7n;
        if (!(b & 0x80n)) break;
      }
      fields.push({ fieldNum, wireType, value: val });
    } else if (wireType === 2) {
      let len = 0, s = 0;
      while (pos < buf.length) {
        const b = buf[pos++];
        len |= (b & 0x7f) << s;
        s += 7;
        if (!(b & 0x80)) break;
      }
      const data = buf.subarray(pos, pos + len);
      pos += len;
      fields.push({ fieldNum, wireType, value: data });
    } else {
      break;
    }
  }
  return fields;
}

const PENDING_FRAME_TTL_MS = 60000;
const MAX_PENDING_FRAMES = 256;

class NoiseFrameDecoder {
  constructor() {
    this.pending = new Map();
  }

  _prune(now) {
    for (const [key, entry] of this.pending) {
      if (now - entry.createdAt > PENDING_FRAME_TTL_MS) {
        this.pending.delete(key);
      }
    }
    while (this.pending.size >= MAX_PENDING_FRAMES) {
      const oldestKey = this.pending.keys().next().value;
      if (oldestKey === undefined) break;
      this.pending.delete(oldestKey);
    }
  }

  decode(chunkId, chunkIndex, totalChunks, payload) {
    if (totalChunks === 1) return payload;

    const idStr = chunkId.toString();
    if (!this.pending.has(idStr)) {
      const now = Date.now();
      if (this.pending.size > 0) this._prune(now);
      this.pending.set(idStr, {
        chunks: new Map(),
        total: totalChunks,
        createdAt: now
      });
    }

    const assembly = this.pending.get(idStr);
    assembly.chunks.set(chunkIndex, payload);

    if (assembly.chunks.size < assembly.total) {
      return null; // Awaiting remaining chunks
    }

    this.pending.delete(idStr);
    const ordered = [];
    for (let i = 0; i < assembly.total; i++) {
      const c = assembly.chunks.get(i);
      if (!c) throw new Error(`Missing chunk index ${i} for chunkId ${chunkId}`);
      ordered.push(c);
    }
    return concat(...ordered);
  }
}

module.exports = {
  encodeApplicationRequest,
  encodeServiceFrame,
  encodeServiceRequest,
  encodeNoiseTransportFrame,
  decodeProtoFields,
  NoiseFrameDecoder
};
