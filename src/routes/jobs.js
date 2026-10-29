'use strict';

/**
 * Jobs (asynchronous generation tasks).
 *
 *   GET  /v1/jobs               List jobs (filter by status / type)
 *   GET  /v1/jobs/:id           Retrieve a job (poll for status & progress)
 *   POST /v1/jobs/:id/cancel    Cancel a queued or running job
 *   GET  /v1/jobs/:id/content   Download the generated media
 */

const express = require('express');
const { Job, JOB_STATUSES, JOB_TYPES } = require('../models');
const storage = require('../services/storage');
const { dispatcher } = require('../services/dispatcher');
const { requireScope } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const { methodNotAllowed } = require('../middleware/errorHandler');
const { serializeJob, list } = require('../serializers');
const { z, listQuerySchema, idParamSchema, paginate, requestUrl } = require('./helpers');
const { ApiError, ErrorCodes } = require('../errors');

const router = express.Router();
router.use(requireScope('images', 'videos'));

const listJobsQuery = listQuerySchema.extend({
  status: z.enum(JOB_STATUSES).optional(),
  type: z.enum(JOB_TYPES).optional()
});

async function loadJob(req) {
  const job = await Job.findOne({ _id: req.params.id, api_key_id: req.auth.apiKey._id }).lean();
  if (!job) throw new ApiError(ErrorCodes.RESOURCE_NOT_FOUND, { message: `No such job: '${req.params.id}'.`, param: 'id' });
  return job;
}

router
  .route('/')
  .get(validate(listJobsQuery, 'query'), async (req, res) => {
    const { limit, cursor, status, type } = req.valid.query;
    const filter = { api_key_id: req.auth.apiKey._id };
    if (status) filter.status = status;
    if (type) filter.type = type;
    const { docs, hasMore } = await paginate(Job, filter, { limit, cursor });
    res.json(list(docs.map(serializeJob), { hasMore, url: requestUrl(req) }));
  })
  .all(methodNotAllowed(['GET']));

router
  .route('/:id')
  .get(validate(idParamSchema, 'params'), async (req, res) => {
    const job = await loadJob(req);
    if (job.status === 'queued' || job.status === 'running') res.setHeader('Retry-After', job.type === 'video' ? '10' : '3');
    res.json(serializeJob(job));
  })
  .all(methodNotAllowed(['GET']));

router
  .route('/:id/cancel')
  .post(validate(idParamSchema, 'params'), async (req, res) => {
    const job = await dispatcher.cancel(req.params.id, req.auth.apiKey._id);
    res.json(serializeJob(job));
  })
  .all(methodNotAllowed(['POST']));

router
  .route('/:id/content')
  .get(validate(idParamSchema, 'params'), async (req, res) => {
    const job = await loadJob(req);
    if (job.status !== 'succeeded' || !job.output?.file_id) {
      throw new ApiError(ErrorCodes.JOB_NOT_COMPLETED, { message: `Job '${job._id}' is ${job.status}; content is only available for succeeded jobs.` });
    }
    const file = await storage.getFileOrThrow(job.output.file_id, { param: 'id' });
    await storage.sendStoredFile(res, file, { download: req.query.download === '1' || req.query.download === 'true' });
  })
  .all(methodNotAllowed(['GET']));

module.exports = router;
