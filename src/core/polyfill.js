/**
 * Global Polyfill for Node.js < 19 environments (Node.js 16.x, 18.x on Linux / aaPanel / Docker)
 * Fixes: ReferenceError: crypto is not defined in MongoDB driver v6+, Mongoose, sessions, uuidV4, WebCrypto
 */
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

// Polyfill globalThis.crypto and global.crypto
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

// Polyfill global fetch using axios for Node.js < 18
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
  } catch (e) {}
}

module.exports = global.crypto;
