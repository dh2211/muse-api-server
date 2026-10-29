'use strict';

const crypto = require('crypto');

/**
 * Generates prefixed, URL-safe, collision-resistant identifiers
 * (e.g. "job_3fK9x...", "file_...") in the style of Stripe object IDs.
 * The prefix makes IDs self-describing in logs and support tickets.
 */
function generateId(prefix, bytes = 12) {
  return `${prefix}_${crypto.randomBytes(bytes).toString('base64url')}`;
}

/** Generates a new secret API key. Only its SHA-256 hash is stored. */
function generateApiKey() {
  return `mk_live_${crypto.randomBytes(24).toString('base64url')}`;
}

function generateWebhookSecret() {
  return `whsec_${crypto.randomBytes(24).toString('base64url')}`;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hmacSha256(secret, payload, encoding = 'hex') {
  return crypto.createHmac('sha256', secret).update(payload).digest(encoding);
}

/** Constant-time string comparison that tolerates different lengths. */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''));
  const bufB = Buffer.from(String(b ?? ''));
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA); // keep timing uniform
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = { generateId, generateApiKey, generateWebhookSecret, sha256, hmacSha256, safeEqual };
