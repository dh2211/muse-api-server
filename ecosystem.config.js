/**
 * PM2 process definition (bare-metal / VPS deployments).
 *
 *   pm2 start ecosystem.config.js
 *   pm2 save && pm2 startup
 *
 * A single fork-mode instance per ACCOUNT_GROUP is intentional: each process
 * owns persistent upstream WebSocket connections and in-memory capacity slots
 * for its accounts. Scale horizontally by running additional instances with a
 * different ACCOUNT_GROUP (and NODE_ID) behind the load balancer; all
 * instances share the same MongoDB.
 */
module.exports = {
  apps: [
    {
      name: 'muse-api',
      script: 'src/server.js',
      exec_mode: 'fork',
      instances: 1,
      env: {
        NODE_ENV: 'production'
      },
      // Allow in-flight jobs to drain (SHUTDOWN_GRACE_MS + margin).
      kill_timeout: 45000,
      listen_timeout: 30000,
      max_memory_restart: '1536M',
      node_args: '--max-old-space-size=1536',
      exp_backoff_restart_delay: 200,
      time: true,
      merge_logs: true
    }
  ]
};
