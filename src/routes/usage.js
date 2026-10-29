'use strict';

/**
 * Usage & limits for the calling API key.
 *
 *   GET /v1/usage
 *
 * Counters are aggregated in memory and flushed every few seconds, so very
 * recent requests may take up to ~5 seconds to appear.
 */

const express = require('express');
const config = require('../config');
const { ApiKey, Job } = require('../models');
const { methodNotAllowed } = require('../middleware/errorHandler');

const router = express.Router();

router
  .route('/')
  .get(async (req, res) => {
    const key = req.auth.apiKey;
    const [fresh, queued, running] = await Promise.all([
      key.isMaster ? null : ApiKey.findById(key._id).lean(),
      Job.countDocuments({ api_key_id: key._id, status: 'queued' }),
      Job.countDocuments({ api_key_id: key._id, status: 'running' })
    ]);
    const doc = fresh || key;
    res.json({
      object: 'usage',
      api_key: { id: doc._id, name: doc.name, scopes: doc.scopes },
      limits: {
        rate_limit_per_minute: doc.rate_limit_per_minute || config.rateLimit.defaultPerMinute,
        max_concurrent_jobs: doc.max_concurrent_jobs || config.rateLimit.defaultMaxConcurrentJobs
      },
      usage: {
        requests: doc.usage?.requests || 0,
        chat_completions: doc.usage?.chat_completions || 0,
        images: doc.usage?.images || 0,
        videos: doc.usage?.videos || 0
      },
      active_jobs: { queued, running },
      last_used_at: doc.last_used_at ? new Date(doc.last_used_at).toISOString() : null
    });
  })
  .all(methodNotAllowed(['GET']));

module.exports = router;
