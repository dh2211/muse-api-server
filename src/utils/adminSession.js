'use strict';

/**
 * Lightweight, cryptographically-secure admin session token manager.
 * Uses HMAC-SHA256 with the server's SIGNING_SECRET. No external dependencies required.
 */

const crypto = require('node:crypto');
const config = require('../config');

function createAdminSession(ttlSec = 86400) {
  const expiresAt = Date.now() + ttlSec * 1000;
  const payload = JSON.stringify({ role: 'admin', exp: expiresAt, rnd: crypto.randomBytes(16).toString('hex') });
  const b64Payload = Buffer.from(payload).toString('base64url');
  const signature = crypto
    .createHmac('sha256', config.security.signingSecret)
    .update(b64Payload)
    .digest('base64url');

  return {
    token: `${b64Payload}.${signature}`,
    expiresAt: new Date(expiresAt)
  };
}

function verifyAdminSession(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;

  const [b64Payload, signature] = parts;
  const expectedSignature = crypto
    .createHmac('sha256', config.security.signingSecret)
    .update(b64Payload)
    .digest('base64url');

  // Constant-time signature comparison to prevent timing attacks
  if (signature.length !== expectedSignature.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(b64Payload, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp < Date.now()) {
      return null; // Expired
    }
    return payload;
  } catch (err) {
    return null;
  }
}

function parseCookies(req) {
  const list = {};
  const header = req.headers?.cookie;
  if (!header) return list;
  const parts = header.split(';');
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    try {
      list[key] = decodeURIComponent(val);
    } catch (e) {
      list[key] = val;
    }
  }
  return list;
}

module.exports = {
  createAdminSession,
  verifyAdminSession,
  parseCookies
};
