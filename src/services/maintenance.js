'use strict';

/**
 * Background housekeeping:
 *  - Deletes expired files (metadata + bytes on disk) in small batches.
 *  - Removes stale temporary upload fragments.
 */

const fsp = require('fs/promises');
const path = require('path');
const config = require('../config');
const { logger } = require('../logger');
const { File } = require('../models');
const storage = require('./storage');

const log = logger.child({ component: 'maintenance' });

const INTERVAL_MS = 10 * 60 * 1000;
const BATCH_SIZE = 500;
const TMP_MAX_AGE_MS = 60 * 60 * 1000;

let timer = null;
let running = false;

async function purgeExpiredFiles() {
  let total = 0;
  for (;;) {
    const batch = await File.find({ expires_at: { $lte: new Date() } }).select('+path').limit(BATCH_SIZE).lean();
    if (batch.length === 0) break;
    for (const doc of batch) {
      await storage.deleteFile(doc).catch((err) => log.warn({ file: doc._id, err: err.message }, 'Failed to delete expired file'));
    }
    total += batch.length;
    if (batch.length < BATCH_SIZE) break;
  }
  if (total) log.info({ files: total }, 'Purged expired files');
}

async function purgeTempFiles() {
  const dir = path.join(config.storage.dir, 'tmp');
  const entries = await fsp.readdir(dir).catch(() => []);
  const cutoff = Date.now() - TMP_MAX_AGE_MS;
  for (const name of entries) {
    const full = path.join(dir, name);
    const stat = await fsp.stat(full).catch(() => null);
    if (stat && stat.mtimeMs < cutoff) await fsp.unlink(full).catch(() => {});
  }
}

async function runMaintenance() {
  if (running) return;
  running = true;
  try {
    await purgeExpiredFiles();
    await purgeTempFiles();
  } catch (err) {
    log.warn({ err: err.message }, 'Maintenance cycle failed');
  } finally {
    running = false;
  }
}

function startMaintenance() {
  if (timer) return;
  const first = setTimeout(runMaintenance, 30000);
  first.unref?.();
  timer = setInterval(runMaintenance, INTERVAL_MS);
  timer.unref?.();
}

function stopMaintenance() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { startMaintenance, stopMaintenance, runMaintenance };
