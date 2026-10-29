'use strict';

/**
 * Rate limiting (fixed one-minute windows).
 *
 *  - ipRateLimit:  coarse per-client-IP ceiling applied before authentication
 *                  (protects against credential stuffing and floods).
 *  - keyRateLimit: per-API-key quota (key-specific `rate_limit_per_minute` or
 *                  the server default) applied after authentication.
 *
 * Responses include the IETF draft-8 `RateLimit` / `RateLimit-Policy` headers
 * and `Retry-After` when the limit is exceeded.
 *
 * NOTE: counters are stored in process memory. When running several API
 * nodes behind a load balancer, plug in a shared store (e.g. rate-limit-redis)
 * so the limits apply cluster-wide.
 */

const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const config = require('../config');
const { ApiError, ErrorCodes } = require('../errors');

const WINDOW_MS = 60_000;

function handler(req, res, next, options) {
  const resetTime = req.rateLimit?.resetTime;
  const retryAfter = resetTime ? Math.max(1, Math.ceil((resetTime.getTime() - Date.now()) / 1000)) : Math.ceil(options.windowMs / 1000);
  next(new ApiError(ErrorCodes.RATE_LIMIT_EXCEEDED, {
    retryAfter,
    details: { limit: req.rateLimit?.limit, window_seconds: Math.round(options.windowMs / 1000) }
  }));
}

const ipRateLimit = rateLimit({
  windowMs: WINDOW_MS,
  limit: config.rateLimit.ipPerMinute,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip || ''),
  // Health checks and signed media downloads are exempt.
  skip: (req) => req.path.startsWith('/health') || (req.method === 'GET' && typeof req.query?.signature === 'string'),
  handler,
  identifier: 'ip'
});

const keyRateLimit = rateLimit({
  windowMs: WINDOW_MS,
  limit: (req) => req.auth?.apiKey?.rate_limit_per_minute || config.rateLimit.defaultPerMinute,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  keyGenerator: (req) => `key:${req.auth?.apiKey?._id || 'anonymous'}`,
  skip: (req) => Boolean(req.auth?.apiKey?.isMaster),
  handler,
  identifier: 'api-key'
});

module.exports = { ipRateLimit, keyRateLimit };
