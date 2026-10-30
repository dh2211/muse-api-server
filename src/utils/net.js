'use strict';

/**
 * SSRF-hardened outbound HTTP.
 *
 * Remote reference URLs and webhook targets are user-controlled, so every
 * outbound connection resolves DNS through a guarded lookup that refuses
 * loopback, private, link-local, CGNAT and multicast ranges. Because the check
 * runs inside the socket's lookup, it also covers redirects and DNS rebinding.
 */

const dns = require('dns');
const net = require('net');
const http = require('http');
const https = require('https');

const BLOCKED_V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]
];

function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0;
}

function isPrivateIPv4(ip) {
  const value = ipv4ToInt(ip);
  return BLOCKED_V4.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (value & mask) === (ipv4ToInt(base) & mask);
  });
}

function parseIPv6Words(address) {
  let addr = address.toLowerCase();
  const lastColon = addr.lastIndexOf(':');
  if (lastColon !== -1) {
    const candidate = addr.slice(lastColon + 1);
    if (net.isIPv4(candidate)) {
      const octets = candidate.split('.').map(Number);
      const w1 = ((octets[0] << 8) | octets[1]).toString(16);
      const w2 = ((octets[2] << 8) | octets[3]).toString(16);
      addr = addr.slice(0, lastColon) + ':' + w1 + ':' + w2;
    }
  }
  const parts = addr.split('::');
  if (parts.length > 2) return null;
  const head = parts[0] ? parts[0].split(':').map(h => parseInt(h, 16)) : [];
  const tail = parts.length === 2 && parts[1] ? parts[1].split(':').map(h => parseInt(h, 16)) : [];
  if (parts.length === 1) {
    if (head.length !== 8) return null;
    return head;
  }
  const fillCount = 8 - (head.length + tail.length);
  if (fillCount < 0) return null;
  return [...head, ...new Array(fillCount).fill(0), ...tail];
}

function isPrivateAddress(address) {
  if (net.isIPv4(address)) return isPrivateIPv4(address);
  if (net.isIPv6(address)) {
    const a = address.toLowerCase();
    if (a === '::' || a === '::1') return true;
    const words = parseIPv6Words(a);
    if (words) {
      // IPv4-mapped (::ffff:0:0/96)
      const isIPv4Mapped = words[0] === 0 && words[1] === 0 && words[2] === 0 && words[3] === 0 && words[4] === 0 && words[5] === 0xffff;
      // IPv4-compatible (::/96)
      const isIPv4Compatible = words[0] === 0 && words[1] === 0 && words[2] === 0 && words[3] === 0 && words[4] === 0 && words[5] === 0;
      // NAT64 Well-Known Prefix (64:ff9b::/96) or local (64:ff9b:1::/48)
      const isNAT64 = words[0] === 0x0064 && words[1] === 0xff9b && words[3] === 0 && words[4] === 0 && words[5] === 0 && (words[2] === 0 || words[2] === 1);

      if (isIPv4Mapped || isIPv4Compatible || isNAT64) {
        const ipv4 = `${words[6] >> 8}.${words[6] & 0xff}.${words[7] >> 8}.${words[7] & 0xff}`;
        return isPrivateIPv4(ipv4);
      }
    }
    if (a.startsWith('::ffff:')) return isPrivateIPv4(a.slice(7));
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(a);
  }
  return true;
}

function guardedLookup(hostname, options, callback) {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err);
    const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: options.family || 4 }];
    const blocked = list.find((entry) => isPrivateAddress(entry.address));
    if (blocked) {
      const error = new Error(`Destination ${hostname} resolves to a disallowed address.`);
      error.code = 'EDISALLOWED';
      return callback(error);
    }
    if (options.all) return callback(null, list);
    return callback(null, list[0].address, list[0].family);
  });
}

const safeHttpAgent = new http.Agent({ lookup: guardedLookup, keepAlive: true });
const safeHttpsAgent = new https.Agent({ lookup: guardedLookup, keepAlive: true });

/** Returns true when the literal host in the URL is an IP in a blocked range. */
function isLiteralPrivateHost(url) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  return net.isIP(host) !== 0 && isPrivateAddress(host);
}

function isDisallowedError(err) {
  const seen = new Set();
  while (err && !seen.has(err)) {
    if (err.code === 'EDISALLOWED') return true;
    seen.add(err);
    err = err.cause;
  }
  return false;
}

module.exports = { safeHttpAgent, safeHttpsAgent, isPrivateAddress, isLiteralPrivateHost, isDisallowedError };
