'use strict';

/**
 * Buffered API key usage counters.
 *
 * Incrementing a counter document on every request would turn each API call
 * into an extra database write. Instead, increments are aggregated in memory
 * and flushed periodically with a single unordered bulkWrite.
 */

const { logger } = require('../logger');
const { ApiKey } = require('../models');

const log = logger.child({ component: 'usage' });
const FLUSH_INTERVAL_MS = 5000;

/** apiKeyId -> { inc: { field: n }, lastUsedAt: Date } */
let buffer = new Map();
let timer = null;

/**
 * Records usage for an API key.
 * @param {string} apiKeyId
 * @param {'requests'|'chat_completions'|'images'|'videos'} field
 * @param {number} [amount]
 */
function track(apiKeyId, field, amount = 1) {
  if (!apiKeyId) return;
  let entry = buffer.get(apiKeyId);
  if (!entry) {
    entry = { inc: {}, lastUsedAt: null };
    buffer.set(apiKeyId, entry);
  }
  entry.inc[field] = (entry.inc[field] || 0) + amount;
  if (field === 'requests') entry.lastUsedAt = new Date();
}

async function flush() {
  if (buffer.size === 0) return;
  const snapshot = buffer;
  buffer = new Map();
  const ops = [];
  for (const [apiKeyId, entry] of snapshot) {
    const $inc = {};
    for (const [field, n] of Object.entries(entry.inc)) $inc[`usage.${field}`] = n;
    const update = { $inc };
    if (entry.lastUsedAt) update.$max = { last_used_at: entry.lastUsedAt };
    ops.push({ updateOne: { filter: { _id: apiKeyId }, update } });
  }
  try {
    await ApiKey.bulkWrite(ops, { ordered: false });
  } catch (err) {
    log.warn({ err: err.message, keys: ops.length }, 'Failed to flush usage counters');
  }
}

function startUsageFlusher() {
  if (timer) return;
  timer = setInterval(() => flush().catch(() => {}), FLUSH_INTERVAL_MS);
  timer.unref?.();
}

async function stopUsageFlusher() {
  if (timer) clearInterval(timer);
  timer = null;
  await flush();
}

module.exports = { track, flush, startUsageFlusher, stopUsageFlusher };
