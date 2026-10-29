'use strict';

const { ErrorCodes, ErrorCodeIndex } = require('./codes');
const { sanitize } = require('../logger');

/**
 * Operational API error. Throw anywhere in a request pipeline; the global
 * error handler converts it into the standard JSON error envelope.
 */
class ApiError extends Error {
  /**
   * @param {object} definition  Entry from ErrorCodes.
   * @param {object} [options]
   * @param {string} [options.message]     Overrides the default message.
   * @param {string} [options.param]       Offending request parameter.
   * @param {object|Array} [options.details] Extra structured context.
   * @param {number} [options.retryAfter]  Seconds; emitted as Retry-After header.
   * @param {Error}  [options.cause]       Underlying error (never exposed).
   */
  constructor(definition = ErrorCodes.INTERNAL_ERROR, options = {}) {
    super(options.message || definition.message);
    this.name = 'ApiError';
    this.status = definition.status;
    this.type = definition.type;
    this.code = definition.code;
    this.param = options.param || null;
    this.details = options.details;
    this.retryAfter = options.retryAfter;
    if (options.cause) this.cause = options.cause;
  }

  /** Serializable error body (without request_id, added by the handler). */
  toJSON() {
    const body = { type: this.type, code: this.code, message: this.message, param: this.param };
    if (this.details !== undefined) body.details = this.details;
    return body;
  }

  /** Rebuilds an ApiError from a `{ code, message }` object persisted on a job. */
  static fromStored(stored) {
    const def = (stored && ErrorCodeIndex[stored.code]) || ErrorCodes.INTERNAL_ERROR;
    return new ApiError(def, { message: stored?.message });
  }
}

/**
 * Maps an arbitrary error thrown by the upstream client into a well-defined
 * ApiError. Secrets are stripped from messages before exposure.
 */
function classifyUpstreamError(err) {
  if (err instanceof ApiError) return err;
  const raw = String(err?.message || err || 'Unknown upstream error');
  const text = raw.split('\n')[0];
  const safe = sanitize(text);

  if (err?.code === 'MUSE_AUTH_EXPIRED' || /\b(401|403)\b|expired|authentication required|rejected the connection|login page|no longer valid/i.test(raw)) {
    return new ApiError(ErrorCodes.UPSTREAM_AUTH_FAILED, { message: `The upstream account credentials were rejected (${safe.replace(/\.$/, '')}).`, cause: err });
  }
  if (/timed out|timeout|ETIMEDOUT/i.test(raw)) {
    return new ApiError(ErrorCodes.UPSTREAM_TIMEOUT, { message: `The upstream AI provider did not respond in time. ${safe}`.trim(), cause: err });
  }
  if (/did not produce/i.test(raw)) {
    return new ApiError(ErrorCodes.CONTENT_NOT_GENERATED, { cause: err });
  }
  return new ApiError(ErrorCodes.UPSTREAM_ERROR, { message: `The upstream AI provider returned an error: ${safe}`, cause: err });
}

/**
 * True when an upstream failure is attributable to the account / connection
 * (worth retrying on a different account) rather than to the request itself.
 */
function isAccountLevelFailure(apiError) {
  return ['upstream_auth_failed', 'upstream_error', 'upstream_timeout'].includes(apiError.code);
}

module.exports = { ApiError, ErrorCodes, classifyUpstreamError, isAccountLevelFailure };
