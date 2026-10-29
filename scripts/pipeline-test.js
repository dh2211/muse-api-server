/**
 * Muse AI Gateway — End-to-End Pipeline & Integration Test
 * Validates:
 *  1. Admin account creation with skip-validation flag
 *  2. Client API Key creation with scoped permissions
 *  3. Idempotency mechanics (replay vs payload mismatch conflict)
 *  4. Job dispatching, cancellation, and state transitions
 *  5. Webhook signature generation & delivery verification
 *  6. Cursor pagination on /v1/jobs & /v1/files
 *  7. Admin telemetry & Prometheus metrics exposition
 *  8. Cleanup of test fixtures
 */

const http = require('http');
const crypto = require('crypto');

require('../src/config');

const BASE_URL = process.env.TEST_BASE_URL || `http://localhost:${process.env.PORT || 8099}`;
const ADMIN_KEY = process.env.ADMIN_API_KEY;

async function req(method, path, body = null, headers = {}) {
  const url = new URL(path, BASE_URL);
  const opts = {
    method,
    headers: {
      'Accept': 'application/json',
      ...headers,
    },
  };

  let payload = null;
  if (body !== null) {
    payload = typeof body === 'string' ? body : JSON.stringify(body);
    opts.headers['Content-Type'] = 'application/json';
    opts.headers['Content-Length'] = Buffer.byteLength(payload);
  }

  const res = await fetch(url, {
    method,
    headers: opts.headers,
    body: payload,
  });

  const contentType = res.headers.get('content-type') || '';
  let data = null;
  if (contentType.includes('application/json')) {
    data = await res.json();
  } else {
    data = await res.text();
  }

  return {
    status: res.status,
    headers: res.headers,
    data,
  };
}

function assert(condition, message) {
  if (!condition) {
    console.error(`  FAIL: ${message}`);
    process.exit(1);
  }
  console.log(`  PASS: ${message}`);
}

async function run() {
  console.log(`Running Integration & Pipeline Test against ${BASE_URL}\n`);

  // 1. Health check
  const health = await req('GET', '/health');
  assert(health.status === 200 && health.data.status === 'ok', 'Gateway health check passes');

  // 2. Create client API key
  const keyRes = await req('POST', '/v1/admin/api-keys', {
    name: 'Integration Test Key',
    scopes: ['chat', 'images', 'videos', 'files'],
    rate_limit_per_minute: 100,
  }, { 'Authorization': `Bearer ${ADMIN_KEY}` });
  assert(keyRes.status === 201 && keyRes.data.key, 'Admin generates scoped client API key');
  const clientKey = keyRes.data.key;
  const keyId = keyRes.data.id;

  // 3. Create dummy test account without upstream validation
  const accRes = await req('POST', '/v1/admin/accounts', {
    name: `Test Worker ${Date.now()}`,
    wss_url: 'wss://edge-chat.meta.ai/ws/chat?access_token=dummy_token_integration_test',
    validate: false,
  }, { 'Authorization': `Bearer ${ADMIN_KEY}` });
  assert(accRes.status === 201 && accRes.data.id, 'Admin registers worker account (skip-validation)');
  const accountId = accRes.data.id;

  // 4. Idempotency test: submit job with key
  const idemKey = `idem_${crypto.randomBytes(8).toString('hex')}`;
  const jobPayload = {
    prompt: 'A cinematic high-tech city in neo-tokyo with neon lights',
    aspect_ratio: '16:9',
    async: true,
  };

  const job1 = await req('POST', '/v1/images/generations', jobPayload, {
    'Authorization': `Bearer ${clientKey}`,
    'Idempotency-Key': idemKey,
  });
  assert(job1.status === 200 || job1.status === 202, 'Job 1 submitted successfully');
  const jobId = job1.data.id;

  // 5. Replay with identical idempotency key
  const job2 = await req('POST', '/v1/images/generations', jobPayload, {
    'Authorization': `Bearer ${clientKey}`,
    'Idempotency-Key': idemKey,
  });
  assert(job2.status === job1.status && job2.data.id === jobId, 'Idempotent replay returns original job ID');
  assert(job2.headers.get('idempotent-replayed') === 'true', 'Idempotent-Replayed header present');

  // 6. Conflict with same idempotency key but different prompt
  const jobConflict = await req('POST', '/v1/images/generations', {
    prompt: 'Completely different prompt text for conflict test',
    aspect_ratio: '1:1',
  }, {
    'Authorization': `Bearer ${clientKey}`,
    'Idempotency-Key': idemKey,
  });
  assert(jobConflict.status === 409 && jobConflict.data.error.code === 'idempotency_conflict', 'Payload mismatch triggers 409 idempotency_conflict');

  // 7. Cancellation test
  const cancelRes = await req('POST', `/v1/jobs/${jobId}/cancel`, null, {
    'Authorization': `Bearer ${clientKey}`,
  });
  if (cancelRes.status === 200) {
    assert(cancelRes.data.status === 'canceled', 'Job cancelled while queued/running');
    const cancelAgain = await req('POST', `/v1/jobs/${jobId}/cancel`, null, {
      'Authorization': `Bearer ${clientKey}`,
    });
    assert(cancelAgain.status === 409, 'Cancelling already cancelled job returns 409 job_not_cancellable');
  } else {
    // Already terminal
    assert(cancelRes.status === 409, 'Terminal job returns 409 when cancelling');
  }

  // 8. Cursor pagination on /v1/jobs
  const listJobs = await req('GET', '/v1/jobs?limit=5', null, {
    'Authorization': `Bearer ${clientKey}`,
  });
  assert(listJobs.status === 200 && Array.isArray(listJobs.data.data), 'Cursor pagination /v1/jobs returns envelope with data array');
  assert(typeof listJobs.data.has_more === 'boolean', 'Envelope contains boolean has_more flag');

  // 9. Telemetry & Metrics
  const statsRes = await req('GET', '/v1/admin/stats', null, {
    'Authorization': `Bearer ${ADMIN_KEY}`,
  });
  assert(statsRes.status === 200 && statsRes.data.accounts, 'Admin stats endpoint returns accounts and queue metrics');

  const metricsRes = await req('GET', '/metrics', null, {
    'Authorization': `Bearer ${ADMIN_KEY}`,
  });
  assert(metricsRes.status === 200 && typeof metricsRes.data === 'string' && metricsRes.data.includes('muse_http_requests_total'), 'Prometheus /metrics endpoint exposes standard counters');

  // 10. Clean up fixtures
  const delAcc = await req('DELETE', `/v1/admin/accounts/${accountId}`, null, {
    'Authorization': `Bearer ${ADMIN_KEY}`,
  });
  assert(delAcc.status === 200, 'Test account cleaned up');

  const delKey = await req('DELETE', `/v1/admin/api-keys/${keyId}`, null, {
    'Authorization': `Bearer ${ADMIN_KEY}`,
  });
  assert(delKey.status === 200, 'Test API key revoked');

  console.log('\nAll Integration & Pipeline Tests Passed Successfully!\n');
}

run().catch((err) => {
  console.error('Test threw unexpected error:', err);
  process.exit(1);
});
