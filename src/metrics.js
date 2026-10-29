'use strict';

/**
 * Minimal Prometheus metrics (text exposition format 0.0.4) without external
 * dependencies. Exposed at GET /metrics, protected by METRICS_TOKEN (Bearer)
 * or the admin API key.
 */

const { pool } = require('./services/pool');

const startedAt = Date.now();

// method|route|status -> count ; route -> histogram buckets
const requestCounts = new Map();
const BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300];
const durations = new Map();

function escapeLabel(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

const MAX_ROUTE_LABELS = 500;

function routeLabel(req, status) {
  if (req.route) {
    const subPath = Array.isArray(req.route.path) ? req.route.path[0] : req.route.path;
    const combined = `${req.baseUrl || ''}${subPath === '/' && req.baseUrl ? '' : subPath}`;
    return (combined || '/').slice(0, 100);
  }
  if (!req.route && (status === 404 || status === 401 || status === 403 || status === 405 || status === 429)) {
    return 'unmatched';
  }
  const pathOnly = (req.originalUrl || req.url || '').split('?')[0];
  // Collapse resource IDs (e.g. job_abc123...) to keep label cardinality low.
  return pathOnly.replace(/\/[a-z]+_[A-Za-z0-9_-]{6,}/g, '/:id').slice(0, 100) || '/';
}

/** Express middleware that records request counts and latency per route. */
function metricsMiddleware(req, res, next) {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    let route = routeLabel(req, res.statusCode);
    if (!durations.has(route) && durations.size >= MAX_ROUTE_LABELS) {
      route = 'other';
    }
    const key = `${req.method}|${route}|${res.statusCode}`;
    if (requestCounts.has(key) || requestCounts.size < MAX_ROUTE_LABELS * 5) {
      requestCounts.set(key, (requestCounts.get(key) || 0) + 1);
    }

    const seconds = Number(process.hrtime.bigint() - start) / 1e9;
    let hist = durations.get(route);
    if (!hist) {
      hist = { buckets: new Array(BUCKETS.length).fill(0), sum: 0, count: 0 };
      durations.set(route, hist);
    }
    BUCKETS.forEach((b, i) => {
      if (seconds <= b) hist.buckets[i] += 1;
    });
    hist.sum += seconds;
    hist.count += 1;
  });
  next();
}

function render({ dispatcherStats }) {
  const lines = [];
  const push = (name, help, type, samples) => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    for (const [labels, value] of samples) lines.push(`${name}${labels} ${value}`);
  };

  push('muse_process_uptime_seconds', 'Process uptime in seconds.', 'gauge', [['', Math.round((Date.now() - startedAt) / 1000)]]);
  const mem = process.memoryUsage();
  push('muse_process_resident_memory_bytes', 'Resident memory size in bytes.', 'gauge', [['', mem.rss]]);
  push('muse_process_heap_used_bytes', 'V8 heap used in bytes.', 'gauge', [['', mem.heapUsed]]);

  push('muse_http_requests_total', 'Total HTTP requests by method, route and status.', 'counter',
    [...requestCounts].map(([key, value]) => {
      const [method, route, status] = key.split('|');
      return [`{method="${method}",route="${escapeLabel(route)}",status="${status}"}`, value];
    }));

  lines.push('# HELP muse_http_request_duration_seconds HTTP request latency.', '# TYPE muse_http_request_duration_seconds histogram');
  for (const [route, hist] of durations) {
    const r = escapeLabel(route);
    BUCKETS.forEach((b, i) => lines.push(`muse_http_request_duration_seconds_bucket{route="${r}",le="${b}"} ${hist.buckets[i]}`));
    lines.push(`muse_http_request_duration_seconds_bucket{route="${r}",le="+Inf"} ${hist.count}`);
    lines.push(`muse_http_request_duration_seconds_sum{route="${r}"} ${hist.sum.toFixed(6)}`);
    lines.push(`muse_http_request_duration_seconds_count{route="${r}"} ${hist.count}`);
  }

  const snap = pool.snapshot();
  const statusCounts = {};
  const activeSamples = [];
  for (const [id, acct] of Object.entries(snap.accounts)) {
    statusCounts[acct.status] = (statusCounts[acct.status] || 0) + 1;
    for (const cap of ['chat', 'image', 'video']) activeSamples.push([`{account="${id}",capability="${cap}"}`, acct.active[cap]]);
  }
  push('muse_accounts', 'Upstream accounts loaded on this node by status.', 'gauge', Object.entries(statusCounts).map(([s, n]) => [`{status="${s}"}`, n]));
  push('muse_account_active_requests', 'In-flight upstream requests per account and capability.', 'gauge', activeSamples);
  push('muse_pool_available_slots', 'Free upstream slots by capability.', 'gauge', Object.entries(snap.available_slots).map(([c, n]) => [`{capability="${c}"}`, n]));
  push('muse_pool_waiting_requests', 'Requests waiting for an upstream slot by capability.', 'gauge', Object.entries(snap.waiting).map(([c, n]) => [`{capability="${c}"}`, n]));

  if (dispatcherStats) {
    push('muse_jobs_running', 'Jobs running on this node by type.', 'gauge', Object.entries(dispatcherStats.running).map(([t, n]) => [`{type="${t}"}`, n]));
    push('muse_jobs_pending_global', 'Queued + running jobs across the cluster (cached).', 'gauge', [['', dispatcherStats.pending_global]]);
  }

  return `${lines.join('\n')}\n`;
}

module.exports = { metricsMiddleware, render };
