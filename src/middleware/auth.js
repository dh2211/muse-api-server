'use strict';

/**
 * API key authentication & scope authorization.
 *
 * Clients authenticate with `Authorization: Bearer <API_KEY>` (preferred) or
 * the `X-API-Key` header. Keys are looked up by their SHA-256 hash. Results
 * are cached in-process for a short TTL so authentication does not cost a
 * database round-trip on every request; admin mutations invalidate the cache
 * immediately on the node that performed them (other nodes converge within
 * the TTL).
 *
 * The master ADMIN_API_KEY from the environment authenticates as a built-in
 * superuser with every scope.
 */

const config = require('../config');
const { ApiKey } = require('../models');
const { sha256, safeEqual } = require('../utils/crypto');
const usage = require('../services/usage');
const { ApiError, ErrorCodes } = require('../errors');

const CACHE_TTL_MS = 30_000;
const CACHE_MAX_ENTRIES = 10_000;
const NEGATIVE_TTL_MS = 5_000;

/** hash -> { doc|null, expiresAt } */
const cache = new Map();

const MASTER_KEY = Object.freeze({
  _id: 'key_master',
  name: 'Master admin key',
  scopes: ['chat', 'images', 'videos', 'files', 'admin'],
  enabled: true,
  expires_at: null,
  rate_limit_per_minute: null,
  max_concurrent_jobs: null,
  isMaster: true
});

function extractKey(req) {
  const header = req.get('authorization');
  if (header) {
    const match = header.match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() : null;
  }
  const alt = req.get('x-api-key');
  return alt ? alt.trim() : null;
}

async function lookup(hash) {
  const now = Date.now();
  const hit = cache.get(hash);
  if (hit && hit.expiresAt > now) return hit.doc;

  const doc = await ApiKey.findOne({ key_hash: hash }).lean();
  if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(hash, { doc, expiresAt: now + (doc ? CACHE_TTL_MS : NEGATIVE_TTL_MS) });
  return doc;
}

/** Drops cached entries for an API key (call after admin updates/deletes). */
function invalidateApiKeyCache(apiKeyId) {
  for (const [hash, entry] of cache) {
    if (!apiKeyId || entry.doc?._id === apiKeyId) cache.delete(hash);
  }
}

/** Resolves the caller and attaches `req.auth`. Rejects with 401 on failure. */
async function authenticate(req, res, next) {
  const presented = extractKey(req);
  if (!presented) throw new ApiError(ErrorCodes.API_KEY_MISSING);

  if (safeEqual(presented, config.security.adminApiKey)) {
    req.auth = { apiKey: MASTER_KEY, scopes: new Set(MASTER_KEY.scopes), isAdmin: true };
    return next();
  }

  const doc = await lookup(sha256(presented));
  if (!doc) throw new ApiError(ErrorCodes.API_KEY_INVALID);
  if (!doc.enabled) throw new ApiError(ErrorCodes.API_KEY_REVOKED);
  if (doc.expires_at && new Date(doc.expires_at) <= new Date()) throw new ApiError(ErrorCodes.API_KEY_EXPIRED);

  const scopes = new Set(doc.scopes || []);
  req.auth = { apiKey: doc, scopes, isAdmin: scopes.has('admin') };
  usage.track(doc._id, 'requests');
  return next();
}

/**
 * Requires at least one of the given scopes (admin implies every scope).
 * @param {...string} required
 */
function requireScope(...required) {
  return (req, res, next) => {
    const auth = req.auth;
    if (!auth) throw new ApiError(ErrorCodes.API_KEY_MISSING);
    if (auth.isAdmin || required.some((s) => auth.scopes.has(s))) return next();
    throw new ApiError(ErrorCodes.INSUFFICIENT_SCOPE, {
      message: `This API key is missing the required scope: ${required.map((s) => `'${s}'`).join(' or ')}.`
    });
  };
}

const requireAdmin = requireScope('admin');

module.exports = { authenticate, requireScope, requireAdmin, invalidateApiKeyCache, MASTER_KEY };
