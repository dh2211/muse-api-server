'use strict';

const { generateId } = require('../utils/crypto');

const VALID_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * Assigns every request a correlation ID. A well-formed inbound X-Request-Id
 * (e.g. from a load balancer) is honored; otherwise a new one is generated.
 * The ID is echoed in the response header and in every error body.
 */
function requestId(req, res, next) {
  const inbound = req.get('x-request-id');
  req.id = inbound && VALID_ID.test(inbound) ? inbound : generateId('req');
  res.setHeader('X-Request-Id', req.id);
  next();
}

module.exports = { requestId };
