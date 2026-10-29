'use strict';

/**
 * Global Polyfill for Node.js < 19 environments (Node.js 16.x / CentOS 7)
 * - Diagnostics channel tracingChannel for Pino v9/v10
 * - WebCrypto / crypto.getRandomValues / crypto.randomUUID
 * - Fetch API using axios
 */

// 1. diagnostics_channel polyfill for Pino (Node < 19.9)
try {
  const dc = require('diagnostics_channel');
  if (dc && typeof dc.tracingChannel !== 'function') {
    dc.tracingChannel = function (nameOrChannels) {
      const name = typeof nameOrChannels === 'string' ? nameOrChannels : (nameOrChannels && nameOrChannels.name) || 'anonymous';
      const ch = dc.channel(name);
      return {
        start: ch,
        end: ch,
        asyncStart: ch,
        asyncEnd: ch,
        error: ch,
        hasSubscribers: Boolean(ch && ch.hasSubscribers),
        traceTransition: (fn) => fn(),
        traceCallback: (fn, thisArg, ...args) => fn.apply(thisArg, args),
        tracePromise: (fn) => fn()
      };
    };
  }
} catch (_) {}

// 2. crypto polyfill for Node < 19
const nodeCrypto = require('crypto');
const webCrypto = nodeCrypto.webcrypto || {};
const mergedCrypto = Object.assign(Object.create(nodeCrypto), webCrypto);

if (!mergedCrypto.getRandomValues) {
  mergedCrypto.getRandomValues = function (arr) {
    return nodeCrypto.randomFillSync(arr);
  };
}

if (!mergedCrypto.randomUUID) {
  mergedCrypto.randomUUID = function () {
    return nodeCrypto.randomUUID ? nodeCrypto.randomUUID() : nodeCrypto.randomBytes(16).toString('hex');
  };
}

if (!mergedCrypto.subtle && webCrypto.subtle) {
  mergedCrypto.subtle = webCrypto.subtle;
}

if (typeof globalThis !== 'undefined') {
  if (!globalThis.crypto || !globalThis.crypto.getRandomValues) {
    globalThis.crypto = mergedCrypto;
  }
}

if (typeof global !== 'undefined') {
  if (!global.crypto || !global.crypto.getRandomValues) {
    global.crypto = globalThis.crypto || mergedCrypto;
  }
}

// 3. fetch polyfill using axios for Node < 18
if (typeof globalThis.fetch === 'undefined' || !globalThis.fetch) {
  try {
    const axios = require('axios');
    const fetchPolyfill = async (url, options = {}) => {
      const method = (options.method || 'GET').toLowerCase();
      const headers = options.headers || {};
      const res = await axios({
        url,
        method,
        headers,
        data: options.body,
        validateStatus: () => true,
        responseType: options.responseType || 'text'
      });

      return {
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        statusText: res.statusText,
        headers: {
          get: (name) => res.headers[name.toLowerCase()]
        },
        text: async () => (typeof res.data === 'string' ? res.data : JSON.stringify(res.data)),
        json: async () => (typeof res.data === 'object' ? res.data : JSON.parse(res.data))
      };
    };
    globalThis.fetch = fetchPolyfill;
    global.fetch = fetchPolyfill;
  } catch (_) {}
}

module.exports = global.crypto;
