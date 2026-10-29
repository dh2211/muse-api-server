'use strict';

/**
 * Health endpoints (unauthenticated, intended for load balancers and
 * orchestrators).
 *
 *   GET /health        Liveness: the process is up and serving HTTP.
 *   GET /health/ready  Readiness: database reachable and node accepting work.
 */

const express = require('express');
const { isDatabaseReady } = require('../db');
const { pool } = require('../services/pool');
const { dispatcher } = require('../services/dispatcher');
const pkg = require('../../package.json');

const router = express.Router();
const startedAt = Date.now();

router.get('/', (req, res) => {
  res.json({ status: 'ok', version: pkg.version, uptime_seconds: Math.round((Date.now() - startedAt) / 1000) });
});

router.get('/ready', (req, res) => {
  const database = isDatabaseReady();
  const stopping = dispatcher.stopping;
  const snap = pool.snapshot();
  const accounts = Object.values(snap.accounts);
  const ready = database && !stopping;
  res.status(ready ? 200 : 503).json({
    status: ready ? 'ready' : 'not_ready',
    checks: {
      database: database ? 'ok' : 'unavailable',
      shutting_down: stopping,
      accounts: {
        total: accounts.length,
        online: accounts.filter((a) => a.status === 'online').length,
        expired: accounts.filter((a) => a.status === 'expired').length
      },
      available_slots: snap.available_slots
    }
  });
});

module.exports = router;
