'use strict';
require('./polyfill');

/**
 * Structured JSON logger (pino).
 *
 * The upstream protocol client writes diagnostics through `console.*`. Those
 * calls are redirected into the structured logger so production logs remain
 * machine-parseable and can be filtered by level.
 */

const pino = require('pino');
const config = require('./config');

const logger = pino({
  level: config.logging.level,
  base: { service: 'muse-api', node: config.server.nodeId },
  timestamp: pino.stdTimeFunctions.isoTime,
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers["x-admin-key"]',
      'credential',
      'cookie',
      'wss_url',
      '*.credential',
      '*.cookie',
      '*.wss_url'
    ],
    censor: '[REDACTED]'
  }
});

/**
 * Removes secrets (wss tokens, session cookies) from arbitrary text before it
 * is logged or returned to API consumers.
 */
function sanitize(text) {
  if (text === undefined || text === null) return text;
  // Literal "..." placeholders (used in help messages) are left untouched.
  return String(text)
    .replace(/wss:\/\/(?!\.\.\.)[^\s"'|)]+/gi, 'wss://[redacted]')
    .replace(/(hatch_sess|datr|auth_token|notary_token|sessionid|c_user|xs)=(?!\.\.\.)([^;\s&"']+)/gi, '$1=[redacted]')
    .replace(/"authToken"\s*:\s*"(?!\.\.\.)[^"]+"/gi, '"authToken":"[redacted]"');
}

const upstreamLogger = logger.child({ component: 'upstream' });
const upstreamLevel = config.logging.upstreamLogLevel;

function redirectConsole() {
  const format = (args) => sanitize(args.map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  console.log = (...args) => upstreamLogger[upstreamLevel](format(args));
  console.info = (...args) => upstreamLogger[upstreamLevel](format(args));
  console.debug = (...args) => upstreamLogger.debug(format(args));
  console.warn = (...args) => upstreamLogger.warn(format(args));
  console.error = (...args) => upstreamLogger.error(format(args));
}

module.exports = { logger, sanitize, redirectConsole };
